/**
 * How many items a paged list returns. A list at this length may have been cut off:
 * the generated client does not expose the response headers a total would live in.
 */
export const LIST_ITEM_LIMIT = 500;

/** Whether a list reached the cap and may therefore be incomplete. */
export function isListTruncated(items: readonly unknown[]): boolean {
  return items.length >= LIST_ITEM_LIMIT;
}

/**
 * How many path matches the repository file search returns at most. The host
 * slices the match list to this length, so a result that reaches it was cut off
 * even when the git tree itself was read completely; the webview needs the
 * number to say so, which is why it lives here rather than only in the client.
 */
export const MAX_REPO_FILE_SEARCH_RESULTS = 200;
