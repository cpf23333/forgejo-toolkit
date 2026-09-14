import type { PullReviewComment } from '@cpf23333-forgejo-toolkit/api';

export type ReviewCommentSide = 'base' | 'head';

export interface ResolvedReviewCommentLine {
  /** Which side of the diff the comment belongs to. */
  side: ReviewCommentSide;
  /** 0-based anchor line (first line of the range) in that side's file. */
  line: number;
  /**
   * Additional lines after the anchor (0 = single-line comment). The range
   * covers `line` .. `line + extraLines`, matching Forgejo's anchor
   * semantics: `position`/`original_position` is the first line and
   * `extra_lines_count` extends the range forward.
   */
  extraLines: number;
}

/**
 * Resolve a Forgejo pull review comment to a file line range.
 *
 * Forgejo reports comment positions as 1-based file line numbers (not
 * GitHub-style diff positions): `position` is the line in the head (new)
 * file, `original_position` the line in the base (old) file. Left-side
 * comments have `position` 0/empty and a non-zero `original_position`;
 * right-side comments have `original_position` 0/empty and a non-zero
 * `position`. For multi-line comments the position is the first line of the
 * range and `extra_lines_count` gives the additional lines after it.
 */
export function resolveReviewCommentLine(
  comment: Pick<PullReviewComment, 'position' | 'original_position' | 'extra_lines_count'>,
): ResolvedReviewCommentLine | undefined {
  const position = comment.position ?? 0;
  const originalPosition = comment.original_position ?? 0;
  const extraLines = Math.max(0, comment.extra_lines_count ?? 0);
  if (originalPosition > 0 && position === 0) {
    return { side: 'base', line: originalPosition - 1, extraLines };
  }
  if (position > 0) {
    return { side: 'head', line: position - 1, extraLines };
  }
  return undefined;
}
