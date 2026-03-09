import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
} from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { StatusBadge } from '../StatusBadge/StatusBadge.jsx';
import { getRelativeTime } from '../../lib/time.js';
import styles from './PRTable.module.css';

/**
 * PR data table with TanStack Table for sorting.
 * @param {{ prs: object[] }} props
 */
export function PRTable({ prs }) {
  const [sorting, setSorting] = useState([]);

  const columns = useMemo(() => [
    {
      accessorKey: 'title',
      header: 'Title',
      cell: ({ row }) => {
        const pr = row.original;
        return (
          <span>
            <a href={pr.url} target="_blank" rel="noopener noreferrer" className={styles.link}>
              {pr.title}
            </a>
            {pr.draft && <span className={styles.draftLabel}>Draft</span>}
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
    },
    {
      id: 'review_status',
      header: 'Review',
      accessorKey: 'review_status',
      cell: ({ getValue }) => <StatusBadge status={getValue()} type="review" />,
    },
    {
      accessorKey: 'updated_at',
      header: 'Updated',
      cell: ({ getValue }) => getRelativeTime(getValue()),
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
                className={styles.header}
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
          <tr key={row.id} className={`${styles.row} ${row.original.draft ? styles.draft : ''}`}>
            {row.getVisibleCells().map(cell => (
              <td key={cell.id} className={styles.cell}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
