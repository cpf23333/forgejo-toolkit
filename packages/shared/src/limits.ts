/**
 * How many items a paged list returns. A list at this length may have been cut off:
 * the generated client does not expose the response headers a total would live in.
 */
export const LIST_ITEM_LIMIT = 500;

/** Whether a list reached the cap and may therefore be incomplete. */
export function isListTruncated(items: readonly unknown[]): boolean {
  return items.length >= LIST_ITEM_LIMIT;
}
