# Pinned OpenAPI snapshot

`swagger.v1.json` is the spec the generated client (`../src/generated`) is built from.
It is committed so a regeneration is reproducible instead of depending on whatever
version a server happened to run.

| Field          | Value                                  |
| -------------- | -------------------------------------- |
| Source         | `https://codeberg.org/swagger.v1.json` |
| `info.version` | `16.0.0-dev-753-6bcc6da0+gitea-1.22.0` |
| Paths          | 326                                    |
| Fetched        | 2026-09-23                             |

Refresh it deliberately:

```bash
pnpm --filter @cpf23333-forgejo-toolkit/api spec:update   # rewrites the snapshot and prints its version
pnpm --filter @cpf23333-forgejo-toolkit/api generate     # regenerate types, client and mocks
```

Then update the table above, review the diff (a newer spec can change request and
response shapes), run `pnpm check` and the test suites, and note any behaviour the
checklist records.
