import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { ForgejoClient } from '../client';
import { mockServer, resetMockServer, startMockServer, stopMockServer } from '../../test/mocks/server';

/**
 * The path half of the wire format, asserted on the outgoing request rather than
 * on a serializer's return value.
 *
 * Kubb 5 percent-encodes every path parameter itself, where the v4 call layer
 * interpolated the value raw. Encoding is the right default — a branch named
 * `release/1.0` would otherwise split the route into two segments and reach a
 * different handler — but the migration had to preserve two exceptions, and
 * neither was covered until here:
 *
 * - `contents/{filepath}` is a wildcard route that matches the rest of the path,
 *   so its `/` separators must stay literal. Kubb's default percent-encodes the
 *   whole value, which turns `src/index.ts` into `src%2Findex.ts` and 404s every
 *   nested path. `slashPreservingPathSerializer` in `../client.ts` encodes that
 *   parameter one segment at a time instead.
 * - `.` and `..` are meant to be refused outright. `encodeURIComponent` leaves
 *   dots alone, and the URL parser resolves `.`/`..` as navigation, so a
 *   `filepath` of `../../../user/keys` would make the request escape the route
 *   it was built for. The v4 `encodePathSegment` refused those values and
 *   `slashPreservingPathSerializer` keeps that refusal for *every* string path
 *   parameter, `filepath` included; see the `dot-segment refusal` block below.
 *
 * The companion `requestSerialization.test.ts` covers the query string. This
 * file is separate so neither side's cases are buried in the other's history,
 * and it repeats the mock-server wiring rather than sharing a harness that would
 * have to be extracted from that file first.
 *
 * Two msw details these tests depend on, both established by probing this
 * version rather than assumed:
 *
 * - `mockServer.use()` *prepends*, so the handler registered last wins. Handlers
 *   are therefore registered least-specific-first, and a test that needs a
 *   precise match must not register a catch-all after it.
 * - A handler pattern is matched against the raw, percent-encoded path, not a
 *   decoded one: `contents/dir%20name/*` matches a request for `dir name/…`
 *   while `contents/dir name/*` does not. A catch-all `*` is also a real
 *   wildcard only when it stands alone as a segment (`/contents/*`, not
 *   `/contents/dir*`, where `*` is a zero-or-more quantifier on `r`).
 *
 * The distinction the slash cases turn on is *which* handler receives the
 * request, so each registers a competitor for the wrong shape and asserts the
 * URL that arrived. A `%2F` and a literal `/` both fail a single-segment
 * matcher, so reaching the handler is not on its own evidence; the captured URL
 * is.
 */
describe('path serialization parity', () => {
  beforeAll(() => {
    startMockServer();
  });

  afterAll(() => {
    stopMockServer();
  });

  afterEach(() => {
    resetMockServer();
  });

  /** A file entry, so a call that reads one resolves instead of parsing a listing. */
  function fileEntry() {
    return HttpResponse.json({
      name: 'a#b.txt',
      path: 'dir name/100%/a#b.txt',
      type: 'file',
      sha: 'nested-sha',
      size: 5,
      content: 'aGVsbG8=',
      encoding: 'base64',
    });
  }

  it('percent-encodes a single-segment parameter containing `/` and `#`, so the route does not move', async () => {
    // `release/1.0#2` on the `branches/{branch}` route has to reach the branch
    // handler as one segment. The wildcard handler below is the competing shape:
    // a literal `/` splits the value into two segments and lands there instead,
    // and the `#` would start a fragment and drop the rest of the URL. Which
    // handler receives the request, plus the `%2F`, is the whole assertion.
    let requestedUrl = '';
    let wrongHandler = '';
    mockServer.use(
      http.delete('https://*/api/v1/repos/:owner/:repo/branches/:branch', ({ request }) => {
        requestedUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete('https://*/api/v1/repos/:owner/:repo/branches/*', () => {
        wrongHandler = 'wildcard';
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await new ForgejoClient('https://forgejo.example.com', 'mock-token').deleteBranch(
      'demo-user',
      'demo-repo',
      'release/1.0#2',
    );

    expect(wrongHandler).toBe('');
    expect(requestedUrl).toBe(
      'https://forgejo.example.com/api/v1/repos/demo-user/demo-repo/branches/release%2F1.0%232',
    );
  });

  it('keeps the `/` separators of a wildcard parameter literal while encoding each segment', async () => {
    // `contents/{filepath}` matches the remainder of the path, so `dir name` and
    // `a#b.txt` must stay two segments — encoding the separator makes Forgejo
    // read `dir%20name%2F…` as a single file name in the repository root and
    // answer 404 for every nested path. A space, a `%` and a `#` inside a
    // segment still have to be escaped: a literal space ends the path, and a
    // `%` left alone would let the next two characters read as an escape.
    //
    // The handler expects the *nested* path, so it is only reached when the
    // separator stayed literal; a `%2F`-joined request falls through to the
    // catch-all and the captured URL then fails the assertion on both scores.
    let requestedUrl = '';
    let wrongHandler = '';
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/contents/dir%20name/*', ({ request }) => {
        requestedUrl = request.url;
        return fileEntry();
      }),
      http.get('https://*/api/v1/repos/:owner/:repo/contents/*', () => {
        wrongHandler = 'catch-all';
        return fileEntry();
      }),
    );

    await new ForgejoClient('https://forgejo.example.com', 'mock-token').getRepoContents(
      'demo-user',
      'demo-repo',
      'dir name/100%/a#b.txt',
    );

    expect(wrongHandler).toBe('');
    expect(requestedUrl).toBe(
      'https://forgejo.example.com/api/v1/repos/demo-user/demo-repo/contents/dir%20name/100%25/a%23b.txt',
    );
  });

  it('does not split a path parameter containing `/` into extra segments', async () => {
    // The v4 → v5 behaviour difference, on a route whose parameter is an
    // ordinary single segment: v4 interpolated the value, so `feature/x` became
    // two segments and matched the wildcard, not `{sha}`. `%2F` is not a
    // separator to the matcher, so the single-segment handler is the one that
    // receives it.
    let requestedUrl = '';
    let wrongHandler = '';
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/git/trees/:sha', ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json({ tree: [], truncated: false });
      }),
      http.get('https://*/api/v1/repos/:owner/:repo/git/trees/*', () => {
        wrongHandler = 'wildcard';
        return HttpResponse.json({ tree: [], truncated: false });
      }),
    );

    await new ForgejoClient('https://forgejo.example.com', 'mock-token').searchRepoFiles(
      'demo-user',
      'demo-repo',
      'feature/x',
      'readme',
    );

    expect(wrongHandler).toBe('');
    expect(requestedUrl).toContain('/api/v1/repos/demo-user/demo-repo/git/trees/feature%2Fx?');
    // A literal separator would have shown up as `trees/feature/x`, i.e. one
    // extra segment on a route that declares exactly one.
    expect(requestedUrl).not.toContain('trees/feature/x');
  });

  it('encodes a path parameter once, not twice', async () => {
    // The other direction of the same change: the v4 call layer pre-encoded path
    // parameters and Kubb 5 encodes them itself, so keeping both would send
    // `%252F` — a literal `%2F` in the ref rather than a separator — and no
    // handler would match it.
    let requestedUrl = '';
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/git/trees/:sha', ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json({ tree: [], truncated: false });
      }),
    );

    await new ForgejoClient('https://forgejo.example.com', 'mock-token').searchRepoFiles(
      'demo-user',
      'demo-repo',
      'release/1.0',
      'readme',
    );

    expect(requestedUrl).toContain('/api/v1/repos/demo-user/demo-repo/git/trees/release%2F1.0?');
    expect(requestedUrl).not.toContain('%252F');
  });
});

/**
 * The `.`/`..` refusal, separated from the parity block above because it answers
 * a different question: not how a value is rendered, but whether it is rendered
 * at all.
 *
 * `slashPreservingPathSerializer` used to run `assertSafePathSegments` only when
 * `args.name === 'filepath'`, so the guard covered the one path parameter that
 * cannot cause the problem it exists to prevent — a multi-segment `filepath`
 * value containing `.`/`..` renders as `..%2F..`, and the URL parser leaves a
 * percent-encoded slash alone — while it missed every single-segment parameter.
 * That is exactly where a bare `..` really does resolve: `encodeURIComponent`
 * leaves dots unescaped, so the assembled URL arrived at `new Request(...)` with
 * a literal `..` segment and was normalised away. The v4 call layer refused
 * `.`/`..` on those parameters (`encodePathSegment(sha)`,
 * `encodePathSegment(branch)`, …), so this was a regression the migration
 * introduced; the guard now checks *every* string path parameter again, and the
 * second test below covers the single-segment half of it. The consequences
 * observed while the hole was open were route escapes on the `..` value:
 * `GET /repos/{owner}/{repo}/git/trees/..` went out as
 * `GET /repos/{owner}/{repo}/git/`, and `DELETE
 * /repos/{owner}/{repo}/branches/..` went out as a DELETE on the repository
 * root, `/repos/{owner}/{repo}/`. (`../..` does not normalise — it stays a
 * literal segment — so only the bare `..` escaped, and `.` collapsed to a
 * trailing empty segment.)
 */
describe('dot-segment refusal', () => {
  beforeAll(() => {
    startMockServer();
  });

  afterAll(() => {
    stopMockServer();
  });

  afterEach(() => {
    resetMockServer();
  });

  it('refuses `.` and `..` in the wildcard parameter the guard does cover', async () => {
    // The refusal happens while the URL is built, so no request is issued at
    // all. A non-refusing implementation would send `contents/..%2F..`, which
    // the parser leaves literal, and the call would resolve instead of throwing.
    const client = new ForgejoClient('https://forgejo.example.com', 'mock-token');

    await expect(client.getFileContent('demo-user', 'demo-repo', '../..')).rejects.toThrow('Unsafe path segment: ..');
    await expect(client.getFileContent('demo-user', 'demo-repo', '.')).rejects.toThrow('Unsafe path segment: .');
  });

  it('refuses `.` and `..` in a single-segment parameter, and issues no request (REGRESSION FIXED)', async () => {
    // Reachable from `deleteBranch`, whose `branch` is the `branches/{branch}`
    // parameter. The guard restored above covers that parameter too, so the call
    // rejects while the URL is still being built and nothing leaves the client.
    // While the hole was open the assembled path `branches/..` was resolved as
    // navigation by the URL parser: the branch route disappeared and the DELETE
    // landed on the repository root instead. The catch-all is registered first
    // because `mockServer.use()` prepends, so the precise handlers below still
    // win where they match, and every shape the old behaviour could have reached
    // — the branch route, the repository root, or anything else — records the
    // request rather than swallowing it.
    let issuedUrl = '';
    const capture = ({ request }: { request: Request }) => {
      issuedUrl = request.url;
      return new HttpResponse(null, { status: 204 });
    };
    mockServer.use(
      http.delete('https://*/api/v1/*', capture),
      http.delete('https://*/api/v1/repos/:owner/:repo/branches/:branch', capture),
      http.delete('https://*/api/v1/repos/:owner/:repo/branches/*', capture),
      http.delete('https://*/api/v1/repos/:owner/:repo/', capture),
    );

    const client = new ForgejoClient('https://forgejo.example.com', 'mock-token');
    await expect(client.deleteBranch('demo-user', 'demo-repo', '..')).rejects.toThrow('Unsafe path segment: ..');
    await expect(client.deleteBranch('demo-user', 'demo-repo', '.')).rejects.toThrow('Unsafe path segment: .');

    // No handler was reached: the refusal happens before a request is issued, not
    // as a failed one. In particular the repository-root DELETE that the
    // normalised `..` used to issue is gone.
    expect(issuedUrl).toBe('');
  });
});
