/**
 * The Forgejo Actions run/job status vocabulary, shared by the run list and the
 * run detail view.
 *
 * `models/actions/status.go` defines exactly: `unknown`, `waiting`, `running`,
 * `success`, `failure`, `cancelled`, `skipped` and `blocked`. The views used to
 * carry their own copies that also listed GitHub's `pending`/`requested` (which
 * never arrive) and missed `blocked` — the "waiting for approval" state — so a
 * blocked run rendered as an unknown icon and could not be cancelled even though
 * the API accepts it.
 */
export function actionStatusIcon(status?: string): string {
  switch (status) {
    case 'success':
      return 'check';
    case 'failure':
    case 'error':
      return 'error';
    case 'running':
      return 'sync';
    case 'waiting':
      return 'watch';
    case 'blocked':
      return 'lock';
    case 'cancelled':
      return 'circle-slash';
    case 'skipped':
      return 'debug-step-over';
    default:
      return 'question';
  }
}

export function actionStatusClass(status?: string): string {
  return status ?? 'unknown';
}

export function isActionStatusFailed(status?: string): boolean {
  return status === 'failure' || status === 'error';
}

/**
 * Whether a run has reached a state that will not change again. Used by the run
 * detail view to decide whether there is anything left to poll for.
 */
export function isActionStatusFinal(status?: string): boolean {
  return (
    status === 'success' || status === 'failure' || status === 'error' || status === 'cancelled' || status === 'skipped'
  );
}

/**
 * Whether the run detail view's poll interval should be running.
 *
 * Asking only `isActionStatusFinal(run.status)` is not enough: a run that fails
 * to load stores no entry in `actionRunDetails` (the composable writes one only
 * on success), so `run.status` is `undefined`, the status is not final, and the
 * interval kept refetching the failing request forever. A load error is
 * therefore a stop condition of its own.
 */
export function shouldPollActionRun(status?: string, hasLoadError = false): boolean {
  return !hasLoadError && !isActionStatusFinal(status);
}

/**
 * A run can be cancelled while it is not in a final state. The server accepts
 * `cancel` for `unknown`, `waiting`, `running` and `blocked` (a done run is
 * simply left alone and still answers 204), so those are the statuses that should
 * offer the button — `blocked` included, since cancelling is the only way out of
 * a run that waits for approval.
 */
export function isActionRunCancellable(status?: string): boolean {
  return status === 'unknown' || status === 'waiting' || status === 'running' || status === 'blocked';
}

/**
 * Only a finished run may be deleted: `services/actions/run.go` rejects anything
 * else and the handler maps that error to 500, so the button must not appear for
 * a queued, running or blocked run (the statuses `IsDone()` excludes).
 */
export function isActionRunDeletable(status?: string): boolean {
  return status === 'success' || status === 'failure' || status === 'cancelled' || status === 'skipped';
}
