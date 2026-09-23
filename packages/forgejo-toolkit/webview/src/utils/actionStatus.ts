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
 * A run can be cancelled while it is not in a final state. The server accepts
 * `cancel` for `unknown`, `waiting`, `running` and `blocked` (a done run is
 * simply left alone and still answers 204), so those are the statuses that should
 * offer the button — `blocked` included, since cancelling is the only way out of
 * a run that waits for approval.
 */
export function isActionRunCancellable(status?: string): boolean {
  return status === 'unknown' || status === 'waiting' || status === 'running' || status === 'blocked';
}
