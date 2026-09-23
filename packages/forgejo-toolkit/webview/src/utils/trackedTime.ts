/**
 * Helpers for the tracked-time panel shared by the issue and pull request detail
 * views. They encode what the Forgejo API actually does, which the panel used to
 * get wrong in two ways: it offered a delete button for entries that can only
 * answer 403, and it presented a possibly-personal sum as the issue's total.
 */

/**
 * `DELETE /repos/{owner}/{repo}/issues/{index}/times/{id}` accepts the record's
 * owner or a site administrator — a repository admin is not enough. The webview
 * cannot tell whether the signed-in user is a site admin, so only the caller's
 * own entries get the button; a site admin loses it as well, which is the lesser
 * evil compared with an action that always fails.
 */
export function canDeleteTrackedTime(userName: string | undefined, currentUsername: string | undefined): boolean {
  // Without both names nothing can be compared; leave the decision to the server.
  if (!userName || !currentUsername) {
    return true;
  }
  return userName === currentUsername;
}

/**
 * Whether the listed entries are the issue's complete tracked time.
 *
 * `GET .../times` is sent without a `user` filter, and the server then returns
 * every entry only to the issue's writer (author or repository admin) and to site
 * administrators; everybody else is silently narrowed to their own rows. So the
 * list is provably complete when the caller authored the issue, or when it
 * already contains an entry from somebody else — only a caller who sees
 * everything can be looking at one. Any other case may be a personal subset, and
 * the panel labels it as such rather than overstating the total.
 */
export function isTrackedTimeTotal(
  entries: { user_name?: string }[],
  currentUsername: string | undefined,
  isIssueAuthor: boolean,
): boolean {
  if (isIssueAuthor) {
    return true;
  }
  if (!currentUsername) {
    return false;
  }
  return entries.some((entry) => entry.user_name !== undefined && entry.user_name !== currentUsername);
}

interface StopwatchLike {
  repo_owner_name?: string;
  repo_name?: string;
  issue_index?: number;
}

/**
 * A stopwatch that runs somewhere other than the given issue.
 *
 * Stopwatches are unique per user, not per issue: starting one here ends the one
 * running elsewhere and records that elapsed time against the other issue. The
 * panel surfaces this so the button is not a silent ambush.
 */
export function findStopwatchElsewhere<T extends StopwatchLike>(
  stopwatches: T[],
  current: { owner: string; repo: string; index: number },
): T | undefined {
  return stopwatches.find(
    (stopwatch) =>
      !(
        stopwatch.repo_owner_name === current.owner &&
        stopwatch.repo_name === current.repo &&
        stopwatch.issue_index === current.index
      ),
  );
}
