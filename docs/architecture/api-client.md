# API Client

The `forgejo-api` package provides a typed HTTP client generated from the Forgejo OpenAPI specification.

## Generation

The client is generated with [Kubb](https://kubb.dev/):

```bash
pnpm --filter @cpf23333-forgejo-toolkit/api generate
```

This produces:

- `src/generated/client/*` — one fetch function per operation.
- `src/generated/mocks/*` — MSW handlers for tests.
- `src/generated/schemas/*` — Zod / JSON schemas for validation.
- `src/generated/types/*` — TypeScript types.

## Request client

The `shared` package provides a lightweight request client that adds:

- base URL resolution per instance
- authentication header injection
- response parsing and error normalization
- optional request/response logging

Example usage in the extension host:

```ts
import { createClient } from '@cpf23333-forgejo-toolkit/shared';

const client = createClient({
  baseUrl: 'https://codeberg.org/api/v1',
  token: 'my-token',
  debug: true,
});

const repos = await client.getUserRepos({ username: 'myuser' });
```

## Mocking

Tests can use the generated MSW handlers to mock Forgejo API responses:

```ts
import { handlers } from '@cpf23333-forgejo-toolkit/api/mocks';
```

## Error handling

API errors are normalized into a standard `ApiError` shape with `message` and optional `code`. The extension host forwards these errors to the webview, which displays them in the UI.

## Adding custom endpoints

If Forgejo adds an endpoint that is not yet in the generated client, you can extend the client in `packages/shared/src/request/` or add a custom fetch function until the OpenAPI spec is updated.
