# Pinned OpenAPI snapshot

`swagger.v1.json` is the spec the generated client (`../src/generated`) is built from.
It is committed so a regeneration is reproducible instead of depending on whatever
version a server happened to run.

| Field          | Value                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| Source         | `https://codeberg.org/forgejo/forgejo/raw/tag/<tag>/templates/swagger/v1_json.tmpl`                              |
| Target version | **`v16.0.0`** (the oldest release this extension supports; the template's `info.version` is a build placeholder) |
| Paths          | 326                                                                                                              |
| Size / sha256  | 853,826 characters (853,842 bytes on disk), `0be3bbe8598c` (`spec:update` logs `text.length`)                    |
| Fetched        | 2026-09-23                                                                                                       |

Refresh it deliberately:

```bash
FORGEJO_SPEC_TAG=v16.0.0 pnpm --filter @cpf23333-forgejo-toolkit/api spec:update   # default tag
pnpm --filter @cpf23333-forgejo-toolkit/api generate:safe   # regenerate (restores on failure)
```

Then update the table above, review the diff (a newer spec can change request and
response shapes), run `pnpm check` and the test suites, and note any behaviour the
checklist records.

What a regeneration writes: `../src/generated/{client,types,mocks,schemas}` and
Kubb's own `../src/generated/.kubb/` — the bundled client core, its serializers
and its Standard Schema helper. That output is produced by `kubb generate` and
then formatted with `oxfmt`; no post-processing step rewrites it, and nothing in
the pipeline adds or removes a `.ts` import extension the way the deleted
`scripts/strip-ts-extensions.js` used to.

> **`swagger.v1.json` is a byte-exact snapshot of `templates/swagger/v1_json.tmpl` at the
> Forgejo `v16.0.0` release tag and is excluded from formatting** (it is upstream-generated
> content, not our source — see `ignorePatterns` in `.oxfmtrc.json`). **Never overwrite it
> with a raw download or by hand**: `scripts/update-spec.mjs` driven by `FORGEJO_SPEC_TAG`
> is the only sanctioned way to refresh it; the table above has to be updated with it.
>
> **Use `pnpm --filter @cpf23333-forgejo-toolkit/api generate:safe`.** It refuses to
> start on a dirty `../src/generated` and restores it from git when the generator
> fails. The dirty-tree refusal is conservative on purpose: while a migration is
> uncommitted it will also refuse a tree whose only changes are the migration's own.
> Reviewing a regeneration in that state means running
> `pnpm --filter @cpf23333-forgejo-toolkit/api generate` and `pnpm check` directly,
> and restoring by hand if the run fails.
>
> `kubb` deletes `../src/generated` before it writes, so a run that fails (a crash, a
> bad spec) leaves the directory empty. `generate:safe` restores it from git in that
> case; to restore by hand, `git restore --source=HEAD --worktree ../src/generated`.
> Regeneration does succeed: `d3e4677` (2026-09-24, `chore(api): regenerate the client
from the pinned snapshot`) is the most recent commit that touched
> `../src/generated`. Check `git log -1 --date=short -- ../src/generated` for the
> current baseline before diffing a fresh run. The 2026-09-23 attempt was the one that
> aborted (exit 134, a V8/libuv crash after the clean step, both with the default heap
> and with `NODE_OPTIONS=--max-old-space-size=6144` — three runs, all exit 134, on the
> local Node 24.14.0/25.6.1 installed at the time; if a local Windows run dies that
> way again, retry on the CI container (Node 22), and `generate:safe` makes the retry
> non-destructive.
