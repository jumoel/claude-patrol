import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const sourceDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
/** @param {string} path */
const readSource = (path) => readFileSync(join(sourceDirectory, path), 'utf8');

test('application theme tokens have one owner', () => {
  const theme = readSource('main.css');
  const tokenNames = [
    'surface',
    'control',
    'line',
    'ink',
    'text',
    'muted',
    'blue',
    'green',
    'amber',
    'red',
    'purple',
    'font-sans',
    'font-mono',
    'radius',
    'control-height',
  ];

  for (const token of tokenNames) {
    assert.match(theme, new RegExp(`--${token}:`));
  }

  for (const path of [
    'components/AppShell/AppShell.module.css',
    'components/WorkDashboard/WorkDashboard.module.css',
    'components/SetupMode/SetupMode.module.css',
  ]) {
    const stylesheet = readSource(path);
    for (const token of tokenNames) {
      assert.doesNotMatch(stylesheet, new RegExp(`--${token}:`), `${path} must consume --${token}, not redefine it`);
    }
  }
});

test('settings cannot introduce a separate color and control system', () => {
  const stylesheet = readSource('components/SetupMode/SetupMode.module.css');
  const component = readSource('components/SetupMode/SetupMode.jsx');

  assert.doesNotMatch(stylesheet, /#[0-9a-f]{3,8}\b|\brgb\(|\bhsl\(/i);
  assert.doesNotMatch(component, /<button\b/);
  assert.match(component, /<SettingsHeader/);
  assert.match(component, /<SettingsSection/);
  assert.match(component, /<Button\b/);
  assert.match(component, /<Badge\b/);
});
