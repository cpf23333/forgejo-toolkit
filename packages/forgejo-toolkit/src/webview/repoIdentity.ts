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
 * True when a repository file path from the webview is safe to interpolate into
 * the contents API route.
 *
 * Unlike a name segment, a path keeps its `/` separators, so only the dangerous
 * shapes are rejected: absolute or drive-relative prefixes, backslashes,
 * empty/`.`/`..` segments (whose percent-encoded forms the URL parser also
 * resolves), and characters that would end the path (`?`, `#`).
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
  if (value.includes('\\') || value.includes('?') || value.includes('#')) {
    return false;
  }
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}
