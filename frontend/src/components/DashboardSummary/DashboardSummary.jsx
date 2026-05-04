import { useCallback, useEffect, useRef, useState } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { useRuleRuns } from '../../hooks/useRuleRuns.js';
import { useTasks } from '../../hooks/useTasks.js';
import { fetchRules, fetchSessions, fetchWorkspaces, runRuleForAll, subscribeRuleForAll } from '../../lib/api.js';
import { getRelativeTime } from '../../lib/time.js';
import { Badge } from '../ui/Badge/Badge.jsx';
import { Box } from '../ui/Box/Box.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './DashboardSummary.module.css';

/**
 * Summary stats bar above the PR table.
 * @param {{ prCount: number, syncedAt: string | null }} props
 */
function StatDropdown({ label, items, renderItem }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useClickOutside(
    ref,
    useCallback(() => setOpen(false), []),
  );

  return (
    <span className={styles.dropdownWrapper} ref={ref}>
      <button
        className={`${styles.stat} ${styles.clickable} ${items.length === 0 ? styles.disabled : ''}`}
        onClick={() => items.length > 0 && setOpen((prev) => !prev)}
        type="button"
      >
        {label}
      </button>
      {open && items.length > 0 && <div className={styles.dropdown}>{items.map(renderItem)}</div>}
    </span>
  );
}

export function DashboardSummary({ prCount, onOpenGlobalTerminal }) {
  const [workspaces, setWorkspaces] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [ruleErrors, setRuleErrors] = useState([]);
  const [ruleDefs, setRuleDefs] = useState([]);
  const tasks = useTasks();
  const ruleRuns = useRuleRuns();

  useEffect(() => {
    fetchWorkspaces()
      .then(setWorkspaces)
      .catch(() => {});
    fetchSessions()
      .then(setSessions)
      .catch(() => {});
    fetchRules()
      .then((data) => {
        setRuleDefs(data.rules || []);
        setRuleErrors(data.errors || []);
      })
      .catch(() => {});
  }, []);

  // Build a workspace_id -> workspace lookup for session labels
  const wsById = Object.fromEntries(workspaces.map((ws) => [ws.id, ws]));

  const runningTasks = tasks.filter((t) => t.status === 'running').length;
  const taskLabel =
    runningTasks > 0
      ? `${runningTasks} running ${runningTasks === 1 ? 'task' : 'tasks'}`
      : `${tasks.length} recent ${tasks.length === 1 ? 'task' : 'tasks'}`;

  const runningRules = ruleRuns.filter((r) => r.status === 'running').length;
  // Activity dropdown: bad rules + recent runs only. Rule definitions live in
  // their own "Trigger" dropdown so the activity overview stays an activity feed.
  const activityLabel = (() => {
    if (ruleErrors.length > 0) return `${ruleErrors.length} bad ${ruleErrors.length === 1 ? 'rule' : 'rules'}`;
    if (runningRules > 0) return `${runningRules} running ${runningRules === 1 ? 'rule' : 'rules'}`;
    if (ruleRuns.length > 0) return `${ruleRuns.length} recent rule ${ruleRuns.length === 1 ? 'run' : 'runs'}`;
    return null;
  })();
  const activityItems = [
    ...ruleErrors.map((e) => ({ kind: 'error', id: `err:${e.rule_id}`, ...e })),
    ...ruleRuns.map((r) => ({ kind: 'run', ...r })),
  ];

  const PR_TRIGGERS = ['ci.finalized', 'mergeable.changed', 'labels.changed', 'draft.changed'];
  const triggerableRules = ruleDefs.filter((r) => !r.manual && PR_TRIGGERS.includes(r.on));

  const handleRunForAll = useCallback(async (rule) => {
    const subscribe =
      rule.requires_subscription === true &&
      window.confirm(
        `Run "${rule.id}" for ALL matching PRs?\n\nThis rule requires subscription. Click OK to auto-subscribe and fire on every match. Cancel to abort.`,
      );
    if (rule.requires_subscription === true && !subscribe) return;
    if (
      rule.requires_subscription !== true &&
      !window.confirm(`Run "${rule.id}" for ALL matching PRs? Cooldown still applies per-PR.`)
    ) {
      return;
    }
    try {
      const result = await runRuleForAll(rule.id, { subscribe });
      window.alert(
        `Fired: ${result.fired?.length ?? 0}\nSkipped: ${result.skipped?.length ?? 0}\n\nWatch the Rules dropdown for run progress.`,
      );
    } catch (err) {
      window.alert(`Failed: ${err.message}`);
    }
  }, []);

  const handleSubscribeAll = useCallback(async (rule) => {
    const lifetimeNote =
      rule.consume_on === 'trigger'
        ? "Subscriptions clear on each PR's next trigger event whether or not the rule fires. Stale-subscription-safe."
        : rule.consume_on === 'fire'
          ? 'Subscriptions clear when the rule fires successfully on each PR. PRs that never end up matching the where clause keep the subscription - unsubscribe manually if needed.'
          : 'Subscriptions are permanent until manually unsubscribed.';
    if (
      !window.confirm(
        `Subscribe ALL matching PRs to "${rule.id}"?\n\nThe rule will auto-fire on each subscribed PR's next matching trigger event. No PRs are fired right now.\n\n${lifetimeNote}`,
      )
    ) {
      return;
    }
    try {
      const result = await subscribeRuleForAll(rule.id);
      window.alert(
        `Subscribed: ${result.subscribed?.length ?? 0}\nAlready subscribed: ${result.already_subscribed?.length ?? 0}\nSkipped: ${result.skipped?.length ?? 0}`,
      );
    } catch (err) {
      window.alert(`Failed: ${err.message}`);
    }
  }, []);

  return (
    <Box px={4} py={2} border rounded="lg" bg="white" className={styles.bar}>
      <Stack gap={3}>
        <span className={styles.stat}>{prCount} open PRs</span>
        <span className={styles.divider} />
        <StatDropdown
          label={`${workspaces.length} active workspaces`}
          items={workspaces}
          renderItem={(ws) => {
            const href = ws.pr_id ? `#/pr/${encodeURIComponent(ws.pr_id)}` : `#/workspace/${ws.id}`;
            return (
              <a key={ws.id} className={styles.dropdownItem} href={href}>
                <span className={styles.itemName}>{ws.name}</span>
                <span className={styles.itemDetail}>{ws.path}</span>
              </a>
            );
          }}
        />
        <span className={styles.divider} />
        <StatDropdown
          label={`${sessions.length} running sessions`}
          items={sessions}
          renderItem={(sess) => {
            const ws = sess.workspace_id ? wsById[sess.workspace_id] : null;
            const label = ws ? ws.name : 'Global session';
            const detail = `PID ${sess.pid} - started ${new Date(sess.started_at).toLocaleTimeString()}`;
            const href = ws ? (ws.pr_id ? `#/pr/${encodeURIComponent(ws.pr_id)}` : `#/workspace/${ws.id}`) : null;
            if (!href) {
              return (
                <a
                  key={sess.id}
                  className={styles.dropdownItem}
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenGlobalTerminal?.();
                  }}
                >
                  <span className={styles.itemName}>{label}</span>
                  <span className={styles.itemDetail}>{detail}</span>
                </a>
              );
            }
            return (
              <a key={sess.id} className={styles.dropdownItem} href={href}>
                <span className={styles.itemName}>{label}</span>
                <span className={styles.itemDetail}>{detail}</span>
              </a>
            );
          }}
        />
        {tasks.length > 0 && (
          <>
            <span className={styles.divider} />
            <StatDropdown
              label={taskLabel}
              items={tasks}
              renderItem={(task) => <TaskItem key={task.id} task={task} />}
            />
          </>
        )}
        {activityLabel && (
          <>
            <span className={styles.divider} />
            <StatDropdown label={activityLabel} items={activityItems} renderItem={(item) => <RuleItem key={item.id} item={item} />} />
          </>
        )}
        {triggerableRules.length > 0 && (
          <>
            <span className={styles.divider} />
            <StatDropdown
              label={`Trigger ${triggerableRules.length === 1 ? 'rule' : 'rules'}`}
              items={triggerableRules}
              renderItem={(rule) => (
                <TriggerableRuleItem
                  key={rule.id}
                  rule={rule}
                  onFire={handleRunForAll}
                  onSubscribeAll={handleSubscribeAll}
                />
              )}
            />
          </>
        )}
      </Stack>
    </Box>
  );
}

function TaskItem({ task }) {
  const time = task.endedAt
    ? `Finished ${getRelativeTime(task.endedAt)}`
    : `Started ${getRelativeTime(task.startedAt)}`;
  return (
    <div className={styles.dropdownItem}>
      <Stack gap={2} align="center">
        <TaskStatusBadge status={task.status} />
        <span className={styles.itemName}>{task.label}</span>
      </Stack>
      <span className={styles.itemDetail}>{time}</span>
      {task.error && <span className={styles.itemDetail}>{task.error}</span>}
      {task.warnings?.length > 0 && (
        <span className={styles.itemDetail}>
          {task.warnings.length} warning{task.warnings.length === 1 ? '' : 's'}
        </span>
      )}
    </div>
  );
}

function TaskStatusBadge({ status }) {
  if (status === 'running')
    return (
      <Badge color="violet" pulse>
        Running
      </Badge>
    );
  if (status === 'success') return <Badge color="green">Done</Badge>;
  if (status === 'warning') return <Badge color="amber">Warnings</Badge>;
  if (status === 'error') return <Badge color="red">Failed</Badge>;
  return <Badge color="gray">{status}</Badge>;
}

function RuleItem({ item }) {
  if (item.kind === 'error') {
    return (
      <div className={styles.dropdownItem}>
        <Stack gap={2} align="center">
          <Badge color="red">Bad rule</Badge>
          <span className={styles.itemName}>{item.rule_id}</span>
        </Stack>
        <span className={styles.itemDetail}>{item.error}</span>
      </div>
    );
  }

  const time = item.ended_at ? `Finished ${getRelativeTime(item.ended_at)}` : `Started ${getRelativeTime(item.started_at)}`;
  const target = item.pr_id || item.session_id || item.workspace_id;
  const href = item.pr_id
    ? `#/pr/${encodeURIComponent(item.pr_id)}`
    : item.workspace_id
      ? `#/workspace/${item.workspace_id}`
      : null;
  const inner = (
    <>
      <Stack gap={2} align="center">
        <RuleStatusBadge status={item.status} />
        <span className={styles.itemName}>{item.rule_id}</span>
        <span className={styles.itemDetail}>on {item.trigger}</span>
      </Stack>
      <span className={styles.itemDetail}>{time}</span>
      {target && <span className={styles.itemDetail}>{target}</span>}
      {item.error && <span className={styles.itemDetail}>{item.error}</span>}
    </>
  );
  return href ? (
    <a className={styles.dropdownItem} href={href}>
      {inner}
    </a>
  ) : (
    <div className={styles.dropdownItem}>{inner}</div>
  );
}

function RuleStatusBadge({ status }) {
  if (status === 'running')
    return (
      <Badge color="violet" pulse>
        Running
      </Badge>
    );
  if (status === 'success') return <Badge color="green">Done</Badge>;
  if (status === 'error') return <Badge color="red">Failed</Badge>;
  return <Badge color="gray">{status}</Badge>;
}

function TriggerableRuleItem({ rule, onFire, onSubscribeAll }) {
  const scope = rule.requires_subscription
    ? rule.consume_on === 'fire'
      ? 'Subscription (until fire)'
      : rule.consume_on === 'trigger'
        ? 'Subscription (until next trigger)'
        : 'Subscription (permanent)'
    : 'Auto on all matching';
  return (
    <div className={styles.dropdownItem}>
      <Stack gap={2} align="center">
        <Badge color="violet">Rule</Badge>
        <span className={styles.itemName}>{rule.id}</span>
        <span className={styles.itemDetail}>on {rule.on}</span>
      </Stack>
      <span className={styles.itemDetail}>{scope}</span>
      <Stack gap={2} className={styles.actionRow}>
        <Button
          size="sm"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onFire(rule);
          }}
          title="Fire this rule against every PR matching its where clause"
        >
          Run for all matching
        </Button>
        {rule.requires_subscription && (
          <Button
            size="sm"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onSubscribeAll(rule);
            }}
            title="Subscribe every matching PR; the rule auto-fires on each PR's next matching trigger"
          >
            Subscribe all matching
          </Button>
        )}
      </Stack>
    </div>
  );
}
