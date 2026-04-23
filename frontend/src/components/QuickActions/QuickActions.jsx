import { Button } from '../ui/Button/Button.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './QuickActions.module.css';

function getActions(baseBranch) {
  const target = baseBranch || 'main';
  return [
    {
      label: `Rebase onto ${target}`,
      command: `Rebase this branch onto remote ${target} using \`jj rebase -d ${target}@origin\`. First check if we're already up to date by comparing the current parent with ${target}@origin - if so, just say it's already rebased and do nothing.\r`,
    },
    {
      label: 'Fix lint errors',
      command: 'Run the linter. Fix all errors and warnings. Show me what you changed.\r',
    },
    {
      label: 'Update PR description',
      command:
        'Read the diff for the PR on this branch, then update the PR description using `gh pr edit` with `--body`. Follow any PR description conventions configured for this project.\r',
    },
  ];
}

/**
 * Quick action buttons that send commands to an active terminal session.
 * @param {{ wsRef?: { current: WebSocket | null }, onSend?: (text: string) => void, baseBranch?: string }} props
 */
export function QuickActions({ wsRef, onSend, baseBranch }) {
  const sendCommand = (text) => {
    if (onSend) {
      onSend(text);
      return;
    }
    const ws = wsRef?.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'input', data: text }));
  };

  const handleAction = (action) => {
    sendCommand(action.command);
    if (action.followUp) {
      setTimeout(() => sendCommand(action.followUp), action.delay || 500);
    }
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
