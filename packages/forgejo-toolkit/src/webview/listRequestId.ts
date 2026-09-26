/**
 * The request id to echo on a dashboard list reply (`repositories`, `myIssues`,
 * `myPullRequests`).
 *
 * The id is opaque to the host: it is echoed verbatim on both the success and
 * the failure reply so the webview can attribute the reply to the request it
 * sent instead of guessing by arrival order (an instance edit keeps the id, so
 * the replaced server's reply and the reload's reply are otherwise identical).
 * It is echoed only when the request actually carried a string: a webview build
 * that predates the field still gets a reply it can route — the reply simply
 * carries no id and the webview falls back to its per-instance queue.
 *
 * Both dispatchers that answer `getRepositories` share this: the sidebar
 * provider, and the setup-guide panel, which serves the same command because
 * the guide probes it right after a save (a token can pass `/user` and still
 * miss `read:repository`). A reply from either one has to carry the id, or the
 * guide's slot can only be matched by arrival order.
 */
export function echoedListRequestId(message: any): { _requestId?: string } {
  return typeof message?._requestId === 'string' ? { _requestId: message._requestId } : {};
}
