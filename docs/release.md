# Release Guide

This document describes how to publish Forgejo Toolkit.

## Checklist

The order below is what the 0.0.1 release actually used; the sections after it
explain each step.

1. **Write the changelog section.** `CHANGELOG.md` carries `## [<version>] - <date>`
   for the version being released — the release workflow uses it verbatim as the
   Codeberg release body.
2. **Validate the commit.** `pnpm check`, `pnpm lint`, `pnpm format` and
   `pnpm --filter forgejo-toolkit test` locally, or dispatch the manual
   `Verify (manual)` workflow on the self-hosted Forgejo (`origin`).
3. **Ensure the prerequisites exist** on the repository that runs the release:
   the `FORGEJO_TOKEN` secret (or `GITEA_TOKEN`) with `write:repository`, and
   optional variables (`NPM_CONFIG_REGISTRY`, `NPM_DIST_URL`,
   `NPM_PREBUILD_MIRROR`, `DEBIAN_URI`, `DEBIAN_SECURITY_URI`).
4. **Dry run the release workflow.** Dispatch `.forgejo/workflows/release.yml`
   with `dry_run` on (the default) and check the echoed inputs plus the packaged
   `.vsix` artifact.
5. **Publish the Codeberg release.** Dispatch the same workflow with `dry_run`
   off; it validates, packages, creates the release for `v<version>` at the
   dispatched commit and attaches the `.vsix`.
6. **Publish to the stores.** VS Code Marketplace and Open VSX, both manual (they
   need publisher credentials) — see sections 4 and 5.
7. **Backfill the docs.** Align the README installation section and this document
   with the channels actually used, and re-check the version-related entries in
   `KNOWN_ISSUES.md` / `KNOWN_ISSUES.zh.md`.

## Prerequisites

- A [Codeberg](https://codeberg.org) account with push access to `https://codeberg.org/cpf23333/forgejo-toolkit`.
- A [VS Code Marketplace](https://marketplace.visualstudio.com/) publisher account — the extension is published under `cpf23333` (already configured in `packages/forgejo-toolkit/package.json`); you need a Personal Access Token for that publisher.
- An [Open VSX](https://open-vsx.org/) account if you want to publish for VSCodium users.

## Release workflow

### 1. Record changes

After features or fixes are merged, create a changeset:

```bash
pnpm run changeset
```

Follow the interactive prompts to select affected packages and describe the change.

### 2. Prepare the release

When you are ready to release, bump versions and update changelogs:

```bash
pnpm run version-packages
```

This updates `package.json` versions and generates `CHANGELOG.md` entries automatically.

Then make sure `CHANGELOG.md` has a section for the version being released
(`## [<version>] - <date>`): the release workflow uses that section verbatim as
the Codeberg release body, so what is written there is what users read. Writing it
by hand is fine — Changesets only automates the mechanical part.

### 3. Build and package the VSIX

```bash
pnpm --filter forgejo-toolkit package
```

The generated file is located at `packages/forgejo-toolkit/forgejo-toolkit-<version>.vsix`.

### 4. Publish to VS Code Marketplace

`@vscode/vsce` is already included as a dev dependency, so you can publish directly:

```bash
pnpm exec vsce publish --packagePath packages/forgejo-toolkit/forgejo-toolkit-<version>.vsix
```

Or publish directly from source:

```bash
pnpm --filter forgejo-toolkit exec vsce publish
```

### 5. Publish to Open VSX

Install `ovsx`:

```bash
pnpm add -D ovsx
```

Login and publish:

```bash
pnpm exec ovsx create-namespace cpf23333
pnpm exec ovsx publish packages/forgejo-toolkit/forgejo-toolkit-<version>.vsix
```

### 6. Publish to Codeberg Releases

Create a new release on Codeberg and attach the `.vsix` file. Do not commit `.vsix` files to git.

## Automated release workflow (optional)

`.forgejo/workflows/release.yml` performs steps 3 and 6 above from a manual
run — it never triggers on a push, tag or schedule:

1. Typecheck and run the test suites on the dispatched commit.
2. Build and package the extension (`pnpm --filter forgejo-toolkit package`),
   then check that `out/extension.js`, `out/mcp-server.js` and `package.json`
   are inside the `.vsix`.
3. Upload the `.vsix` as a workflow artifact (so it can be downloaded without
   creating a release).
4. Create the Codeberg release and attach the `.vsix` — only when `dry_run` is
   set to `false`. The release tag defaults to `v<version>` taken from
   `packages/forgejo-toolkit/package.json`, and the tag is pinned to the
   dispatched commit rather than the branch head.

The release body comes from `CHANGELOG.md`: the section matching the released
version (`## [<version>]`), falling back to `## [Unreleased]`, and only if both
are empty to a capped commit log (40 commits, or everything since the newest
`v*` tag). That is why step 2 of this document insists on the changelog section
being written — an empty section silently degrades the release notes.

Inputs: `tag` (override the tag), `prerelease` (mark the release as a
prerelease), `dry_run` (defaults to `true`, so the first run only builds).

`tag` and `prerelease` only change what the release step creates, and that step
is skipped during a dry run — so in a dry run they appear to do nothing. The
"Resolve version and tag" step therefore echoes every input it received (`tag`,
`prerelease`, `dry_run`) and writes the resolved tag plus a dry-run note to the
run summary, which also tells apart an input that had no effect from one that
never arrived. Publishing happens only when `dry_run` is explicitly false
(uncheck "Build and package only"); any other value — including an input that was
not delivered — leaves the release untouched.

Requirements:

- A repository secret named `FORGEJO_TOKEN` (or `GITEA_TOKEN`) holding a token
  with `write:repository` scope, used for the release API calls.
- Optional repository variables when the runner cannot reach the public hosts:
  `NPM_CONFIG_REGISTRY`, `NPM_DIST_URL`, `NPM_PREBUILD_MIRROR`, and the two APT
  mirrors `DEBIAN_URI` / `DEBIAN_SECURITY_URI`.
- The APT mirrors are configured **separately**, because a mirror may serve the
  main archive and the security archive from different hosts or paths, and each
  variable holds a full base URI (e.g. `https://mirrors.example.org/debian` and
  `https://mirrors.example.org/debian-security`). On bookworm both suites come
  from `deb.debian.org` (`/debian` and `/debian-security`; `security.debian.org`
  only appears in pre-bookworm source lists); setting only one variable mirrors
  only that suite. If `apt-get update` fails through the mirrors, the step
  restores the image's own sources and updates from those instead of failing the
  job.

Both workflows deliberately carry **no `permissions:` block**. Forgejo does not
implement GitHub's permission model: it ignores the field and warns about it in
the run log ("the value of this field will be ignored"), telling you to grant
permissions through its integration authorization instead. A job's token
permissions therefore come from the repository's Actions/integration settings;
for anything the workflow token cannot do (creating the release here), use a
token secret such as `FORGEJO_TOKEN`.

Steps 4 and 5 (VS Code Marketplace / Open VSX) stay manual: they need publisher
credentials and are not performed by CI.

## Manual packaging for testing

To create a local `.vsix` without publishing:

```bash
pnpm --filter forgejo-toolkit package
```

Then install it in VS Code:

1. Open the Extensions panel.
2. Click **... → Install from VSIX**.
3. Select the generated `.vsix` file.

## Notes

- Always run `pnpm check` and `pnpm test` before publishing.
- Do not store release artifacts in git; attach them to Codeberg Releases.
- Keep the git repository small by not committing build outputs or dependencies.

## Troubleshooting

- **`ERR_AMBIGUOUS_MODULE_SYNTAX` from the release step.** The step feeds its
  script to `node` on stdin (`node <<'NODE'`), and Node ≥ 22 refuses to guess the
  module format for a snippet that mixes `require()` with top-level `await`. Keep
  that script CommonJS: everything inside an `async function` called from a
  `.catch()` handler, no top-level `await`. A dry run does not exercise this step,
  so the failure only shows up when a release is actually created — reproduce it
  locally with `node -` and the same body before changing the step.
- **A tag lookup or an API call fails with 401/403.** Forgejo ignores the
  `permissions:` field, so the job's token may lack the scope the call needs; use
  the `FORGEJO_TOKEN` secret (with `write:repository`) as the release step does.
