import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
} from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { StatusBadge } from '../StatusBadge/StatusBadge.jsx';
import { getRelativeTime } from '../../lib/time.js';
import { isMergeReady } from '../../lib/checks.js';
import styles from './PRTable.module.css';

/**
 * PR data table with TanStack Table for sorting.
 * @param {{ prs: object[], onRowClick?: (prId: string) => void }} props
 */
export function PRTable({ prs, onRowClick }) {
  const [sorting, setSorting] = useState([]);

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
              {pr.draft && <span className={styles.draftLabel}>Draft</span>}
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
  ], []);

  const table = useReactTable({
    data: prs,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (prs.length === 0) {
    return <p className={styles.empty}>No PRs found</p>;
  }

  return (
    <table className={styles.table}>
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
        {table.getRowModel().rows.map(row => (
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
