/**
 * The back-link a rendered comment thread carries so the reply command can tell
 * which anchor a submitted reply belongs to.
 *
 * `vscode.CommentThread` has one `contextValue`, and the reply command receives
 * the thread (plus the reply text) — so the thread, not the comment, has to
 * carry the anchor. The value is stored on threads this controller creates and
 * is read back by the reply handler; `CommentThread.canReply` alone would leave
 * the handler without any way to name the path, line and side to append to.
 *
 * The anchor is deliberately **not** a comment id: the thread shows every
 * comment of one anchor (an anchor's comments are one conversation, exactly as
 * the web UI shows them), so naming one of them would make the reply's anchor
 * depend on which comment happened to be rendered last.
 */
export interface PullReviewReplyTarget {
  instanceId: string;
  owner: string;
  repo: string;
  index: number;
  path: string;
  /** 1-based line in the side's file, as Forgejo's create API wants it. */
  position: number;
  /** `extra_lines_count`: additional lines after `position`. */
  extraLinesCount: number;
  /** True when `position` is a line in the base (old) file. */
  isBase: boolean;
}

/**
 * Version marker of the encoded shape. A value without it is not a target this
 * version wrote, and decoding it fails closed rather than reinterpreting it.
 */
const REPLY_TARGET_VERSION = 1;

/** JSON keeps the value unambiguous even when a path contains `:` or `-`. */
export function encodePullReviewReplyTarget(target: PullReviewReplyTarget): string {
  return JSON.stringify([
    REPLY_TARGET_VERSION,
    target.instanceId,
    target.owner,
    target.repo,
    target.index,
    target.path,
    target.position,
    target.extraLinesCount,
    target.isBase,
  ]);
}

/** Decode a thread's `contextValue`; `undefined` when it is not our target. */
export function decodePullReviewReplyTarget(value: string | undefined): PullReviewReplyTarget | undefined {
  if (!value) {
    return undefined;
  }
  let parts: unknown;
  try {
    parts = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parts) || parts.length !== 9 || parts[0] !== REPLY_TARGET_VERSION) {
    return undefined;
  }
  const [, instanceId, owner, repo, index, path, position, extraLinesCount, isBase] = parts as unknown[];
  if (
    typeof instanceId !== 'string' ||
    typeof owner !== 'string' ||
    typeof repo !== 'string' ||
    typeof path !== 'string' ||
    typeof index !== 'number' ||
    typeof position !== 'number' ||
    typeof extraLinesCount !== 'number' ||
    typeof isBase !== 'boolean'
  ) {
    return undefined;
  }
  if (!Number.isInteger(index) || !Number.isInteger(position) || !Number.isInteger(extraLinesCount)) {
    return undefined;
  }
  if (position < 1 || extraLinesCount < 0) {
    return undefined;
  }
  return { instanceId, owner, repo, index, path, position, extraLinesCount, isBase };
}
