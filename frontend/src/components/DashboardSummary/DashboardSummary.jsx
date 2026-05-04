import { useCallback, useEffect, useRef, useState } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { useRuleRuns } from '../../hooks/useRuleRuns.js';
import { useTasks } from '../../hooks/useTasks.js';
import { fetchRules, fetchSessions, fetchWorkspaces } from '../../lib/api.js';
import { getRelativeTime } from '../../lib/time.js';
import { Badge } from '../ui/Badge/Badge.jsx';
import { Box } from '../ui/Box/Box.jsx';
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
  const totalRulesItem = ruleDefs.length + ruleErrors.length;
  const ruleLabel = (() => {
    if (ruleErrors.length > 0) return `${ruleDefs.length}/${totalRulesItem} rules (${ruleErrors.length} bad)`;
    if (runningRules > 0) return `${runningRules} running ${runningRules === 1 ? 'rule' : 'rules'}`;
    if (ruleRuns.length > 0) return `${ruleRuns.length} recent rule runs`;
    return `${ruleDefs.length} ${ruleDefs.length === 1 ? 'rule' : 'rules'}`;
  })();
  const ruleItems = [
    ...ruleErrors.map((e) => ({ kind: 'error', id: `err:${e.rule_id}`, ...e })),
    ...ruleRuns.map((r) => ({ kind: 'run', ...r })),
  ];

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
        {(ruleDefs.length > 0 || ruleErrors.length > 0 || ruleRuns.length > 0) && (
          <>
            <span className={styles.divider} />
            <StatDropdown label={ruleLabel} items={ruleItems} renderItem={(item) => <RuleItem key={item.id} item={item} />} />
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
