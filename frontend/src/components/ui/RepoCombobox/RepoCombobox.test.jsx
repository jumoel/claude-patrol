import assert from 'node:assert/strict';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, test, vi } from 'vitest';
import { RepoCombobox } from './RepoCombobox.jsx';

const api = vi.hoisted(() => ({ fetchAllRepos: vi.fn() }));

vi.mock('../../../lib/api.js', () => api);

beforeEach(() => api.fetchAllRepos.mockReset());

test('opens from the keyboard and selects a filtered repository', async () => {
  const onChange = vi.fn();
  api.fetchAllRepos.mockResolvedValue({ repos: ['acme/alpha', 'acme/widgets'] });
  render(<RepoCombobox value="" onChange={onChange} />);

  const trigger = screen.getByRole('button', { name: 'Repository' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const input = await screen.findByRole('combobox', { name: 'Filter repositories' });
  fireEvent.change(input, { target: { value: 'widgets' } });
  fireEvent.keyDown(input, { key: 'Enter' });

  assert.deepEqual(onChange.mock.calls, [['acme/widgets']]);
  assert.equal(screen.queryByRole('listbox'), null);
  assert.equal(document.activeElement, trigger);
});

test('shows repository load failures and retries in place', async () => {
  const user = userEvent.setup();
  api.fetchAllRepos.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ repos: ['acme/widgets'] });
  render(<RepoCombobox value="" onChange={vi.fn()} />);

  await user.click(screen.getByRole('button', { name: 'Repository' }));
  assert.ok(await screen.findByRole('alert'));
  await user.click(screen.getByRole('button', { name: 'Retry' }));

  assert.ok(await screen.findByRole('option', { name: 'acme/widgets' }));
  assert.equal(api.fetchAllRepos.mock.calls.length, 2);
});
