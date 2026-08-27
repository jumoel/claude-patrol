import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import { test } from 'vitest';
import { Button } from '../Button/Button.jsx';
import { Spinner } from './Spinner.jsx';

test('busy buttons own their spinner and accessibility state', () => {
  render(<Button busy>Saving...</Button>);

  const button = screen.getByRole('button', { name: 'Saving...' });
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.ok(button.querySelector('[data-spinner="true"]'));
});

test('production components cannot define separate spinner implementations', () => {
  const sourceDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const violations = readdirSync(sourceDirectory, { recursive: true })
    .map((path) => path.toString())
    .filter((path) => /\.(jsx|css)$/.test(path) && !path.endsWith('.test.jsx'))
    .filter((path) => !path.startsWith('components/ui/Spinner/'))
    .filter((path) => {
      const source = readFileSync(join(sourceDirectory, path), 'utf8');
      return /styles\.\w*spinner|className=.*spinner|\.spinner\s*\{|animation:\s*spin/i.test(source);
    });

  assert.deepEqual(violations, []);
});

test('spinner remains decorative outside a live region', () => {
  const { container } = render(<Spinner />);
  assert.equal(container.firstElementChild?.getAttribute('aria-hidden'), 'true');
});

test('spinner stylesheet owns the keyframes referenced by its animation', () => {
  const stylesheet = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Spinner.module.css'), 'utf8');
  assert.match(stylesheet, /animation:\s*spin\s+1s\s+linear\s+infinite/);
  assert.match(stylesheet, /@keyframes\s+spin\b/);
  assert.match(stylesheet, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});
