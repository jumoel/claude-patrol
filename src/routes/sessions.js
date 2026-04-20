import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { emitLocalChange } from '../app-events.js';
import { getCurrentConfig } from '../config.js';
import { getDb } from '../db.js';
import {
  attachSession,
  createResumedSession,
  createSession,
  killSession,
  popOutSession,
  reattachSession,
} from '../pty-manager.js';
import { findSessionJsonl, getOrCreateTranscriptSummary, parseTranscript, claudeProjectDirForWorkspace } from '../transcripts.js';
import { execFile, expandPath, toClaudeProjectKey } from '../utils.js';
import { createScratchWorkspace } from '../workspace.js';

/**
 * Register session routes.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerSessionRoutes(app) {
  app.post('/api/sessions', (request, reply) => {
    const { workspace_id, global: isGlobal } = request.body || {};
    const db = getDb();

    let cwd;
    if (isGlobal) {
      cwd = getCurrentConfig().global_terminal_cwd || process.cwd();
    } else if (workspace_id) {
      const workspace = db.prepare("SELECT * FROM workspaces WHERE id = ? AND status = 'active'").get(workspace_id);
      if (!workspace) {
        return reply.code(404).send({ error: 'Workspace not found or not active' });
      }
      cwd = workspace.path;
    } else {
      return reply.code(400).send({ error: 'workspace_id or global: true is required' });
    }

    try {
      const session = createSession(isGlobal ? null : workspace_id, cwd);
      emitLocalChange();
      return reply.code(201).send({
        ...session,
        ws_url: `ws://${request.hostname}/ws/sessions/${session.id}`,
      });
    } catch (err) {
      return reply.code(500).send({ error: `Failed to create session: ${err.message}` });
    }
  });

  app.get('/api/sessions', (request) => {
    const db = getDb();
    const { workspace_id } = request.query;
    if (workspace_id) {
      return db
        .prepare("SELECT * FROM sessions WHERE workspace_id = ? AND status IN ('active', 'detached')")
        .all(workspace_id);
    }
    return db.prepare("SELECT * FROM sessions WHERE status IN ('active', 'detached')").all();
  });

  app.delete('/api/sessions/:id', (request) => {
    killSession(request.params.id);
    emitLocalChange();
    return { ok: true };
  });

  app.post('/api/sessions/:id/popout', (request, reply) => {
    try {
      popOutSession(request.params.id);
      emitLocalChange();
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post('/api/sessions/:id/reattach', (request, reply) => {
    try {
      const session = reattachSession(request.params.id);
      emitLocalChange();
      return session;
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Session history (all sessions - active and killed)
  app.get('/api/sessions/history', (request) => {
    const db = getDb();
    const { workspace_id } = request.query;
    if (workspace_id) {
      return db
        .prepare('SELECT * FROM sessions WHERE workspace_id = ? ORDER BY started_at DESC')
        .all(workspace_id);
    }
    return db.prepare('SELECT * FROM sessions WHERE status = \'killed\' ORDER BY started_at DESC LIMIT 100').all();
  });

  // Session transcript
  app.get('/api/sessions/:id/transcript', (request, reply) => {
    const db = getDb();
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }

    // Derive claude_project_dir from workspace path if not stored (pre-migration sessions)
    let claudeProjectDir = session.claude_project_dir;
    if (!claudeProjectDir && session.workspace_id) {
      const ws = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(session.workspace_id);
      if (ws) {
        claudeProjectDir = claudeProjectDirForWorkspace(ws.path);
      }
    }

    let jsonlPath = null;

    // Prefer our archived copy
    if (session.transcript_path && existsSync(session.transcript_path)) {
      jsonlPath = session.transcript_path;
    } else if (claudeProjectDir) {
      // Try to find the live JSONL
      jsonlPath = findSessionJsonl(claudeProjectDir, session.started_at, session.ended_at);
    }

    if (!jsonlPath) {
      return reply.code(404).send({ error: 'No transcript available' });
    }

    if (request.query.path_only) {
      if (request.query.summary) {
        const summaryPath = getOrCreateTranscriptSummary(jsonlPath);
        return { summary_path: summaryPath || jsonlPath, transcript_path: jsonlPath };
      }
      return { path: jsonlPath };
    }

    try {
      return parseTranscript(jsonlPath);
    } catch (err) {
      return reply.code(500).send({ error: `Failed to read transcript: ${err.message}` });
    }
  });

  // Promote a global session to a scratch workspace
  app.post('/api/sessions/:id/promote', async (request, reply) => {
    const { repo, branch } = request.body || {};
    if (!repo || !branch) {
      return reply.code(400).send({ error: 'repo and branch are required' });
    }

    const db = getDb();
    const session = db.prepare("SELECT * FROM sessions WHERE id = ? AND status = 'active'").get(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found or not active' });
    }
    if (session.workspace_id) {
      return reply.code(400).send({ error: 'Session is already in a workspace' });
    }

    const config = getCurrentConfig();
    const [org, repoName] = repo.split('/');
    const mainRepoPath = resolve(expandPath(config.work_dir), org, repoName);

    try {
      // 1. Create scratch workspace starting from default@- (parent of main working copy)
      const workspace = await createScratchWorkspace(repo, branch, config, { startRevision: 'default@-' });

      // 2. Migrate changes via jj squash (non-fatal if empty)
      try {
        await execFile('jj', ['squash', '--from', 'default@', '--into', `${workspace.name}@`, '-R', mainRepoPath]);
      } catch (err) {
        console.warn(`[promote] jj squash non-fatal: ${err.message}`);
      }

      // 3. Copy Claude session files to new workspace's project dir
      let claudeSessionUuid = null;
      if (session.claude_project_dir) {
        const jsonlPath = findSessionJsonl(session.claude_project_dir, session.started_at, null);
        if (jsonlPath) {
          claudeSessionUuid = basename(jsonlPath, '.jsonl');
          const targetProjectDir = resolve(expandPath('~/.claude/projects'), toClaudeProjectKey(workspace.path));
          mkdirSync(targetProjectDir, { recursive: true });

          // Copy the .jsonl file
          copyFileSync(jsonlPath, resolve(targetProjectDir, basename(jsonlPath)));

          // Copy the session directory (contains tool results, images, etc.) if it exists
          const sessionDir = resolve(session.claude_project_dir, claudeSessionUuid);
          const targetSessionDir = resolve(targetProjectDir, claudeSessionUuid);
          if (existsSync(sessionDir)) {
            cpSync(sessionDir, targetSessionDir, { recursive: true });
          }
        }
      }

      // 4. Kill the old global session
      killSession(session.id);

      // 5. Create new session in workspace with --resume
      let newSession;
      if (claudeSessionUuid) {
        newSession = createResumedSession(workspace.id, workspace.path, claudeSessionUuid);
      } else {
        newSession = createSession(workspace.id, workspace.path);
      }

      emitLocalChange();
      return reply.code(201).send({ workspace, session: newSession });
    } catch (err) {
      return reply.code(500).send({ error: `Promote failed: ${err.message}` });
    }
  });

  // WebSocket route for terminal attachment
  app.get('/ws/sessions/:id', { websocket: true }, (socket, request) => {
    attachSession(request.params.id, socket);
  });
}
