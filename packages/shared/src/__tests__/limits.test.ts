import { describe, expect, it } from 'vitest';
import { LIST_ITEM_LIMIT, isListTruncated, isListTruncatedWithTotal } from '../limits';

/** A list of `length` placeholder rows. */
function rows(length: number): unknown[] {
  return Array.from({ length }, () => ({}));
}

describe('isListTruncated', () => {
  it('flags a list at the cap and stays quiet below it', () => {
    // The host truncates every paged list at this length without a total, so the
    // webview derives the notice from the length.
    expect(isListTruncated(rows(LIST_ITEM_LIMIT))).toBe(true);
    expect(isListTruncated(rows(LIST_ITEM_LIMIT - 1))).toBe(false);
    expect(isListTruncated([])).toBe(false);
  });
});

describe('isListTruncatedWithTotal', () => {
  it('calls a list whole when its length equals the server total, however long', () => {
    // The regression the total exists for: a complete list that happens to hold
    // exactly the cap is not a truncated one.
    expect(isListTruncatedWithTotal(rows(LIST_ITEM_LIMIT), LIST_ITEM_LIMIT)).toBe(false);
    expect(isListTruncatedWithTotal(rows(3), 3)).toBe(false);
    // A read that overshot the cap (a server that clamps the page size) is still
    // complete when the total agrees with what came back.
    expect(isListTruncatedWithTotal(rows(510), 510)).toBe(false);
  });

  it('calls a list shorter than the server total truncated', () => {
    expect(isListTruncatedWithTotal(rows(LIST_ITEM_LIMIT), 600)).toBe(true);
    expect(isListTruncatedWithTotal(rows(510), 800)).toBe(true);
    expect(isListTruncatedWithTotal([], 1)).toBe(true);
  });

  it('falls back to the length heuristic when the server reported no total', () => {
    expect(isListTruncatedWithTotal(rows(LIST_ITEM_LIMIT), undefined)).toBe(true);
    expect(isListTruncatedWithTotal(rows(LIST_ITEM_LIMIT - 1), undefined)).toBe(false);
    expect(isListTruncatedWithTotal([], undefined)).toBe(false);
  });
});
