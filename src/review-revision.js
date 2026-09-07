import { createHash } from 'node:crypto';

/** A digest is available only for a coherent, known remote tuple. */
export function reviewRevision(head, title, body) {
  if (![head, title, body].every((value) => typeof value === 'string') || !head) return null;
  return `review-revision-v1:${createHash('sha256')
    .update(JSON.stringify([head, title, body]))
    .digest('hex')}`;
}
