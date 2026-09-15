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
  /**
   * The revision (sha) the rendered document was fetched at. After a
   * force-push the same file/PR re-opens at a new ref; without the ref in
   * the key the old and new documents would share thread keys and overwrite
   * or dispose each other's threads.
   */
  ref: string;
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
    scope.ref,
    reviewId,
    commentId,
  ]);
}

/**
 * Check whether a thread key belongs to the given document scope
 * (instance + repo + PR + file path + diff side + revision), so cleanup only
 * disposes threads of the document being re-rendered instead of every open
 * thread. Keys without a ref part (older format) never match, which is safe:
 * they simply cannot be cleaned up by a re-render of a different revision.
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
    parts[5] === scope.isBase &&
    parts[6] === scope.ref
  );
}
