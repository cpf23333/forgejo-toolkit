import { describe, it, expect } from 'vitest';
import { resolveReviewCommentLine } from '../reviewCommentPosition';

describe('resolveReviewCommentLine', () => {
  it('resolves right-side comments from position (new file line)', () => {
    expect(resolveReviewCommentLine({ position: 5, original_position: 0 })).toEqual({ side: 'head', line: 4 });
    expect(resolveReviewCommentLine({ position: 5 })).toEqual({ side: 'head', line: 4 });
  });

  it('resolves left-side comments from original_position (old file line)', () => {
    expect(resolveReviewCommentLine({ position: 0, original_position: 3 })).toEqual({ side: 'base', line: 2 });
    expect(resolveReviewCommentLine({ original_position: 3 })).toEqual({ side: 'base', line: 2 });
  });

  it('prefers position when both are non-zero', () => {
    expect(resolveReviewCommentLine({ position: 7, original_position: 2 })).toEqual({ side: 'head', line: 6 });
  });

  it('returns undefined when neither side has a line number', () => {
    expect(resolveReviewCommentLine({})).toBeUndefined();
    expect(resolveReviewCommentLine({ position: 0, original_position: 0 })).toBeUndefined();
  });
});
