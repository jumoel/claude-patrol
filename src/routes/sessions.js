import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
import { findSessionJsonl } from '../transcripts.js';
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

  // Session history (killed sessions)
  app.get('/api/sessions/history', (request) => {
    const db = getDb();
    const { workspace_id } = request.query;
    if (workspace_id) {
      return db
        .prepare("SELECT * FROM sessions WHERE workspace_id = ? AND status = 'killed' ORDER BY started_at DESC")
        .all(workspace_id);
    }
    return db.prepare("SELECT * FROM sessions WHERE status = 'killed' ORDER BY started_at DESC LIMIT 100").all();
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
        claudeProjectDir = resolve(expandPath('~/.claude/projects'), toClaudeProjectKey(ws.path));
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
      return { path: jsonlPath };
    }

    try {
      const raw = readFileSync(jsonlPath, 'utf8');
      const parsed = raw
        .trim()
        .split('\n')
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .filter((e) => e.type === 'user' || e.type === 'assistant');

      // Tag each entry with whether it's a genuine human message.
      // System-injected user messages include: tool results, skill expansions
      // (follow a tool_result), and task/system notifications (contain XML tags).
      const SYSTEM_PATTERNS = [
        '<task-notification>',
        '<system-reminder>',
        '<command-name>',
        '<automated-',
        'IMPORTANT: After completing',
        'Read the output file to retrieve the result:',
      ];

      let prevWasAssistant = true; // treat start of conversation as "after assistant"
      const entries = parsed.map((e) => {
        const content = simplifyContent(e.message?.content);
        const role = e.message?.role || e.type;
        const hasText = content.some((b) => b.type === 'text');

        let isHuman = false;
        if (role === 'user' && hasText) {
          // Human messages directly follow an assistant message.
          // Consecutive user messages are system injections (tool results,
          // skill expansions, task notifications).
          const textContent = content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('');
          const looksLikeSystem = SYSTEM_PATTERNS.some((p) => textContent.includes(p));
          isHuman = prevWasAssistant && !looksLikeSystem;
        }

        prevWasAssistant = role === 'assistant';

        return {
          timestamp: e.timestamp,
          role,
          content,
          model: e.message?.model || null,
          isHuman,
        };
      });

      return entries;
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

/**
 * Simplify Claude message content blocks for the transcript API.
 * @param {Array | string | undefined} content
 * @returns {Array}
 */
function simplifyContent(content) {
  if (!content) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];

  return content.map((block) => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text };
    }
    if (block.type === 'tool_use') {
      const inputStr = typeof block.input === 'string' ? block.input : JSON.stringify(block.input);
      return {
        type: 'tool_use',
        name: block.name,
        input_summary: inputStr.length > 200 ? `${inputStr.slice(0, 200)}...` : inputStr,
      };
    }
    if (block.type === 'tool_result') {
      const outputStr = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      return {
        type: 'tool_result',
        name: block.name || null,
        output_summary: outputStr.length > 200 ? `${outputStr.slice(0, 200)}...` : outputStr,
      };
    }
    if (block.type === 'thinking') {
      return { type: 'thinking', text: block.thinking || block.text || '' };
    }
    // Pass through unknown types minimally
    return { type: block.type };
  });
}
