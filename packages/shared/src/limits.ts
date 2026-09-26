/**
 * How many items a paged list returns. A list at this length may have been cut off.
 * Whether it actually was is exact when the server reported a total
 * (`isListTruncatedWithTotal`); the length alone is only the fallback heuristic.
 */
export const LIST_ITEM_LIMIT = 500;

/** Whether a list reached the cap and may therefore be incomplete. */
export function isListTruncated(items: readonly unknown[]): boolean {
  return items.length >= LIST_ITEM_LIMIT;
}

/**
 * Whether a paged list is incomplete, given the server's `X-Total-Count` total
 * when one was reported: `items` is then truncated exactly when fewer rows
 * arrived than the server holds (a full cap of rows whose total equals the cap
 * is complete, which the length-only heuristic misreports). Without a total
 * the heuristic stays: a list at the cap may have been cut off.
 */
export function isListTruncatedWithTotal(items: readonly unknown[], totalCount?: number): boolean {
  if (typeof totalCount === 'number') {
    return items.length < totalCount;
  }
  return isListTruncated(items);
}

/**
 * How many path matches the repository file search returns at most. The host
 * slices the match list to this length, so a result that reaches it was cut off
 * even when the git tree itself was read completely; the webview needs the
 * number to say so, which is why it lives here rather than only in the client.
 */
export const MAX_REPO_FILE_SEARCH_RESULTS = 200;
