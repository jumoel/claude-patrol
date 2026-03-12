import styles from './QuickActions.module.css';

const BUILT_IN_ACTIONS = [
  {
    label: 'Rebase onto main',
    command: '/clear\r',
    followUp: 'Rebase this branch onto remote main using jj rebase -d main@origin\r',
    delay: 500,
  },
  {
    label: 'Fix lint errors',
    command: 'Run the linter. Fix all errors and warnings. Show me what you changed.\r',
  },
  {
    label: 'Update PR description',
    command: 'Read the diff for the PR on this branch, then update the PR description using `gh pr edit` with `--body`. Follow any PR description conventions configured for this project.\r',
  },
];

/**
 * Quick action buttons that send commands to an active terminal session.
 * @param {{ wsRef: { current: WebSocket | null } }} props
 */
export function QuickActions({ wsRef }) {
  const sendCommand = (text) => {
    const ws = wsRef.current;
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
    <div className={styles.actions}>
      <span className={styles.label}>Quick actions:</span>
      {BUILT_IN_ACTIONS.map(action => (
        <button key={action.label} className={styles.actionButton} onClick={() => handleAction(action)}>
          {action.label}
        </button>
      ))}
    </div>
  );
}
