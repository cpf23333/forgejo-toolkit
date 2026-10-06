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

/**
 * The bounds and the default of `forgejoToolkit.notificationPollingInterval`, in
 * seconds — the exact numbers the manifest declares as `minimum`, `maximum` and
 * `default` (`packages/forgejo-toolkit/package.json`).
 *
 * Three places need them and cannot share a literal: the poller's own reader
 * clamps a stored value to this range (`ConfigManager.getNotificationPollingInterval`),
 * the settings page's write validation refuses a value outside it, and the page's
 * own sentence states the range to the reader. They live here rather than only in
 * the extension because the manifest is the declaration and this module is what
 * both readers agree on; `settingsSurface.test.ts` holds them against the
 * manifest, so neither a changed bound nor a changed default can leave one of the
 * three behind.
 */
export const NOTIFICATION_POLLING_INTERVAL_MIN_SECONDS = 60;
export const NOTIFICATION_POLLING_INTERVAL_MAX_SECONDS = 3600;
export const NOTIFICATION_POLLING_INTERVAL_DEFAULT_SECONDS = 300;

/**
 * Characters kept from one review comment body; the rest is announced in the
 * body itself.
 *
 * It lives here rather than only in the extension's MCP tools because more than
 * one surface needs this exact number and they cannot share an import: the AI
 * pre-review's brief cuts a model body to it, the host's confirmation-panel
 * handler enforces it again on the body a user edited in (`src/aiPreReviewPanel.ts`),
 * and the panel itself is webview code, whose bundle must not reach the host's
 * module graph. A webview that hard-coded the number would drift the day this one
 * changes, and a body the panel believed was legal would then be refused by the
 * host for no visible reason.
 */
export const PR_REVIEW_MAX_COMMENT_LENGTH = 1024;
