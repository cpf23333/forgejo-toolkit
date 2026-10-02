# Release Guide

This document describes how to publish Forgejo Toolkit.

## Checklist

The order below is what a release uses. 0.0.1 and 0.1.0 are already out: the
Marketplace listing is live, the `v0.0.1` release exists on the self-hosted
Forgejo (`origin`), and Codeberg carries two releases — `0.0.1` (release id
`12472572`, at
<https://codeberg.org/cpf23333/forgejo-toolkit/releases/tag/0.0.1>, with
`forgejo-toolkit-0.0.1.vsix` attached) and **`v0.1.0`** (release id `12655833`,
published 2026-10-02, at
<https://codeberg.org/cpf23333/forgejo-toolkit/releases/tag/v0.1.0>, with
`forgejo-toolkit-0.1.0.vsix` attached). The 0.1.0 release is the first one that
followed the workflow's own tag default, so the `v<version>` spelling described
in step 4 is now the convention in practice rather than a plan; 0.0.1's
un-prefixed tag stays as it is. Codeberg still has no runner of its own, though:
both releases were created by dispatching the release workflow on the
self-hosted Forgejo, not on Codeberg, and a Codeberg-side dispatch needs a
`docker`-label runner registered there first (section "Where to dispatch it").
Open VSX is not pending work but a decision: the extension is deliberately not
published there (section 5 explains when that changes). The sections after it
explain each step.

1. **Write the changelog section.** The root `CHANGELOG.md` is the authoritative
   release-notes source: the release workflow extracts the section whose heading
   names the version being released (`## [<version>] - <date>`) and publishes it
   verbatim as the Codeberg release body. Before the first release the notes live
   under `## [Unreleased]`, which the workflow falls back to; that heading is
   renamed to `## [<version>] - <date>` at release time (post-release step 7).
   `pnpm run version-packages` maintains `packages/forgejo-toolkit/CHANGELOG.md`
   instead, a mechanical per-package record. That file is not an independent
   source of release notes: it is kept byte-for-byte identical to this root file
   (post-release step 7 copies one over the other and a test enforces it), so
   writing the curated root section is what a release needs.
2. **Validate the commit.** `pnpm check`, `pnpm lint`,
   `pnpm exec oxfmt --check "**/*.{js,mjs,cjs,mts,ts,vue}"` and
   `pnpm --filter forgejo-toolkit test` locally, or dispatch the manual
   `Verify (manual)` workflow on the self-hosted Forgejo (`origin`). The format
   command spells out that glob on purpose: it is exactly what the workflows'
   `Format check` step runs, and markdown is deliberately outside its scope — run
   it rather than the root `pnpm format` script, which checks every file
   including tracked markdown.
3. **Ensure the prerequisites exist** on the repository that runs the release:
   the `FORGEJO_TOKEN` secret (or `GITEA_TOKEN`) with `write:repository`, and
   optional variables (`NPM_CONFIG_REGISTRY`, `NPM_DIST_URL`,
   `NPM_PREBUILD_MIRROR`, `DEBIAN_URI`, `DEBIAN_SECURITY_URI`). The registry
   variable is exported to the jobs twice, as `NPM_CONFIG_REGISTRY` and
   `PNPM_CONFIG_REGISTRY`, because npm and pnpm 11 read different spellings; set
   the one repository variable and both tools use the mirror.
4. **Dry run the release workflow.** Dispatch `.forgejo/workflows/release.yml`
   with `dry_run` on (the default) and check the echoed inputs plus the packaged
   `.vsix` artifact.
5. **Publish the Codeberg release.** Dispatch the same workflow with `dry_run`
   off; it validates, packages, creates the release for `v<version>` (the
   workflow's default tag — see step 4 for why 0.0.1's own tag is spelled
   without the `v`) at the dispatched commit and attaches the `.vsix`.
6. **Publish to the stores.** The VS Code Marketplace is live and is updated
   manually (it needs publisher credentials) — see section 4. Open VSX is
   deliberately not published; section 5 keeps the steps for the day that
   decision changes. Each further Marketplace publish updates the existing
   listing.
7. **Backfill the docs.** Rename the released section in `CHANGELOG.md` from
   `## [Unreleased]` to `## [<version>] - <date>` (edit the root file and copy it
   over `packages/forgejo-toolkit/CHANGELOG.md` — a test keeps the two byte for
   byte identical), flip the "not published yet" wording in `README.md` /
   `README.zh.md` back to plain store links now that they resolve, and re-check
   the version-related entries in `KNOWN_ISSUES.md` / `KNOWN_ISSUES.zh.md`.

## Prerequisites

- A [Codeberg](https://codeberg.org) account with push access to `https://codeberg.org/cpf23333/forgejo-toolkit`.
- For store publishing (checklist step 6, sections 4 and 5): a
  [VS Code Marketplace](https://marketplace.visualstudio.com/) publisher account —
  the extension is published under the `cpf23333` publisher id set in
  `packages/forgejo-toolkit/package.json` and uses a Personal Access Token for
  updates — and an [Open VSX](https://open-vsx.org/) account if you want to
  publish for VSCodium users. **The extension is deliberately not published on
  Open VSX at the moment**, so the listing URL in the READMEs does not resolve;
  if that changes, update `README.md`, `README.zh.md`, `FAQ.md`, `FAQ.zh.md` and
  this file in the same change.

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

**Not planned at the moment.** The extension is deliberately not published on
Open VSX for now, and the READMEs and FAQ say exactly that; the steps below are
kept for the day that decision changes (and then the wording above has to change
with them).

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

**Where to dispatch it.** Both workflows ask for a runner with the `docker`
label. Codeberg currently has none online for this repository — its Actions
page shows "no runner with matching labels online" next to each workflow and
queued dispatches never start (checked 2026-09-26). Dispatch both workflows on
the self-hosted Forgejo (`origin`) instead: its runner already completes
`ci.yml` (verify) there, and `release.yml` uses the same runner setup. If a
Codeberg-side dispatch is wanted later, register a `docker`-label runner in
the Codeberg repository settings (Settings → Actions → Runners) first.

1. Validate the commit: `pnpm run lint`, the narrowed format check
   (`pnpm exec oxfmt --check "**/*.{js,mjs,cjs,mts,ts,vue}"`), `pnpm run check`, the
   API checklist coverage audit (`node tools/api-audit/check.mjs`) and both test
   suites.
2. Build and package the extension (`pnpm --filter forgejo-toolkit package`),
   then check the `.vsix` for thirteen entries plus the shared-chunks directory —
   the paths as they appear inside the archive, matched case-insensitively
   because `vsce` writes the changelog copy as `extension/changelog.md`
   regardless of the repository spelling:
   `extension/package.json`, `extension/out/extension.mjs`,
   `extension/out/mcp-server.mjs`, `extension/LICENSE.txt`, `extension/NOTICE`,
   `extension/changelog.md`, `extension/l10n/bundle.l10n.json`,
   `extension/walkthrough/addInstance.md`, `extension/out/webview/index.html`,
   `extension/out/webview/onboarding.html`,
   `extension/out/webview/pullReviewComment.html`,
   `extension/out/webview/codicon.css` and
   `extension/out/webview/codicon.ttf`. The list lives in the "Check the
   packaged .vsix" step of `.forgejo/workflows/release.yml`; a missing entry
   fails the run. Each webview surface has its own document, because the panels
   must not download the dashboard shell (`webview/vite.config.mts` builds one
   input per surface and asserts the resulting graph), so a build that stopped
   emitting one of them would ship a panel that opens empty. The two entry
   bundles are ESM and share almost all of their
   code through `extension/out/chunks/` (one esbuild build with `splitting`),
   so that directory is checked as a whole rather than by its hashed file
   names. The two codicon assets are checked because the webview only
   links them at runtime: `webview/vite.config.mts`'s `copyCodicons` hook copies
   them next to the bundle, so a build in which that hook stops running still
   succeeds while shipping no icons at all. `NOTICE` is checked because it is not
   only attribution: it carries the Apache-2.0 license text of DOMPurify, the one
   bundled component that is not MIT-licensed, and that text has to travel with
   the distribution.
3. Upload the `.vsix` as a workflow artifact (so it can be downloaded without
   creating a release).
4. Create the Codeberg release and attach the `.vsix` — only when `dry_run` is
   set to `false`. The release tag defaults to `v<version>` taken from
   `packages/forgejo-toolkit/package.json`, and the tag is pinned to the
   dispatched commit rather than the branch head. **That default is the
   convention for the next release.** The release that exists today does not
   follow it: it was created by hand as `0.0.1`, without the `v`, and that is the
   tag Codeberg carries (release id `12472572`), while `v0.0.1` exists only on
   the self-hosted Forgejo. Nothing needs to be backfilled for 0.0.1 — nobody
   consumes the tag programmatically — so leave both as they are and let the
   workflow name every future tag `v<version>`; pass the `tag` input only to
   override that default on purpose, and never to reproduce the old spelling.

The release body comes from the root `CHANGELOG.md`: the section whose heading
names the released version, then `## [Unreleased]`. The step then tries
`packages/forgejo-toolkit/CHANGELOG.md` with the same two headings, but that file
is not an independent source: post-release step 7 copies the root file over it
and a test keeps the two byte-identical, so the second attempt only reads the
same text back (or, if the copy was skipped, a stale copy). The
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
  `NPM_CONFIG_REGISTRY` (exported as both the npm and pnpm registry override),
  `NPM_DIST_URL`, `NPM_PREBUILD_MIRROR`, and the two APT mirrors `DEBIAN_URI` /
  `DEBIAN_SECURITY_URI`.
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
