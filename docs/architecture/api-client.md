# API Client

The client is layered: generated operation wrappers call a small shared fetch
client, and the extension host wraps both in `ForgejoClient`.

```text
ForgejoClient                     packages/forgejo-toolkit/src/api/client.ts
  └─ generated operations         packages/forgejo-api/src/generated/client/*
       └─ shared request client   packages/shared/src/request/index.ts
```

## 1. Generated operation wrappers

`packages/forgejo-api/src/generated/client/*` holds one exported function per
Forgejo operation (one file per operation, e.g. `repoGet.ts`, `renderMarkdown.ts`).
Each wrapper:

- takes the operation's parameters plus
  `config: Partial<RequestConfig> & { client?: Client }`,
- resolves its own method/URL internally,
- delegates the request to the shared client (`client`, imported as `fetch` via
  `importPath` in `packages/forgejo-api/kubb.config.ts`) and returns `res.data`.

Passing `{ client }` is how the host attaches per-instance behaviour; the default
is the shared fetch client.

## 2. Shared request client

`@cpf23333-forgejo-toolkit/shared/request`
(`packages/shared/src/request/index.ts`) is the transport. It exports `client`
(default and named), `buildUrl`, `mergeHeaders`, `encodePathSegment`, and the
types `Client`, `RequestConfig`, `ResponseConfig`, `RequestFetch`,
`ResponseErrorConfig`. It does exactly this much:

- resolves the URL from `baseURL` + `url` + serialized `params` (`buildUrl`),
- merges `Accept: application/json`, JSON-encodes the body and sets
  `Content-Type` (inside `client`),
- optional `credentials`, `signal`, and an undici `dispatcher`/`fetchImpl` pair
  for proxies,
- returns `{ data, status, statusText, headers }`, normalizing 204/205/304 to `{}`.

It does **not** inject authentication headers, resolve an instance URL, or log
requests and responses — all of that lives in `ForgejoClient` (below). The shared
package exposes only these subpaths (`packages/shared/package.json`):
`./request`, `./webview/messages`, `./git/url`, `./limits`. There is no
`createClient`, no `getUserRepos`, and no barrel `@cpf23333-forgejo-toolkit/shared`.

Using a generated operation directly, with the shared client as transport:

```ts
import { repoGet } from '@cpf23333-forgejo-toolkit/api';

const repository = await repoGet('myuser', 'myrepo', {
  baseURL: 'https://forgejo.example.com/api/v1',
  headers: { Authorization: 'token my-token' },
});
```

`@cpf23333-forgejo-toolkit/api` (`packages/forgejo-api/src/index.ts`) re-exports
the shared request client, every generated operation, and every generated type.

## 3. `ForgejoClient` (extension host)

`packages/forgejo-toolkit/src/api/client.ts` (`ForgejoClient`) is the hand-written
layer the extension actually uses, and it is where the concerns the shared client
omits are implemented:

- per-instance base URL `${instanceUrl}/api/v1` and the closure returned by
  `_client()`,
- authentication: `Authorization: token <token>` on every request,
- proxy dispatcher + abort signal wiring,
- debug request/response logging through the `ClientLogger` passed to the
  constructor,
- pagination (`_fetchAllPages`), tree/contents caching, and response rewriting,
- error normalization: the raw `Error` from the shared client is classified into
  an `ApiError` by `toApiError` (`packages/forgejo-toolkit/src/api/errors-core.ts`).

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
`src/generated/mocks/*` (MSW handlers), `src/generated/schemas/*` and
`src/generated/types/*`.

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

The shared client throws a plain `Error`, not the generated error type. Its
message is `` `Forgejo API error ${status}: ${detail}` `` (thrown by `client` in
`packages/shared/src/request/index.ts`), where `detail` is the response body
(truncated, or described when the body is not JSON, see `describedBody`); a 200
whose body is not JSON also throws (`nonJsonSuccessBodyError`).

The type alias `ResponseErrorConfig<TError> = TError`
(`packages/shared/src/request/index.ts:37-48`) only fills the generated wrappers'
second type argument (e.g. `ResponseErrorConfig<RepoGet404>` in
`repoGet.ts`). Nothing ever throws that value: the fields of a generated error type
(`errors`, `url`, …) are undefined at runtime, so do not narrow a `catch` to
`RepoGet404` and read them.

The host then classifies the thrown `Error` with `toApiError`
(`packages/forgejo-toolkit/src/api/errors-core.ts`) into an `ApiError` carrying
`kind` (`network` | `timeout` | `tls` | `http` | `unknown`), `status`,
`rawMessage`, and a localized `userMessage` getter. Because the structured body is
not preserved on the error, the host recovers a server-provided message by parsing
the JSON object embedded in the error message text (`messageFromErrorBody` in the
same file). The extension host forwards the rendered message to the webview, which
displays it.

So: catch `Error` (or the host's `ApiError`); read `message`/`ApiError.userMessage`,
never generated error fields.

## Adding custom endpoints

If Forgejo adds an endpoint that is not yet in the generated client, either refresh
the pinned spec and regenerate (`spec:update` then `generate:safe`), or add a method
to `ForgejoClient` in `packages/forgejo-toolkit/src/api/client.ts`, calling the
shared client through `_client()`. Do not hand-write endpoint code in
`packages/shared/src/request/`, which is transport-only.
