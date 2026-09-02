import assert from 'node:assert/strict';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { test } from 'vitest';
import { TranscriptViewer } from './TranscriptViewer.jsx';

/** @returns {import('../../types').TranscriptEntry[]} */
function entries() {
  return [
    {
      timestamp: '2026-08-30T10:00:00.000Z',
      role: 'user',
      isHuman: true,
      model: null,
      content: [{ type: 'text', text: 'Please fix the flaky retry test' }],
    },
    {
      timestamp: '2026-08-30T10:00:05.000Z',
      role: 'assistant',
      isHuman: false,
      model: 'claude-opus-5',
      content: [
        { type: 'thinking', text: 'The retry loop never backs off' },
        { type: 'text', text: 'I will read the harness first' },
        { type: 'tool_use', name: 'Read', input_summary: 'src/harness.test.js' },
      ],
    },
    {
      role: 'user',
      isHuman: false,
      model: null,
      content: [{ type: 'tool_result', name: 'Read', output_summary: 'export function retry() {}' }],
    },
    {
      role: 'assistant',
      isHuman: false,
      model: 'claude-opus-5',
      content: [{ type: 'thinking', text: 'Only thinking here' }],
    },
  ];
}

test('renders role badges and text blocks, hiding thinking by default', () => {
  render(<TranscriptViewer entries={entries()} loading={false} error={null} />);

  assert.ok(screen.getByText('You'));
  assert.equal(screen.getAllByText('Claude').length, 1, 'a thinking-only entry is dropped');
  assert.ok(screen.getByText('Tool Result'));
  assert.ok(screen.getByText('Please fix the flaky retry test'));
  assert.ok(screen.getByText('I will read the harness first'));
  assert.equal(screen.getAllByText('claude-opus-5').length, 1);
  assert.equal(screen.queryByText('The retry loop never backs off'), null);
  assert.equal(screen.queryByText('Thinking'), null);
  assert.equal(screen.queryByText('src/harness.test.js'), null, 'tool input starts collapsed');
});

test('tool_use and tool_result blocks toggle their detail independently on click', async () => {
  const user = userEvent.setup();
  render(<TranscriptViewer entries={entries()} loading={false} error={null} />);

  const toolUse = screen.getByRole('button', { name: /Used Read/ });
  const toolResult = screen.getByRole('button', { name: /Result from Read/ });

  await user.click(toolUse);
  assert.ok(screen.getByText('src/harness.test.js'));
  assert.equal(screen.queryByText('export function retry() {}'), null);

  await user.click(toolResult);
  assert.ok(screen.getByText('export function retry() {}'));
  assert.ok(screen.getByText('src/harness.test.js'));

  await user.click(toolUse);
  assert.equal(screen.queryByText('src/harness.test.js'), null);
  assert.ok(screen.getByText('export function retry() {}'));
});

test('Show thinking reveals thinking blocks and thinking-only entries', async () => {
  const user = userEvent.setup();
  render(<TranscriptViewer entries={entries()} loading={false} error={null} />);

  await user.click(screen.getByRole('checkbox', { name: 'Show thinking' }));
  assert.equal(screen.getAllByText('Thinking').length, 2);
  assert.ok(screen.getByText('The retry loop never backs off'));
  assert.ok(screen.getByText('Only thinking here'));
  assert.equal(screen.getAllByText('Claude').length, 2);

  await user.click(screen.getByRole('checkbox', { name: 'Show thinking' }));
  assert.equal(screen.queryByText('Thinking'), null);
  assert.equal(screen.getAllByText('Claude').length, 1);
});

test('search narrows entries by the first populated field of each block and reports the match count', async () => {
  const user = userEvent.setup();
  render(<TranscriptViewer entries={entries()} loading={false} error={null} />);
  const search = screen.getByPlaceholderText('Search transcript...');

  await user.type(search, 'flaky');
  assert.ok(screen.getByText('1 / 4 messages'));
  assert.ok(screen.getByText('You'));
  assert.equal(screen.queryByText('Tool Result'), null);

  // Each block contributes only text || input_summary || output_summary || name, so
  // the tool result named "Read" is not found by name once it has an output summary.
  await user.clear(search);
  await user.type(search, 'read');
  assert.ok(screen.getByText('1 / 4 messages'));
  assert.ok(screen.getByText('Claude'));
  assert.equal(screen.queryByText('Tool Result'), null);
  assert.equal(screen.queryByText('You'), null);

  await user.clear(search);
  await user.type(search, 'retry()');
  assert.ok(screen.getByText('1 / 4 messages'));
  assert.ok(screen.getByText('Tool Result'), 'tool output is searchable');
  assert.equal(screen.queryByText('Claude'), null);

  await user.clear(search);
  assert.equal(screen.queryByText(/messages$/), null);
});

test('loading, error, and empty states replace the conversation', () => {
  const loading = render(<TranscriptViewer entries={null} loading={true} error={null} />);
  assert.equal(screen.getByRole('status').textContent, 'Loading transcript...');
  loading.unmount();

  const failed = render(<TranscriptViewer entries={null} loading={false} error="transcript file is missing" />);
  assert.ok(screen.getByText('transcript file is missing'));
  assert.equal(screen.queryByPlaceholderText('Search transcript...'), null);
  failed.unmount();

  render(<TranscriptViewer entries={[]} loading={false} error={null} />);
  assert.ok(screen.getByText('No transcript available'));
});
