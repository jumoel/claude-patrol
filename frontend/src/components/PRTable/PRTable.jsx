import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table';
import { Fragment, useEffect, useMemo } from 'react';
import { isMergeReady } from '../../lib/checks.js';
import { getRelativeTime } from '../../lib/time.js';
import { StatusBadge } from '../StatusBadge/StatusBadge.jsx';
import { Badge } from '../ui/Badge/Badge.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './PRTable.module.css';

/**
 * Stack position indicator.
 * - Stack view: vertical tree line with numbered node circle
 * - Normal view: compact "2/3" pill
 */
function StackIndicator({ pr, stackView }) {
  if (!pr.is_stacked) return null;

  const { stack_position: pos, stack_size: size } = pr;
  const isFirst = pos === 1;
  const isLast = pos === size;

  if (stackView) {
    const lineClass = isFirst ? styles.stackLineFirst : isLast ? styles.stackLineLast : styles.stackLineMid;
    return (
      <span className={`${styles.stackTree} ${lineClass}`} title={`${pos} of ${size} in stack`}>
        <span className={styles.stackNode}>{pos}</span>
      </span>
    );
  }

  return (
    <span className={styles.stackPill} title={`${pos} of ${size} in stack`}>
      {pos}/{size}
    </span>
  );
}

/**
 * PR data table with TanStack Table for sorting.
 * @param {{ prs: object[], onRowClick?: (prId: string) => void, stackView?: boolean }} props
 */
export function PRTable({ prs, onRowClick, sorting, onSortingChange, workspaceStates, dismissedIdle, stackView, sortedRowsRef }) {
  const columns = useMemo(
    () => [
      {
        accessorKey: 'title',
        header: 'Title',
        cell: ({ row }) => {
          const pr = row.original;
          return (
            <Stack gap={2} as="span">
              <StackIndicator pr={pr} stackView={stackView} />
              <span className={styles.prNumber}>#{pr.number}</span>
              <span className={styles.titleText}>{pr.title}</span>
              <a
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.ghLink}
                onClick={(e) => e.stopPropagation()}
                title="Open on GitHub"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                </svg>
              </a>
            </Stack>
          );
        },
      },
      {
        id: 'repo',
        header: 'Repo',
        accessorFn: (row) => `${row.org}/${row.repo}`,
      },
      {
        id: 'local',
        header: 'Local',
        accessorFn: (row) => {
          const wsState = row.has_session && row.workspace_id && workspaceStates?.get(row.workspace_id);
          const isDismissed = row.workspace_id && dismissedIdle?.has(row.workspace_id);
          if (wsState === 'working') return 5;
          if (wsState === 'idle' && !isDismissed) return 4; // waiting - needs attention
          if (wsState === 'idle' && isDismissed) return 3; // idle - seen by user
          if (row.has_session) return 2;
          if (row.has_workspace) return 1;
          return 0;
        },
        cell: ({ getValue }) => {
          const v = getValue();
          if (v === 5)
            return (
              <Badge color="violet" title="Claude is actively working">
                <span className={styles.spinner} />
                Working
              </Badge>
            );
          if (v === 4)
            return (
              <Badge color="amber" pulse title="Session waiting for input - needs attention">
                Waiting
              </Badge>
            );
          if (v === 3)
            return (
              <Badge color="gray" title="Session idle (already seen)">
                Idle
              </Badge>
            );
          if (v === 2)
            return (
              <Badge color="green" title="Running session">
                Session
              </Badge>
            );
          if (v === 1)
            return (
              <Badge color="blue" title="Active workspace">
                Workspace
              </Badge>
            );
          return null;
        },
        meta: { centered: true },
      },
      {
        id: 'pr_status',
        header: 'Status',
        accessorFn: (row) => (row.draft ? 'draft' : 'open'),
        cell: ({ getValue }) => <StatusBadge status={getValue()} type="status" />,
        meta: { centered: true },
      },
      {
        id: 'ci_status',
        header: 'CI',
        accessorKey: 'ci_status',
        cell: ({ getValue }) => <StatusBadge status={getValue()} type="ci" />,
        meta: { centered: true },
      },
      {
        id: 'review_status',
        header: 'Review',
        accessorKey: 'review_status',
        cell: ({ getValue }) => <StatusBadge status={getValue()} type="review" />,
        meta: { centered: true },
      },
      {
        id: 'mergeable',
        header: 'Merge',
        accessorKey: 'mergeable',
        cell: ({ getValue }) => <StatusBadge status={getValue()} type="merge" />,
        meta: { centered: true },
      },
      {
        accessorKey: 'updated_at',
        header: 'Updated',
        cell: ({ getValue }) => getRelativeTime(getValue()),
        meta: { alignRight: true },
      },
    ],
    [workspaceStates, dismissedIdle, stackView],
  );

  const table = useReactTable({
    data: prs,
    columns,
    state: { sorting },
    onSortingChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const rows = table.getRowModel().rows;

  // Expose the sorted row order to the parent so markdown export matches the table exactly
  useEffect(() => {
    if (sortedRowsRef) sortedRowsRef.current = rows.map((r) => r.original);
  });

  return (
    <table className={styles.table}>
      <colgroup>
        <col className={styles.colTitle} />
        <col className={styles.colRepo} />
        <col className={styles.colLocal} />
        <col className={styles.colStatus} />
        <col className={styles.colCI} />
        <col className={styles.colReview} />
        <col className={styles.colMerge} />
        <col className={styles.colUpdated} />
      </colgroup>
      <thead>
        {table.getHeaderGroups().map((headerGroup) => (
          <tr key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <th
                key={header.id}
                className={`${styles.header} ${header.column.columnDef.meta?.centered ? styles.headerCenter : ''} ${header.column.columnDef.meta?.alignRight ? styles.headerRight : ''}`}
                onClick={header.column.getToggleSortingHandler()}
              >
                {flexRender(header.column.columnDef.header, header.getContext())}
                {{
                  asc: ' ↑',
                  desc: ' ↓',
                }[header.column.getIsSorted()] ?? ''}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={columns.length} className={styles.empty}>
              No PRs found
            </td>
          </tr>
        ) : (
          rows.map((row, idx) => {
            const pr = row.original;
            const prevPr = idx > 0 ? rows[idx - 1].original : null;
            const isStackBoundary = stackView && prevPr && pr.is_stacked && pr.stack_root !== prevPr.stack_root;
            const isStackEnd = stackView && prevPr?.is_stacked && !pr.is_stacked;
            const isStackedRow = stackView && pr.is_stacked;
            const needsSeparator = isStackBoundary || isStackEnd;
            return (
              <Fragment key={row.id}>
                {needsSeparator && (
                  <tr className={styles.stackSeparator} aria-hidden="true">
                    <td colSpan={columns.length} />
                  </tr>
                )}
                <tr
                  className={`${styles.row} ${pr.draft ? styles.draft : ''} ${isMergeReady(pr) ? styles.mergeReady : ''} ${isStackedRow ? styles.stackedRow : ''}`}
                  onClick={() => onRowClick?.(pr.id)}
                  style={{ cursor: onRowClick ? 'pointer' : undefined }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className={`${styles.cell} ${cell.column.columnDef.meta?.centered ? styles.cellCenter : ''} ${cell.column.columnDef.meta?.alignRight ? styles.cellRight : ''}`}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              </Fragment>
            );
          })
        )}
      </tbody>
    </table>
  );
}
