import { Badge } from '../Badge/Badge.jsx';
import { Spinner } from '../Spinner/Spinner.jsx';

/** @param {{status: string}} props */
export function RunStatusBadge({ status }) {
  if (status === 'running') {
    return (
      <Badge color="violet">
        <Spinner size="xs" />
        Running
      </Badge>
    );
  }
  if (status === 'success') return <Badge color="green">Done</Badge>;
  if (status === 'warning') return <Badge color="amber">Warnings</Badge>;
  if (status === 'error') return <Badge color="red">Failed</Badge>;
  return <Badge color="gray">{status}</Badge>;
}
