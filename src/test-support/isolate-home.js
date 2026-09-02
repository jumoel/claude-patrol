/**
 * Test preload: point every home-relative path at a throwaway directory.
 *
 * Loaded by `node --test --import` (see package.json test:backend), so it runs
 * before any module under test. Several modules resolve `~` or the XDG
 * directories at call time (paths.js, provider-trust.js, workspace.js's
 * Claude project cleanup, jj's own config). Without this, importing config.js
 * creates ~/.config/claude-patrol on the developer machine and a workspace
 * destroy test issues `rm -rf` against a path under the real home.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'patrol-test-home-'));

process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, '.config');
process.env.XDG_DATA_HOME = join(home, '.local', 'share');
process.env.XDG_STATE_HOME = join(home, '.local', 'state');

// Tests run real jj against fixtures. With the user's config out of reach jj
// needs an identity from the environment or it commits with an empty author.
process.env.JJ_USER = 'Patrol Tests';
process.env.JJ_EMAIL = 'tests@patrol.invalid';

process.on('exit', () => {
  rmSync(home, { recursive: true, force: true });
});
