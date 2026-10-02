# API Client

The client is layered: generated operation wrappers send through a Kubb client
core, and the extension host supplies that core's _transport_ — this
repository's shared fetch client — so `ForgejoClient` keeps every concern the
shared client omits.

```text
ForgejoClient                     packages/forgejo-toolkit/src/api/client.ts
  └─ generated operations         packages/forgejo-api/src/generated/client/*
       └─ Kubb client core        packages/forgejo-api/src/generated/.kubb/client.ts
            └─ shared transport   packages/forgejo-toolkit/src/api/sharedTransport.ts
                 └─ shared fetch  packages/shared/src/request/index.ts
```

## 1. Generated operation wrappers

`packages/forgejo-api/src/generated/client/*` holds one exported function per
Forgejo operation (one file per operation, e.g. `repoGet.ts`, `renderMarkdown.ts`).
Each wrapper:

- takes a single `options: Options<<Name>Options, ThrowOnError>` object, whose
  `path` / `query` / `body` members are the operation's own grouped parameters
  plus the request options (`signal`, `headers`, `responseType`, `client`, …),
- resolves its own method/URL internally,
- delegates to the client instance in `options.client` (defaulting to the
  bundled one) and resolves to the success body (`returnType: 'data'` in
  `packages/forgejo-api/kubb.config.ts`), or to the whole result when the caller
  passes `throwOnError: false`.

```ts
const repository = await repoGet({
  path: { owner: 'myuser', repo: 'myrepo' },
  baseURL: 'https://forgejo.example.com/api/v1',
  headers: { Authorization: 'token my-token' },
});
```

Passing `{ client }` is how the host attaches per-instance behaviour.

The client core and its transport types are reachable through the package's
`./kubb` subpath (`createClientCore`, `Transport`, `TransportResult`,
`ResolvedRequest`, `ClientInstance`), and the serializers through
`./kubb/serializers`. They need those entry points because the package's root
barrel re-exports only `src/generated/client/index` and
`src/generated/types/index`, and Kubb writes `.kubb/client.ts` outside both; and
`./kubb` cannot be folded into the root barrel, whose `client` export is the
shared request client.

## 2. Shared request client

`@cpf23333-forgejo-toolkit/shared/request`
(`packages/shared/src/request/index.ts`) is the wire layer. It exports `client`
(default and named), `buildUrl`, `mergeHeaders`, `encodePathSegment`, and the
types `Client`, `RequestConfig`, `ResponseConfig`, `RequestFetch`,
`ResponseErrorConfig`. It does exactly this much:

- merges `Accept: application/json`, JSON-encodes the body and sets
  `Content-Type: application/json` when the caller did not supply a content type
  (any casing) of its own (inside `client`),
- optional `credentials`, `signal`, `responseType`, and an undici
  `dispatcher`/`fetchImpl` pair for proxies,
- returns `{ data, status, statusText, headers }`, normalizing 204/205/304 to `{}`,
- throws a `RequestError` for a non-2xx response or a 200 whose body is not JSON.

It does **not** inject authentication headers, resolve an instance URL, build a
URL from grouped `path`/`query` parameters, or log requests and responses. The
shared package exposes only these subpaths (`packages/shared/package.json`):
`./request`, `./webview/messages`, `./git/url`, `./mcp/workspaceState`, `./limits`.
There is no `createClient`, no `getUserRepos`, and no barrel
`@cpf23333-forgejo-toolkit/shared`.

## 3. The transport seam

`packages/forgejo-toolkit/src/api/sharedTransport.ts` is the ~70 lines that make
the shared client the transport of a Kubb `ClientInstance`. It receives a request
that is already resolved — URL built from `{owner}`-style templates and the
grouped `path`/`query`, headers merged, body serialized for the declared content
type — and **re-sends that request** rather than rebuilding one:

- the URL is passed through verbatim, with no `params` (repeating them would
  append the serialized query a second time),
- the body keeps the form the serializer produced, so a `FormData` body stays a
  `FormData` and an urlencoded body stays a string,
- the proxy pair and the abort signal are resolved per request, because the
  extension installs the configured proxy once during activation and a client may
  have been constructed before that,
- the credential is read per request and left off entirely when empty, so an
  anonymous request carries no `Authorization` header at all,
- the `responseType` the caller asked for is replayed into the shared client, so
  a `text` call (CI logs, PR diffs, rendered markdown) is not JSON-parsed.

Two details are worth knowing before changing it:

- **Capturing the native pair.** A Kubb transport result must carry the native
  `Request` and `Response` (the generated `ResponseError` exposes both, and
  `_getListPage` reads `X-Total-Count` off them), while the shared client's
  `ResponseConfig` deliberately carries only data/status/headers. The transport
  therefore installs its own `fetch` wrapper and captures the pair it sees.
  The shared client uses a caller-supplied `fetchImpl` only together with a
  `dispatcher`, so that wrapper is always paired with one (a sentinel when no
  proxy is configured) — otherwise the shared client would call global `fetch`
  and there would be nothing to capture.
- **Path encoding.** Kubb's path serializer percent-encodes each parameter, which
  is right for a single-segment route (`branches/{branch}` with `feature/x#1` goes
  out as `feature%2Fx%231`, and Forgejo routes on the escaped path). It is wrong
  for `/repos/{owner}/{repo}/contents/{filepath}`, a wildcard route that matches
  the remainder of the path: encoding its `/` makes Forgejo answer 404 for every
  nested path. `_client()` therefore passes a `slashPreservingPathSerializer` that
  encodes that one parameter segment by segment and rejects `.`/`..` segments,
  which would otherwise let a path navigate out of the route.

## 4. `ForgejoClient` (extension host)

`packages/forgejo-toolkit/src/api/client.ts` (`ForgejoClient`) is the hand-written
layer the extension actually uses, and it is where the concerns the shared client
omits are implemented:

- per-instance base URL `${instanceUrl}/api/v1` and the `ClientInstance` built by
  `_client()` (once per `ForgejoClient`, in the constructor),
- authentication: `Authorization: token <token>` on every request,
- proxy dispatcher + abort signal wiring,
- debug request/response logging through the `ClientLogger` passed to the
  constructor, including the failure line for a request that never produced a
  response,
- pagination (`_fetchAllPages`), tree/contents caching, and response rewriting
  (as a response interceptor, so a `stream` response is passed through untouched),
- error normalization: the `RequestError` (or any other failure) from the shared
  client is classified into an `ApiError` by `toApiError`
  (`packages/forgejo-toolkit/src/api/errors-core.ts`).

Example usage in the extension host:

```ts
import { ForgejoClient } from './api/client';

const client = new ForgejoClient('https://forgejo.example.com', token, logger);
const user = await client.getCurrentUser();
const repositories = await client.getUserRepositories();
```

## Generation

Regenerate with the **safe** command:

```bash
pnpm --filter @cpf23333-forgejo-toolkit/api generate:safe
```

It produces `src/generated/client/*` (one function per operation),
`src/generated/mocks/*` (MSW handlers), `src/generated/schemas/*`,
`src/generated/types/*` and `src/generated/.kubb/*` (the bundled client core and
serializers). The plain `generate` script is `kubb generate` followed by
`oxfmt src/generated`; nothing else rewrites the output.

Use `generate:safe` rather than plain `generate`: `packages/forgejo-api/kubb.config.ts`
sets `output.clean = true`, so kubb deletes `src/generated` _before_ writing, and a
run that then fails (a bad spec, the known native crash on Windows) leaves the
directory empty. `scripts/generate-safe.mjs` refuses to start on a dirty
`src/generated` and restores it from git when the run fails. See
`packages/forgejo-api/spec/README.md` for refreshing the pinned snapshot itself.

## Mocking

Kubb also emits MSW handlers, re-exported one per operation as
`<operation>Handler` (plus `<operation>HandlerResponse<status>`) from
`@cpf23333-forgejo-toolkit/api/mocks` — there is no `handlers` barrel:

```ts
import { repoGetHandler } from '@cpf23333-forgejo-toolkit/api/mocks';
```

Note that the extension's own suites do not use these; they run a hand-written MSW
server in `packages/forgejo-toolkit/src/test/mocks/` (`handlers.ts`, `data/`).

## Error handling

The shared client throws a `RequestError`, carrying `status`, `statusText`,
`headers` and `body` beside the human-readable message
(`packages/shared/src/request/index.ts`). The message is still
`` `Forgejo API error ${status}: ${detail}` ``, where `detail` is the response
body (truncated, or described when the body is not JSON, see `describedBody`), so
anything that logs or matches the old shape keeps working; a 200 whose body is
not JSON also throws (`nonJsonSuccessBodyError`). `body` is the parsed JSON when
the response declared JSON and it parsed, otherwise the raw text (empty string
for an empty body) — read the field rather than re-parsing the message.

That error is what `error instanceof RequestError` in
`packages/forgejo-toolkit/src/api/errors-core.ts` matches, which is why the
transport delegates the send to the shared client instead of reimplementing it:
a second fetch implementation would produce a second error shape and lose that
identity. The generated `ResponseError` (Kubb's per-status error class) is not
the error a caller sees — the shared client throws before Kubb can build one —
and its `ResponseError.is()` helper matches on `name` rather than `instanceof`
for exactly the reason the shared client's own class comment gives: every
generated client bundles its own copy.

The host classifies the thrown error with `toApiError`
(`packages/forgejo-toolkit/src/api/errors-core.ts`) into an `ApiError` carrying
`kind` (`network` | `timeout` | `cancelled` | `tls` | `http` | `unknown` | `proxy`), `status`,
`body`, `rawMessage`, and a localized `userMessage` getter. `proxy` is the
connection-failure case with a proxy dispatcher installed: the failure is
attributed to the configured proxy, and the instance itself may be fine. A
server-provided message is rendered from `ApiError.body` when the body is a JSON
object with a non-empty `message`; every other error — a hand-built one, a test
stub, or one whose class identity was lost across a serialization boundary — still
falls back to searching the message text (`extractApiErrorMessage`, unchanged).
The extension host forwards the rendered message to the webview, which displays
it.

So: catch `Error` (or the host's `ApiError`); for a failure the shared client
produced, read `status`/`body`; otherwise read `message`/`ApiError.userMessage`,
and never trust generated error fields.

## Adding custom endpoints

If Forgejo adds an endpoint that is not yet in the generated client, either refresh
the pinned spec and regenerate (`spec:update` then `generate:safe`), or add a method
to `ForgejoClient` in `packages/forgejo-toolkit/src/api/client.ts`, sending through
`this.client` (the `ClientInstance` `_client()` built). Do not hand-write endpoint
code in `packages/shared/src/request/`, which is transport-only.
