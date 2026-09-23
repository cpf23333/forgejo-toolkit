import { describe, expect, it } from 'vitest';
import { LIST_ITEM_LIMIT, isListTruncated } from '../limits';

describe('isListTruncated', () => {
  it('flags a list at the cap and stays quiet below it', () => {
    // The host truncates every paged list at this length without a total, so the
    // webview derives the notice from the length.
    expect(isListTruncated(Array.from({ length: LIST_ITEM_LIMIT }, () => ({})))).toBe(true);
    expect(isListTruncated(Array.from({ length: LIST_ITEM_LIMIT - 1 }, () => ({})))).toBe(false);
    expect(isListTruncated([])).toBe(false);
  });
});
