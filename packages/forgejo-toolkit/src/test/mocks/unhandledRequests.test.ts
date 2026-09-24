import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { clearUnhandledRequests, resetMockServer, startMockServer, stopMockServer, unhandledRequests } from './server';

// `onUnhandledRequest: 'warn'` used to print a warning and then pass the request
// to the real network, so a test could pass while depending on it. These tests
// keep the strict replacement: the request fails, and it is recorded so a suite
// cannot ignore it either.
describe('Mock server without a matching handler', () => {
  beforeAll(() => {
    startMockServer();
  });

  afterAll(() => {
    stopMockServer();
  });

  afterEach(() => {
    // Clear before resetting: resetMockServer() asserts the same record, and
    // this test is the one that produced the entry.
    clearUnhandledRequests();
    resetMockServer();
  });

  it('answers an unmatched request with an error instead of passing it to the network', async () => {
    const response = await fetch('https://forgejo.example.com/api/v1/not-mocked');

    expect(response.ok).toBe(false);
    expect(response.status).toBe(500);
    expect(unhandledRequests()).toEqual(['GET https://forgejo.example.com/api/v1/not-mocked']);
  });

  it('fails the suite even when the unhandled request is swallowed', async () => {
    // A test that ignores the failure must still fail the run: resetMockServer
    // runs in afterEach and reports every recorded request.
    await fetch('https://forgejo.example.com/api/v1/not-mocked').catch(() => undefined);

    expect(() => resetMockServer()).toThrow(/without a matching handler/);
    expect(unhandledRequests()).toEqual([]);
  });
});
