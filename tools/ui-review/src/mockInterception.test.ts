// The mock-backed run's one invariant, tested against the real handlers:
// **a mock-backed run never reaches the network.**
//
// The measured defect (2026-10-05) was not a missing handler. Every handler was
// registered for `https://*/api/v1/…` while the isolated profile this harness
// seeds holds plain `http://` instances, so MSW matched nothing, `server.ts`'s
// `onUnhandledRequest` warned and passed the request on (that is its
// documented dev-host behaviour), and a run whose first line read
// `Mock-backed run: mock API compiled in …` polled a real Forgejo server.
//
// Every test here drives the **real** mock server (`src/test/mocks/server.ts`,
// the module `extension.ts` starts) and asserts two things at once:
//
//   1. the answer is the fixture's, i.e. a handler served it; and
//   2. `unhandledRequests()` is empty, i.e. nothing fell through to the network.
//
// Assertion 1 alone would be enough against a live server (a real instance
// answers neither `demo-user` nor `demo-repo`), but the pair is what makes the
// failure message say which half broke.
//
// The URLs are placeholder hosts on purpose (`AGENTS.md`): the requests are
// intercepted before any DNS lookup, so nothing here needs to resolve.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  mockRepository,
  mockRepository2,
  mockRepositoryFail,
} from '../../../packages/forgejo-toolkit/src/test/mocks/data/repositories.ts';
import { mockUser } from '../../../packages/forgejo-toolkit/src/test/mocks/data/users.ts';
import {
  clearUnhandledRequests,
  startMockServer,
  stopMockServer,
  unhandledRequests,
} from '../../../packages/forgejo-toolkit/src/test/mocks/server.ts';

before(async () => {
  await startMockServer();
});

after(() => {
  stopMockServer();
});

interface Served {
  status: number;
  body: string;
}

/**
 * Fetches `url` and proves the mock server (not the network) answered.
 *
 * A response that no handler produced is either a passthrough to a real host or
 * MSW's own 500 for an unmatched request; both are failures here, and the
 * recorded list names the request so the message is specific.
 */
async function fetchMocked(url: string, init?: RequestInit): Promise<Served> {
  const response = await fetch(url, init);
  const body = await response.text();
  assert.deepEqual(unhandledRequests(), [], `no request may reach the network; ${url} did`);
  assert.notEqual(response.status, 500, `MSW answered its unmatched-request error for ${url}: ${body.slice(0, 200)}`);
  return { status: response.status, body };
}

test('an http:// instance is served by the handlers', async () => {
  const served = await fetchMocked('http://127.0.0.1:3999/api/v1/user');
  assert.equal(served.status, 200);
  assert.equal((JSON.parse(served.body) as { login?: string }).login, mockUser.login);
  assert.deepEqual(unhandledRequests(), []);
});

test('the https:// instance the unit suites use is still served', async () => {
  const served = await fetchMocked('https://forgejo.example.com/api/v1/user');
  assert.equal((JSON.parse(served.body) as { login?: string }).login, mockUser.login);
  assert.deepEqual(unhandledRequests(), []);
});

test('an instance URL with a host and port is served, path and all', async () => {
  const served = await fetchMocked('http://127.0.0.1:3999/api/v1/user/repos');
  const repos = JSON.parse(served.body) as Array<{ name?: string }>;
  assert.deepEqual(
    repos.map((repo) => repo.name),
    [mockRepository.name, mockRepository2.name, mockRepositoryFail.name],
  );
  // The defect's other symptom: `/notifications` answered `[]` from a real
  // server while the fixtures carry entries, so an empty list is also a failure.
  const notifications = await fetchMocked('http://127.0.0.1:3999/api/v1/notifications');
  assert.notDeepEqual(JSON.parse(notifications.body), []);
});

test('a request no handler covers is recorded as unmatched, never silently sent', async () => {
  // The one shape `server.ts` deliberately keeps in a dev host: warn, record,
  // and let it through. Pinned here so the gate in `src/apiMode.ts` is the thing
  // that stops a profile from reaching that state, not this file.
  await fetch('http://127.0.0.1:3999/api/v1/not-a-mocked-endpoint').catch(() => undefined);
  assert.deepEqual(unhandledRequests(), ['GET http://127.0.0.1:3999/api/v1/not-a-mocked-endpoint']);
  // Forgot on purpose: `after` calls `stopMockServer`, which fails a suite that
  // left an unmatched request behind. This test is the one that produced it, and
  // it has just asserted what it was.
  clearUnhandledRequests();
});
