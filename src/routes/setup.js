import { execFile } from '../utils.js';

/**
 * Register setup routes for GitHub account/repo discovery.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerSetupRoutes(app) {
  // List the authenticated user's personal account and orgs
  app.get('/api/setup/accounts', async (request, reply) => {
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
          ...orgs.map(o => ({ login: o.login, type: 'org', avatar_url: o.avatar_url })),
        ],
      };
    } catch (err) {
      const msg = err.stderr?.includes('auth login')
        ? 'GitHub CLI is not authenticated. Run `gh auth login` in your terminal first.'
        : `Failed to list accounts: ${err.message}`;
      return reply.code(500).send({ error: msg });
    }
  });

  // List repos for a given account (user or org)
  app.get('/api/setup/repos', async (request, reply) => {
    const { account } = request.query;
    if (!account) {
      return reply.code(400).send({ error: 'account query parameter is required' });
    }

    try {
      const { stdout } = await execFile('gh', [
        'repo', 'list', account,
        '--limit', '200',
        '--json', 'name,nameWithOwner,isArchived,isFork,description',
        '--jq', '[.[] | select(.isArchived == false)]',
      ]);

      const repos = JSON.parse(stdout.trim() || '[]');
      return { repos };
    } catch (err) {
      return reply.code(500).send({ error: `Failed to list repos for ${account}: ${err.message}` });
    }
  });
}
