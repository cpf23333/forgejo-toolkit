import { setupServer } from 'msw/node';
import { handlers, resetMockState } from './handlers';

export const mockServer = setupServer(...handlers);

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
  mockServer.listen({ onUnhandledRequest: 'warn' });
  await new Promise((resolve) => setImmediate(resolve));
}

export function stopMockServer(): void {
  mockServer.close();
}

export function resetMockServer(): void {
  mockServer.resetHandlers(...handlers);
  resetMockState();
}
