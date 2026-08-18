import { useCodexReviewState } from '../../hooks/useCodexReviewState.js';
import { sendTerminalCommand } from '../../lib/terminal.js';
import { Button } from '../ui/Button/Button.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './QuickActions.module.css';

/**
 * @typedef {{label: string, command: string}} QuickAction
 * @param {string | undefined} baseBranch
 * @returns {QuickAction[]}
 */
function getActions(baseBranch) {
  const target = baseBranch || 'main';
  return [
    {
      label: `Rebase onto ${target}`,
      command: `Rebase this branch onto remote ${target}. First run \`jj git fetch\` to get the latest remote state, then check if we're already up to date by comparing the current parent with ${target}@origin - if so, just say it's already rebased and do nothing. Otherwise run \`jj rebase -d ${target}@origin\`. If there are conflicts, run \`jj status\` to see the conflicted files, edit them to resolve, then \`jj squash\` to fold the resolution into the commit. Resolving conflicts is part of the task - do not stop and ask. Then run the project's test suite (look in package.json, Makefile, etc. for the right command). Once tests pass, move the bookmark with \`jj bookmark set <bookmark> -r @\` and push with \`jj git push\`. If tests fail, do not push - report what failed.`,
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
 * @param {{
 *   wsRef?: { current: WebSocket | null },
 *   onSend?: (text: string) => void,
 *   baseBranch?: string,
 *   workspaceId?: string,
 *   prId?: string,
 *   sessionState?: 'working' | 'idle',
 *   codexReviewCapability?: import('../../types').CodexReviewCapability,
 * }} props
 */
export function QuickActions({ wsRef, onSend, baseBranch, workspaceId, prId, sessionState, codexReviewCapability }) {
  const codexReview = useCodexReviewState(prId ? workspaceId : undefined);
  /** @param {QuickAction} action */
  const handleAction = (action) => {
    if (onSend) {
      onSend(action.command);
      return;
    }
    sendTerminalCommand(wsRef?.current, action.command);
  };

  const reviewActive = ['requested', 'running', 'delivering'].includes(codexReview.review?.status || '');
  const reviewDisabled =
    codexReview.requesting ||
    reviewActive ||
    sessionState === 'working' ||
    !codexReview.ready ||
    !codexReviewCapability?.available;
  let reviewTitle = 'Review the full effective PR diff with Codex';
  if (codexReviewCapability?.checking) reviewTitle = 'Checking Codex availability';
  else if (!codexReviewCapability?.available) reviewTitle = codexReviewCapability?.reason || 'Codex is unavailable';
  else if (codexReview.reason === 'session_restart_required') {
    reviewTitle = 'Restart this Claude session to enable Codex review';
  } else if (!codexReview.ready) reviewTitle = 'The workspace is not ready for a Codex review';
  else if (sessionState === 'working') reviewTitle = 'Wait for Claude to become idle';

  const statusText = (() => {
    if (codexReview.error) return codexReview.error;
    if (codexReview.requesting) return 'Requesting Codex review...';
    if (codexReview.review?.status === 'requested') return 'Asking Claude to start Codex...';
    if (codexReview.review?.status === 'running') return 'Codex is reviewing the full diff...';
    if (codexReview.review?.status === 'delivering') return 'Claude is presenting the review...';
    if (codexReview.review?.status === 'complete') return 'Review delivered in Claude.';
    if (codexReview.review?.status === 'failed') return codexReview.review.error?.message || 'Codex review failed.';
    if (codexReview.review?.status === 'delivery_unconfirmed') {
      return codexReview.review.error?.message || 'Review delivery could not be confirmed.';
    }
    return null;
  })();

  return (
    <Stack gap={2} wrap className={styles.actions}>
      <span className={styles.label}>Quick actions:</span>
      {getActions(baseBranch).map((action) => (
        <Button key={action.label} size="md" onClick={() => handleAction(action)}>
          {action.label}
        </Button>
      ))}
      {prId && workspaceId && (
        <Button
          size="md"
          variant="primary"
          onClick={codexReview.requestReview}
          disabled={reviewDisabled}
          title={reviewTitle}
        >
          {codexReview.requesting ? 'Requesting Codex...' : 'Review with Codex'}
        </Button>
      )}
      {prId && workspaceId && statusText && (
        <span
          className={codexReview.error || codexReview.review?.error ? styles.error : styles.status}
          role="status"
          aria-live="polite"
        >
          {(codexReview.requesting || reviewActive) && <span className={styles.spinner} aria-hidden="true" />}
          {statusText}
        </span>
      )}
    </Stack>
  );
}
