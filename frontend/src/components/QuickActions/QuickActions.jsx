import { sendTerminalCommand } from '../../lib/terminal.js';
import { Button } from '../ui/Button/Button.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './QuickActions.module.css';

function getActions(baseBranch) {
  const target = baseBranch || 'main';
  return [
    {
      label: `Rebase onto ${target}`,
      command: `Rebase this branch onto remote ${target}. First run \`jj git fetch\` to get the latest remote state, then check if we're already up to date by comparing the current parent with ${target}@origin - if so, just say it's already rebased and do nothing. Otherwise run \`jj rebase -d ${target}@origin\`.`,
    },
    {
      label: 'Fix lint errors',
      command: 'Run the linter. Fix all errors and warnings. Show me what you changed.',
    },
    {
      label: 'Update PR description',
      command:
        'Read the diff for the PR on this branch, then update the PR description using `gh pr edit` with `--body`. Follow any PR description conventions configured for this project.',
    },
  ];
}

/**
 * Quick action buttons that send commands to an active terminal session.
 * @param {{ wsRef?: { current: WebSocket | null }, onSend?: (text: string) => void, baseBranch?: string }} props
 */
export function QuickActions({ wsRef, onSend, baseBranch }) {
  const handleAction = (action) => {
    if (onSend) {
      onSend(action.command);
      return;
    }
    sendTerminalCommand(wsRef?.current, action.command);
  };

  return (
    <Stack gap={2} wrap className={styles.actions}>
      <span className={styles.label}>Quick actions:</span>
      {getActions(baseBranch).map((action) => (
        <Button key={action.label} size="md" onClick={() => handleAction(action)}>
          {action.label}
        </Button>
      ))}
    </Stack>
  );
}
