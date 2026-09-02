import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  claudeConfigPath,
  codexConfigPath,
  trustClaudeDirectory,
  trustCodexDirectory,
  trustSessionDirectory,
} from './provider-trust.js';

const roots = [];
function scratch() {
  const root = mkdtempSync(resolve(tmpdir(), 'patrol-trust-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('config paths', () => {
  it('follow the CLI home overrides', () => {
    assert.equal(claudeConfigPath({ CLAUDE_CONFIG_DIR: '/cfg/claude' }), '/cfg/claude/.claude.json');
    assert.equal(codexConfigPath({ CODEX_HOME: '/cfg/codex' }), '/cfg/codex/config.toml');
    assert.match(claudeConfigPath({}), /\/\.claude\.json$/);
    assert.match(codexConfigPath({}), /\/\.codex\/config\.toml$/);
  });
});

describe('trustClaudeDirectory', () => {
  it('creates the config with a fully populated project entry', () => {
    const root = scratch();
    const configPath = resolve(root, 'nested', '.claude.json');
    const cwd = resolve(root, 'ws');
    mkdirSync(cwd);

    const result = trustClaudeDirectory(cwd, { configPath });

    assert.equal(result.changed, true);
    assert.equal(result.path, realpathSync(cwd));
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(config.projects[realpathSync(cwd)], {
      allowedTools: [],
      mcpContextUris: [],
      mcpServers: {},
      enabledMcpjsonServers: [],
      disabledMcpjsonServers: [],
      hasTrustDialogAccepted: true,
      hasClaudeMdExternalIncludesApproved: false,
      hasClaudeMdExternalIncludesWarningShown: false,
    });
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
  });

  it('flips only the trust flag on an existing entry and keeps everything else', () => {
    const root = scratch();
    const configPath = resolve(root, '.claude.json');
    const cwd = resolve(root, 'ws');
    mkdirSync(cwd);
    const key = realpathSync(cwd);
    writeFileSync(
      configPath,
      JSON.stringify({
        numStartups: 7,
        projects: {
          [key]: { allowedTools: ['Bash'], hasTrustDialogAccepted: false, lastCost: 1.5 },
          '/elsewhere': { hasTrustDialogAccepted: false },
        },
      }),
    );

    assert.equal(trustClaudeDirectory(cwd, { configPath }).changed, true);

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(config.numStartups, 7);
    assert.deepEqual(config.projects[key], { allowedTools: ['Bash'], hasTrustDialogAccepted: true, lastCost: 1.5 });
    assert.deepEqual(config.projects['/elsewhere'], { hasTrustDialogAccepted: false });
    assert.equal(readFileSync(configPath, 'utf8').endsWith('}'), true);
  });

  it('leaves an already trusted config untouched', () => {
    const root = scratch();
    const configPath = resolve(root, '.claude.json');
    const cwd = resolve(root, 'ws');
    mkdirSync(cwd);
    const raw = JSON.stringify({ projects: { [realpathSync(cwd)]: { hasTrustDialogAccepted: true } } });
    writeFileSync(configPath, raw);

    assert.equal(trustClaudeDirectory(cwd, { configPath }).changed, false);
    assert.equal(readFileSync(configPath, 'utf8'), raw);
  });

  it('resolves symlinked working directories to the path the CLI will see', () => {
    const root = scratch();
    const configPath = resolve(root, '.claude.json');
    const real = resolve(root, 'real');
    const link = resolve(root, 'link');
    mkdirSync(real);
    symlinkSync(real, link);

    const result = trustClaudeDirectory(link, { configPath });

    assert.equal(result.path, realpathSync(real));
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(config.projects[realpathSync(real)].hasTrustDialogAccepted, true);
    assert.equal(config.projects[link], undefined);
  });

  it('refuses to overwrite a config it cannot parse', () => {
    const root = scratch();
    const configPath = resolve(root, '.claude.json');
    writeFileSync(configPath, '{ not json');

    assert.throws(() => trustClaudeDirectory(root, { configPath }), SyntaxError);
    assert.equal(readFileSync(configPath, 'utf8'), '{ not json');

    writeFileSync(configPath, JSON.stringify({ projects: [] }));
    assert.throws(() => trustClaudeDirectory(root, { configPath }), /non-object "projects"/);
    assert.equal(readFileSync(configPath, 'utf8'), JSON.stringify({ projects: [] }));
  });
});

describe('trustCodexDirectory', () => {
  it('creates the config with a trusted project table', () => {
    const root = scratch();
    const configPath = resolve(root, 'codex-home', 'config.toml');
    const cwd = resolve(root, 'ws');
    mkdirSync(cwd);

    const result = trustCodexDirectory(cwd, { configPath });

    assert.equal(result.changed, true);
    assert.equal(
      readFileSync(configPath, 'utf8'),
      `[projects.${JSON.stringify(realpathSync(cwd))}]\ntrust_level = "trusted"\n`,
    );
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
  });

  it('appends a table after existing content and preserves the file mode', () => {
    const root = scratch();
    const configPath = resolve(root, 'config.toml');
    const cwd = resolve(root, 'ws');
    mkdirSync(cwd);
    const existing = 'model = "gpt"\n\n[projects."/other"]\ntrust_level = "trusted"';
    writeFileSync(configPath, existing, { mode: 0o644 });

    assert.equal(trustCodexDirectory(cwd, { configPath }).changed, true);

    assert.equal(
      readFileSync(configPath, 'utf8'),
      `${existing}\n\n[projects.${JSON.stringify(realpathSync(cwd))}]\ntrust_level = "trusted"\n`,
    );
    assert.equal(statSync(configPath).mode & 0o777, 0o644);
  });

  it('upgrades an existing table that is not trusted', () => {
    const root = scratch();
    const configPath = resolve(root, 'config.toml');
    const cwd = resolve(root, 'ws');
    mkdirSync(cwd);
    const quoted = JSON.stringify(realpathSync(cwd));
    writeFileSync(
      configPath,
      `[projects.${quoted}]\ntrust_level = "untrusted" # asked once\n\n[projects."/other"]\ntrust_level = "untrusted"\n`,
    );

    assert.equal(trustCodexDirectory(cwd, { configPath }).changed, true);

    assert.equal(
      readFileSync(configPath, 'utf8'),
      `[projects.${quoted}]\ntrust_level = "trusted"\n\n[projects."/other"]\ntrust_level = "untrusted"\n`,
    );
  });

  it('inserts trust_level into a table that lacks it', () => {
    const root = scratch();
    const configPath = resolve(root, 'config.toml');
    const cwd = resolve(root, 'ws');
    mkdirSync(cwd);
    const quoted = JSON.stringify(realpathSync(cwd));
    writeFileSync(configPath, `[projects.${quoted}]\nnote = "kept"\n`);

    assert.equal(trustCodexDirectory(cwd, { configPath }).changed, true);

    assert.equal(readFileSync(configPath, 'utf8'), `[projects.${quoted}]\ntrust_level = "trusted"\nnote = "kept"\n`);
  });

  it('leaves an already trusted table untouched', () => {
    const root = scratch();
    const configPath = resolve(root, 'config.toml');
    const cwd = resolve(root, 'ws');
    mkdirSync(cwd);
    const raw = `[projects.${JSON.stringify(realpathSync(cwd))}]\ntrust_level = "trusted"\n`;
    writeFileSync(configPath, raw);

    assert.equal(trustCodexDirectory(cwd, { configPath }).changed, false);
    assert.equal(readFileSync(configPath, 'utf8'), raw);
  });

  it('does not append a duplicate when the path exists in an unmanaged spelling', () => {
    const root = scratch();
    const configPath = resolve(root, 'config.toml');
    const cwd = resolve(root, 'ws');
    mkdirSync(cwd);
    const raw = `[projects]\n${JSON.stringify(realpathSync(cwd))} = { trust_level = "trusted" }\n`;
    writeFileSync(configPath, raw);

    const result = trustCodexDirectory(cwd, { configPath });

    assert.equal(result.changed, false);
    assert.equal(result.reason, 'unmanaged_entry');
    assert.equal(readFileSync(configPath, 'utf8'), raw);
  });
});

describe('trustSessionDirectory', () => {
  it('routes each provider to its own config file', () => {
    const root = scratch();
    const claude = resolve(root, '.claude.json');
    const codex = resolve(root, 'config.toml');
    const cwd = resolve(root, 'ws');
    mkdirSync(cwd);
    const options = { claude: { configPath: claude }, codex: { configPath: codex } };

    assert.equal(trustSessionDirectory('claude', cwd, options).configPath, claude);
    assert.equal(trustSessionDirectory('codex', cwd, options).configPath, codex);
    assert.equal(JSON.parse(readFileSync(claude, 'utf8')).projects[realpathSync(cwd)].hasTrustDialogAccepted, true);
    assert.match(readFileSync(codex, 'utf8'), /trust_level = "trusted"/);
    assert.throws(() => trustSessionDirectory('gemini', cwd, options), /Unknown session provider/);
  });
});
