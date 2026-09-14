import { describe, it, expect } from 'vitest';
import { resolveReviewCommentLine } from '../reviewCommentPosition';

describe('resolveReviewCommentLine', () => {
  it('resolves right-side comments from position (new file line)', () => {
    expect(resolveReviewCommentLine({ position: 5, original_position: 0 })).toEqual({
      side: 'head',
      line: 4,
      extraLines: 0,
    });
    expect(resolveReviewCommentLine({ position: 5 })).toEqual({ side: 'head', line: 4, extraLines: 0 });
  });

  it('resolves left-side comments from original_position (old file line)', () => {
    expect(resolveReviewCommentLine({ position: 0, original_position: 3 })).toEqual({
      side: 'base',
      line: 2,
      extraLines: 0,
    });
    expect(resolveReviewCommentLine({ original_position: 3 })).toEqual({ side: 'base', line: 2, extraLines: 0 });
  });

  it('prefers position when both are non-zero', () => {
    expect(resolveReviewCommentLine({ position: 7, original_position: 2 })).toEqual({
      side: 'head',
      line: 6,
      extraLines: 0,
    });
  });

  it('returns undefined when neither side has a line number', () => {
    expect(resolveReviewCommentLine({})).toBeUndefined();
    expect(resolveReviewCommentLine({ position: 0, original_position: 0 })).toBeUndefined();
  });

  it('carries extra_lines_count as additional lines after the anchor', () => {
    // Forgejo anchors multi-line comments at the FIRST line of the range and
    // extends it forward by extra_lines_count.
    expect(resolveReviewCommentLine({ position: 5, extra_lines_count: 3 })).toEqual({
      side: 'head',
      line: 4,
      extraLines: 3,
    });
    expect(resolveReviewCommentLine({ original_position: 7, extra_lines_count: 2 })).toEqual({
      side: 'base',
      line: 6,
      extraLines: 2,
    });
  });

  it('treats a missing or negative extra_lines_count as a single-line comment', () => {
    expect(resolveReviewCommentLine({ position: 5, extra_lines_count: -1 })).toEqual({
      side: 'head',
      line: 4,
      extraLines: 0,
    });
  });
});
