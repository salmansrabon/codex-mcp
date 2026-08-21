import { randomUUID } from 'node:crypto';

/** Short, sortable-enough review identifier used in logs and results. */
export function newReviewId(): string {
  return `rev_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}
