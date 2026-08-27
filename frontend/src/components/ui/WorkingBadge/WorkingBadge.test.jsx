import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import { test } from 'vitest';
import { WorkingBadge } from './WorkingBadge.jsx';

test('always renders a spinner with the working label', () => {
  render(<WorkingBadge />);

  const badge = screen.getByText('Working');
  assert.ok(badge.querySelector('[aria-hidden="true"]'));
});

test('uses a static marker when the surrounding view already shows active work', () => {
  render(<WorkingBadge indicator="dot" />);

  const badge = screen.getByText('Working');
  assert.ok(badge.querySelector('[data-state-marker="working"]'));
  assert.equal(badge.querySelector('[data-spinner="true"]'), null);
});

test('production components cannot hard-code a separate working indicator', () => {
  const sourceDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const violations = readdirSync(sourceDirectory, { recursive: true })
    .map((path) => path.toString())
    .filter((path) => path.endsWith('.jsx') && !path.endsWith('.test.jsx'))
    .filter((path) => path !== 'components/ui/WorkingBadge/WorkingBadge.jsx')
    .filter((path) => {
      const source = readFileSync(join(sourceDirectory, path), 'utf8');
      return /(['"])Working\1|>\s*Working\s*</.test(source);
    });

  assert.deepEqual(violations, []);
});
