import type { PullReviewComment } from '@cpf23333-forgejo-toolkit/api';

export type ReviewCommentSide = 'base' | 'head';

export interface ResolvedReviewCommentLine {
  /** Which side of the diff the comment belongs to. */
  side: ReviewCommentSide;
  /** 0-based line number in that side's file. */
  line: number;
}

/**
 * Resolve a Forgejo pull review comment to a file line.
 *
 * Forgejo reports comment positions as 1-based file line numbers (not
 * GitHub-style diff positions): `position` is the line in the head (new)
 * file, `original_position` the line in the base (old) file. Left-side
 * comments have `position` 0/empty and a non-zero `original_position`;
 * right-side comments have `original_position` 0/empty and a non-zero
 * `position`.
 */
export function resolveReviewCommentLine(
  comment: Pick<PullReviewComment, 'position' | 'original_position'>,
): ResolvedReviewCommentLine | undefined {
  const position = comment.position ?? 0;
  const originalPosition = comment.original_position ?? 0;
  if (originalPosition > 0 && position === 0) {
    return { side: 'base', line: originalPosition - 1 };
  }
  if (position > 0) {
    return { side: 'head', line: position - 1 };
  }
  return undefined;
}
