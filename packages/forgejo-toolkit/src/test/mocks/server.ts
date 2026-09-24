import { setupServer } from 'msw/node';
import { handlers, resetMockState } from './handlers';

export const mockServer = setupServer(...handlers);

/**
 * Requests MSW intercepted without a matching handler, as `METHOD origin/path`
 * (no query string: it may carry a token). Recorded so a suite can prove that
 * nothing reached the network, and so a dev-host gap is diagnosable from a log.
 */
const unhandled: string[] = [];

/**
 * The only requests allowed to reach the real network, as URL prefixes, with the
 * reason they are allowed. Empty on purpose: every request the extension makes
 * is (or must be) covered by a handler in `handlers.ts`, so a test that passes
 * here cannot silently depend on the network. Add an entry only with a comment
 * saying why the request cannot be mocked — never to silence a failure.
 */
const PASSTHROUGH_URLS: readonly string[] = [];

/** The unhandled requests recorded since the last reset, oldest first. */
export function unhandledRequests(): string[] {
  return [...unhandled];
}

/** Forgets the recorded unhandled requests, for tests that assert on them. */
export function clearUnhandledRequests(): void {
  unhandled.length = 0;
}

function describeRequest(request: Request): string {
  const url = new URL(request.url);
  return `${request.method} ${url.origin}${url.pathname}`;
}

function isTestRun(): boolean {
  return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
}

/**
 * Reacts to a request no handler matched.
 *
 * In a test run this throws: `onUnhandledRequest: 'warn'` printed a warning and
 * then let the request through, so a test could pass while its request went to
 * the real network (the version probe and the notification poller both issue
 * requests on activation). msw answers the failing request with its own error
 * response (500) instead of forwarding it; the recorded entry then fails the
 * suite through `assertNoUnhandledRequests`, so a caller that swallowed the
 * failure still cannot pass.
 *
 * Outside a test run (the offline dev host started by `extension.ts`) this only
 * records and warns: the dev host must stay usable when the UI asks for
 * something the fixtures do not cover, and the passthrough it always had keeps
 * behaving as before.
 */
function handleUnhandledRequest(request: Request, print: { warning: () => void }): void {
  const entry = describeRequest(request);
  if (PASSTHROUGH_URLS.some((prefix) => entry.startsWith(prefix))) {
    return;
  }
  unhandled.push(entry);
  print.warning();
  if (isTestRun()) {
    throw new Error(
      `[mocks] no handler matched ${entry}; add one in src/test/mocks/handlers.ts ` +
        '(a test must never reach the real network).',
    );
  }
}

function assertNoUnhandledRequests(): void {
  if (unhandled.length === 0) {
    return;
  }
  const entries = unhandled.join('\n  ');
  unhandled.length = 0;
  throw new Error(
    `[mocks] ${entries.split('\n').length} request(s) without a matching handler:\n  ${entries}\n` +
      'Add a handler in src/test/mocks/handlers.ts (or, only with a documented reason, ' +
      'a PASSTHROUGH_URLS entry in server.ts).',
  );
}

/**
 * Starts request interception and resolves once it is actually installed.
 *
 * `mockServer.listen()` returns `void`: msw applies its interceptors
 * asynchronously, so a request issued in the same tick (the extension's
 * notification poller, the server-version probe) would bypass the mocks and hit
 * the real network. Awaiting one macrotask gives the interceptor time to patch
 * fetch before activation continues.
 */
export async function startMockServer(): Promise<void> {
  clearUnhandledRequests();
  mockServer.listen({ onUnhandledRequest: handleUnhandledRequest });
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Stops interception, failing when a request went unmatched while the server
 * was up: a suite that reached the network must not report success.
 */
export function stopMockServer(): void {
  mockServer.close();
  assertNoUnhandledRequests();
}

export function resetMockServer(): void {
  mockServer.resetHandlers(...handlers);
  resetMockState();
  // Between tests, so the test that issued the unmatched request is the one
  // that fails, with its own name in the report.
  assertNoUnhandledRequests();
}
