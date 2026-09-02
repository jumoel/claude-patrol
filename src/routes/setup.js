import { sendError } from '../http-errors.js';
import { execFile } from '../utils.js';

/**
 * Register setup routes for GitHub account/repo discovery.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerSetupRoutes(app) {
  const { getConfig } = app.appContext;
  // List repositories available to either workspace creation path. Local
  // repository configuration remains useful when GitHub polling is disabled.
  app.get('/api/repos', async (_request, reply) => {
    const cfg = getConfig();
    const orgs = cfg?.poll?.orgs || [];
    const explicitRepos = cfg?.poll?.repos || [];
    const configuredRepos = Object.keys(cfg?.repos || {});
    const workItemRepos = cfg?.work_items?.repositories || [];

    try {
      // Fetch repos from all configured orgs in parallel
      const orgResults = await Promise.all(
        orgs.map(async (org) => {
          try {
            const { stdout } = await execFile('gh', [
              'repo',
              'list',
              org,
              '--limit',
              '200',
              '--json',
              'nameWithOwner,isArchived,isFork',
              '--jq',
              '[.[] | select(.isArchived == false) | .nameWithOwner]',
            ]);
            return JSON.parse(stdout.trim() || '[]');
          } catch {
            return [];
          }
        }),
      );

      const allRepos = new Set([...explicitRepos, ...configuredRepos, ...workItemRepos]);
      for (const repos of orgResults) {
        for (const r of repos) allRepos.add(r);
      }

      return { repos: [...allRepos].sort() };
    } catch (err) {
      return sendError(reply, 'upstream_failed', `Failed to list repos: ${err.message}`);
    }
  });
  // List the authenticated user's personal account and orgs
  app.get('/api/setup/accounts', async (_request, reply) => {
    try {
      const [userResult, orgsResult] = await Promise.all([
        execFile('gh', ['api', '/user', '--jq', '{login: .login, avatar_url: .avatar_url}']),
        execFile('gh', ['api', '/user/orgs', '--jq', '[.[] | {login: .login, avatar_url: .avatar_url}]']),
      ]);

      const user = JSON.parse(userResult.stdout.trim());
      const orgs = JSON.parse(orgsResult.stdout.trim() || '[]');

      return {
        accounts: [
          { login: user.login, type: 'user', avatar_url: user.avatar_url },
          ...orgs.map((o) => ({ login: o.login, type: 'org', avatar_url: o.avatar_url })),
        ],
      };
    } catch (err) {
      const unauthenticated = err.stderr?.includes('auth login');
      return sendError(
        reply,
        unauthenticated ? 'gh_unauthenticated' : 'upstream_failed',
        unauthenticated
          ? 'GitHub CLI is not authenticated. Run `gh auth login` in your terminal first.'
          : `Failed to list accounts: ${err.message}`,
        { status: unauthenticated ? 503 : 502 },
      );
    }
  });

  // List repos for a given account (user or org)
  app.get('/api/setup/repos', async (request, reply) => {
    const { account } = request.query;
    if (!account) {
      return sendError(reply, 'invalid_request', 'account query parameter is required');
    }

    try {
      const { stdout } = await execFile('gh', [
        'repo',
        'list',
        account,
        '--limit',
        '200',
        '--json',
        'name,nameWithOwner,isArchived,isFork,description',
        '--jq',
        '[.[] | select(.isArchived == false)]',
      ]);

      const repos = JSON.parse(stdout.trim() || '[]');
      return { repos };
    } catch (err) {
      return sendError(reply, 'upstream_failed', `Failed to list repos for ${account}: ${err.message}`);
    }
  });
}
