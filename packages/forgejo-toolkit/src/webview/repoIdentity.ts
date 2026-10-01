/**
 * Validation for the repository identity a webview sends back to the host.
 *
 * `owner`/`repo` are interpolated verbatim into API paths
 * (`/repos/${owner}/${repo}/…`) and, for worktree commands, into cache
 * directory names. The URL parser resolves dot segments and splits the path on
 * `?`/`#`, and `path.join` normalises `..`, so an unvalidated value turns a
 * repository-scoped command into an arbitrary same-origin request (or an
 * arbitrary filesystem path). Forgejo restricts usernames and repository names
 * to letters, digits, `-`, `_` and `.`, so anything else is rejected rather
 * than escaped — escaping would not help for the filesystem case.
 */
export function isSafeRepoNameSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    /^[A-Za-z0-9._-]+$/.test(value) &&
    value !== '.' &&
    value !== '..'
  );
}

/**
 * True when a webview message either does not name a repository (fields absent
 * or empty) or names one whose fields are safe to use. Some messages carry only
 * one of the pair (owner-scoped listings), so each field is checked on its own;
 * an empty value cannot escape the path and is therefore equivalent to "not
 * provided".
 */
export function isSafeRepoIdentity(owner: unknown, repo: unknown): boolean {
  const absentOrSafe = (value: unknown): boolean => value === undefined || value === '' || isSafeRepoNameSegment(value);
  return absentOrSafe(owner) && absentOrSafe(repo);
}

/**
 * Control characters (C0 and C1, including NUL) have no place in a URL path:
 * the server rejects them or silently drops them. `\p{Cc}` is used instead of a
 * code-point range so the C1 block is covered too.
 */
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

/**
 * The coordinates of one pull request.
 *
 * It deliberately stops at the four fields needed in order to address a pull
 * request: the instance (an opaque id the host resolves to a URL and a token),
 * the repository pair and the index. Nothing about the diff, the file or the
 * review is part of it — a value that could name those would be a value that
 * could steer a run.
 *
 * Both doors into a pull-request-wide action carry exactly this: the
 * `forgejo-pr` diff URI, which `parseForgejoPrUri` reads (its result is
 * assignable to this type), and the dashboard's `aiPreReviewPullRequest`
 * message, which {@link parseWebviewPullRequestTarget} validates.
 */
export interface PullRequestTarget {
  instanceId: string;
  owner: string;
  repo: string;
  index: number;
}

/**
 * The pull-request coordinates of a webview message, or `undefined` when the
 * message does not name a valid one.
 *
 * It exists because a dashboard action now starts a whole-pull-request run from
 * a message rather than from a diff document: `parseForgejoPrUri` validates the
 * coordinates a URI carries, and a message has no URI to parse, so it needs the
 * same strictness here. `owner`/`repo` go through `isSafeRepoNameSegment` for the
 * reason that helper documents (they are interpolated into API paths), and
 * `index` is required to be a positive integer for the same reason
 * `parseForgejoPrUri` refuses anything else: `Number(...)` alone accepts `true`
 * (→ 1) and `null` (→ 0), and "PR 0" names no pull request.
 *
 * `instanceId` is checked only for presence and type: it is an opaque id this
 * extension derives, the host resolves it against the configured instances, and
 * an unknown but well-formed id is answered by the run's own "instance not found"
 * refusal rather than by a second rule invented here.
 */
export function parseWebviewPullRequestTarget(value: unknown): PullRequestTarget | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as Partial<PullRequestTarget>;
  const { instanceId, owner, repo, index } = candidate;
  if (typeof instanceId !== 'string' || instanceId.length === 0 || instanceId.length > 255) {
    return undefined;
  }
  if (!isSafeRepoNameSegment(owner) || !isSafeRepoNameSegment(repo)) {
    return undefined;
  }
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 1) {
    return undefined;
  }
  return { instanceId, owner, repo, index };
}

/**
 * True when a repository file path from the webview is safe to interpolate into
 * the contents API route.
 *
 * Unlike a name segment, a path keeps its `/` separators, and the client
 * percent-encodes each segment (`encodeURIComponent`) before building the
 * route, so everything encoding can neutralise is allowed — including `?` and
 * `#`, which are legal characters in a git file name and would otherwise make
 * such a file impossible to open. Only the shapes that survive encoding are
 * rejected: absolute or drive-relative prefixes, backslashes (the URL parser
 * normalises `\` to `/` for http(s), so `a\..\..\admin` still traverses),
 * empty/`.`/`..` segments (whose percent-encoded forms it resolves too), and
 * control characters.
 */
export function isSafeRepoPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) {
    return false;
  }
  // The repository root is addressed with an empty path.
  if (value === '') {
    return true;
  }
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  if (value.includes('\\') || CONTROL_CHARACTER_PATTERN.test(value)) {
    return false;
  }
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}
