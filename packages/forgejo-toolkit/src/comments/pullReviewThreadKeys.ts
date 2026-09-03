export interface PullReviewThreadScope {
  instanceId: string;
  owner: string;
  repo: string;
  index: number;
  path: string;
  /**
   * Which side of the diff the rendered document shows. Cleanup must not
   * dispose the other side's threads when one side re-renders, so the side
   * is part of both the key and the cleanup scope.
   */
  isBase: boolean;
}

/**
 * Build the map key for a comment thread. JSON serialization keeps the key
 * unambiguous even when a path contains characters such as `:`.
 */
export function pullReviewThreadKey(scope: PullReviewThreadScope, reviewId: number, commentId: number): string {
  return JSON.stringify([
    scope.instanceId,
    scope.owner,
    scope.repo,
    scope.index,
    scope.path,
    scope.isBase,
    reviewId,
    commentId,
  ]);
}

/**
 * Check whether a thread key belongs to the given document scope
 * (instance + repo + PR + file path + diff side), so cleanup only disposes
 * threads of the document being re-rendered instead of every open thread.
 */
export function pullReviewThreadMatchesScope(key: string, scope: PullReviewThreadScope): boolean {
  let parts: unknown;
  try {
    parts = JSON.parse(key);
  } catch {
    return false;
  }
  if (!Array.isArray(parts)) {
    return false;
  }
  return (
    parts[0] === scope.instanceId &&
    parts[1] === scope.owner &&
    parts[2] === scope.repo &&
    parts[3] === scope.index &&
    parts[4] === scope.path &&
    parts[5] === scope.isBase
  );
}
