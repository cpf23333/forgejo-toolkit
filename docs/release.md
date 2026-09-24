# Release Guide

This document describes how to publish Forgejo Toolkit.

## Checklist

The order below is what the 0.0.1 release uses; nothing has been published yet
(the Codeberg release, the Marketplace listing and the Open VSX listing all still
have to be created), so a first-time releaser can follow it top to bottom. The
sections after it explain each step.

1. **Write the changelog section.** The root `CHANGELOG.md` is the authoritative
   release-notes source: the release workflow extracts the section whose heading
   names the version being released (`## [<version>] - <date>`) and publishes it
   verbatim as the Codeberg release body. Before the first release the notes live
   under `## [Unreleased]`, which the workflow falls back to; that heading is
   renamed to `## [<version>] - <date>` at release time (post-release step 7).
   `pnpm run version-packages` maintains `packages/forgejo-toolkit/CHANGELOG.md`
   instead, a mechanical per-package record that is only a fallback for the
   release body — the curated root section is still the one to write.
2. **Validate the commit.** `pnpm check`, `pnpm lint`,
   `pnpm exec oxfmt --check "**/*.{js,mjs,cjs,ts,vue}"` and
   `pnpm --filter forgejo-toolkit test` locally, or dispatch the manual
   `Verify (manual)` workflow on the self-hosted Forgejo (`origin`). The format
   command spells out that glob on purpose: it is exactly what the workflows'
   `Format check` step runs, and markdown is deliberately outside its scope — run
   it rather than the root `pnpm format` script, which checks every file
   including tracked markdown.
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
   need publisher credentials) — see sections 4 and 5. Neither listing exists yet;
   this is the step that creates them.
7. **Backfill the docs.** Rename the released section in `CHANGELOG.md` from
   `## [Unreleased]` to `## [<version>] - <date>` (edit the root file and copy it
   over `packages/forgejo-toolkit/CHANGELOG.md` — a test keeps the two byte for
   byte identical), flip the "not published yet" wording in `README.md` /
   `README.zh.md` back to plain store links now that they resolve, and re-check
   the version-related entries in `KNOWN_ISSUES.md` / `KNOWN_ISSUES.zh.md`.

## Prerequisites

- A [Codeberg](https://codeberg.org) account with push access to `https://codeberg.org/cpf23333/forgejo-toolkit`.
- For store publishing only (checklist step 6, sections 4 and 5): a
  [VS Code Marketplace](https://marketplace.visualstudio.com/) publisher account —
  the extension will be published under the `cpf23333` publisher id already set in
  `packages/forgejo-toolkit/package.json`, and you need a Personal Access Token for
  it — and an [Open VSX](https://open-vsx.org/) account if you want to publish for
  VSCodium users. **Neither store carries the extension yet**, so the Marketplace
  and Open VSX listing URLs in the READMEs do not resolve until that step has run
  once; the READMEs state that instead of linking readers to a 404.

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

This updates `package.json` versions and writes `packages/forgejo-toolkit/CHANGELOG.md`.

Then make sure the root `CHANGELOG.md` has a section for the version being released
(`## [<version>] - <date>`, or `## [Unreleased]` while the version is still
unreleased — the workflow accepts both spellings and falls back to `[Unreleased]`):
the release workflow uses that section verbatim as the Codeberg release body, so
what is written there is what users read. Writing it by hand is fine — Changesets
only automates the mechanical part, and its per-package file is not the release
body. The two `CHANGELOG.md` files are kept byte-identical by a test; when the
version heading is added or renamed, do it in the root file and copy it over.

### 3. Build and package the VSIX

```bash
pnpm --filter forgejo-toolkit package
```

The generated file is located at `packages/forgejo-toolkit/forgejo-toolkit-<version>.vsix`.

### 4. Publish to VS Code Marketplace

`@vscode/vsce` is a dev dependency of the extension package, _not_ of the workspace
root, so `pnpm exec vsce …` from the repository root fails with a "command not
found". Run it inside the package with `pnpm --filter`, where the path is the
`.vsix` file name relative to `packages/forgejo-toolkit`:

```bash
pnpm --filter forgejo-toolkit exec vsce publish --packagePath forgejo-toolkit-<version>.vsix
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

1. Validate the commit: `pnpm run lint`, the narrowed format check
   (`pnpm exec oxfmt --check "**/*.{js,mjs,cjs,ts,vue}"`), `pnpm run check`, the
   API checklist coverage audit (`node tools/api-audit/check.mjs`) and both test
   suites.
2. Build and package the extension (`pnpm --filter forgejo-toolkit package`),
   then check the `.vsix` for nine entries — the paths as they appear inside
   the archive, matched case-insensitively because `vsce` writes the changelog
   copy as `extension/changelog.md` regardless of the repository spelling:
   `extension/package.json`, `extension/out/extension.js`,
   `extension/out/mcp-server.js`, `extension/LICENSE.txt`, `extension/NOTICE`,
   `extension/changelog.md`, `extension/l10n/bundle.l10n.json`,
   `extension/walkthrough/addInstance.md` and
   `extension/out/webview/index.html`. The list lives in the "Check the
   packaged .vsix" step of `.forgejo/workflows/release.yml`; a missing entry
   fails the run. `NOTICE` is checked because it is not only attribution: it
   carries the Apache-2.0 license text of DOMPurify, the one bundled component
   that is not MIT-licensed, and that text has to travel with the distribution.
3. Upload the `.vsix` as a workflow artifact (so it can be downloaded without
   creating a release).
4. Create the Codeberg release and attach the `.vsix` — only when `dry_run` is
   set to `false`. The release tag defaults to `v<version>` taken from
   `packages/forgejo-toolkit/package.json`, and the tag is pinned to the
   dispatched commit rather than the branch head.

The release body comes from the root `CHANGELOG.md` first — the section whose
heading names the released version, then `## [Unreleased]` — and then from
`packages/forgejo-toolkit/CHANGELOG.md`, the record
`@changesets/apply-release-plan` maintains, with the same two headings. The
step logs which file and section it used. A heading is matched by the version
inside it, so both spellings work: the root file's Keep-a-Changelog
`## [0.0.1] - <date>` and changesets' plain `## 0.0.1`. Only if all four are
empty does it fall back to a capped commit log (40 commits, or everything since
the newest `v*` tag). That is why step 1 of this document insists on the
changelog section being written — an empty section silently degrades the release
notes. The extracted lines are published verbatim, so the section must read as
user-facing release notes: keep maintainer instructions (how or when to update
the file, for example) outside it — at the top of the changelog or in this
document.

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

- Always run `pnpm check` and the test suites before publishing. The workspace has
  no root `test` script, so run the package scripts directly:

  ```bash
  pnpm --filter forgejo-toolkit test
  pnpm --filter @cpf23333-forgejo-toolkit/shared test
  ```

  `forgejo-toolkit`'s own `test` script runs both of its suites (`test:webview` +
  `test:extension`); `@cpf23333-forgejo-toolkit/api` has no test script — step 2 of
  the checklist (`pnpm check`, `pnpm lint` and the narrowed format check) is what
  covers it.

- Do not store release artifacts in git; attach them to Codeberg Releases.
- Keep the git repository small by not committing build outputs or dependencies.

### Package manager pin

pnpm is pinned in two places and they have to agree:

- the root `package.json`'s `packageManager` field
  (`"packageManager": "pnpm@11.8.0"`) — the authoritative pin, which also lets
  Corepack reproduce the same pnpm for anyone who enables it;
- the `npm install -g pnpm@<version>` step of `.forgejo/workflows/ci.yml` and
  `.forgejo/workflows/release.yml`.

The pinned version is the one the local checkout and `pnpm-lock.yaml` were
generated with, so the workflows install exactly the tool that produced the
lockfile. When the pin changes, change both workflows and the root field together
(and regenerate the lockfile with the new version). The extension manifest
(`packages/forgejo-toolkit/package.json`) is a workspace member, not the
workspace root: its own `packageManager` field is ignored by pnpm/Corepack and
should be removed rather than kept in step, so the pin has a single source.

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
