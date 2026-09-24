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

> **`swagger.v1.json` is a byte-exact snapshot of `templates/swagger/v1_json.tmpl` at the
> Forgejo `v16.0.0` release tag and is excluded from formatting** (it is upstream-generated
> content, not our source — see `ignorePatterns` in `.oxfmtrc.json`). **Never overwrite it
> with a raw download or by hand**: `scripts/update-spec.mjs` driven by `FORGEJO_SPEC_TAG`
> is the only sanctioned way to refresh it; the table above has to be updated with it.
>
> **Use `pnpm --filter @cpf23333-forgejo-toolkit/api generate:safe`.** It refuses to
> start on a dirty `../src/generated` and restores it from git when the generator
> fails.
>
> `kubb` deletes `../src/generated` before it writes, so a run that fails (a crash, a
> bad spec) leaves the directory empty. Restore it with
> `git restore --source=HEAD --worktree ../src/generated`. On 2026-09-23 `pnpm generate`
> aborted twice on Windows (exit 134, a V8/libuv crash after the clean step) both with
> the default heap and with `NODE_OPTIONS=--max-old-space-size=6144`, so the pinned
> snapshot is committed but the regeneration itself still needs a working toolchain
> run. Local Windows with the installed Node 24.14.0/25.6.1 aborts every time (three
> runs, all exit 134); the CI container (Node 22) is the environment to try, and
> `generate:safe` makes that attempt non-destructive.
