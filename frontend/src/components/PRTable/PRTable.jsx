import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
} from '@tanstack/react-table';
import { useMemo } from 'react';
import { StatusBadge } from '../StatusBadge/StatusBadge.jsx';
import { getRelativeTime } from '../../lib/time.js';
import { isMergeReady } from '../../lib/checks.js';
import styles from './PRTable.module.css';

/**
 * PR data table with TanStack Table for sorting.
 * @param {{ prs: object[], onRowClick?: (prId: string) => void }} props
 */
export function PRTable({ prs, onRowClick, sorting, onSortingChange, idleWorkspaces }) {

  const columns = useMemo(() => [
    {
      accessorKey: 'title',
      header: 'Title',
      cell: ({ row }) => {
        const pr = row.original;
        return (
          <span className={styles.titleCell}>
            <span className={styles.titleText}>
              {pr.title}
            </span>
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.ghLink}
              onClick={(e) => e.stopPropagation()}
              title="Open on GitHub"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
              </svg>
            </a>
          </span>
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
        const idle = row.has_session && row.workspace_id && idleWorkspaces?.has(row.workspace_id);
        return idle ? 3 : row.has_session ? 2 : row.has_workspace ? 1 : 0;
      },
      cell: ({ getValue }) => {
        const v = getValue();
        if (v === 3) return <span className={styles.idleBadge} title="Session needs attention">Idle</span>;
        if (v === 2) return <span className={styles.sessionBadge} title="Running session">Session</span>;
        if (v === 1) return <span className={styles.workspaceBadge} title="Active workspace">Workspace</span>;
        return null;
      },
      meta: { centered: true },
    },
    {
      id: 'pr_status',
      header: 'Status',
      accessorFn: (row) => row.draft ? 'draft' : 'open',
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
  ], [idleWorkspaces]);

  const table = useReactTable({
    data: prs,
    columns,
    state: { sorting },
    onSortingChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const rows = table.getRowModel().rows;

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
        {table.getHeaderGroups().map(headerGroup => (
          <tr key={headerGroup.id}>
            {headerGroup.headers.map(header => (
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
            <td colSpan={columns.length} className={styles.empty}>No PRs found</td>
          </tr>
        ) : rows.map(row => (
          <tr key={row.id} className={`${styles.row} ${row.original.draft ? styles.draft : ''} ${isMergeReady(row.original) ? styles.mergeReady : ''}`} onClick={() => onRowClick?.(row.original.id)} style={{ cursor: onRowClick ? 'pointer' : undefined }}>
            {row.getVisibleCells().map(cell => (
              <td key={cell.id} className={`${styles.cell} ${cell.column.columnDef.meta?.centered ? styles.cellCenter : ''} ${cell.column.columnDef.meta?.alignRight ? styles.cellRight : ''}`}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
