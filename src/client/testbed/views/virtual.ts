/**
 * Virtual scrolling with fixed-height rows: only the rows in view, plus
 * `overscan` above and below, are drawn.
 */

const DEFAULT_OVERSCAN = 20;

/** Rows `[start, end)` to draw. */
export function visibleRange(options: {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  count: number;
  overscan?: number;
}): { start: number; end: number } {
  const { scrollTop, viewportHeight, rowHeight, count } = options;
  const overscan = options.overscan ?? DEFAULT_OVERSCAN;
  if (count === 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const inView = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1;
  const start = Math.max(0, Math.min(first, count - 1) - overscan);
  const end = Math.min(count, first + inView + overscan);
  return { start, end };
}

/**
 * Whether the view sits at the bottom (within half a row), so it keeps
 * following new events. Scrolling up stops the following.
 */
export function atBottom(options: {
  scrollTop: number;
  viewportHeight: number;
  scrollHeight: number;
  rowHeight: number;
}): boolean {
  const { scrollTop, viewportHeight, scrollHeight, rowHeight } = options;
  return scrollHeight - (scrollTop + viewportHeight) <= rowHeight / 2;
}
