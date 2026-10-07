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
Open VSX is live too, but no workflow publishes to it: an upload is a manual
step (section 5 explains why, and what it needs). The sections after this one
explain each step.

1. **Write the changelog section and name it for the version.** The root
   `CHANGELOG.md` is the authoritative release-notes source: the release workflow
   extracts the section whose heading names the version being released
   (`## [<version>] - <date>`) and publishes it verbatim as the Codeberg release
   body. Decide the version first and let `pnpm run version-packages` bump the
   manifest and consume the pending changesets, then rename the root
   `## [Unreleased]` heading to `## [<version>] - <date>` and copy the root file
   over `packages/forgejo-toolkit/CHANGELOG.md` — that file is a mechanical
   per-package record, not an independent source of notes, and a test keeps it
   byte-for-byte identical to the root. Renaming **before** the dispatch is what
   makes the workflow take the version section: it accepts either spelling and
   does fall back to `## [Unreleased]`, but with the rename done first the dry
   run's "found the section for this version" line is a real check, and the record
   never claims that an already-published version is still unreleased. Renaming
   first also means the date in the heading has to be the day you dispatch. Open a
   fresh `## [Unreleased]` heading above the released section in the same commit,
   so the tree always carries a place for the next cycle and nothing has to be
   remembered after the release. That is safe only because the workflow prefers the
   section that names the version and falls back to the unreleased one, which is
   why the dry run's line naming the section it used stays a required check: an
   empty unreleased heading above the released one is exactly what would be
   published if that order ever changed. Every feature or fix in the release should
   already be recorded twice — an `## [Unreleased]` entry and a changeset; step 1 under
   "Release workflow" below states the rule and how to check the two lists against each
   other.
   Renaming the heading also turns the section into a released one, which
   `node tools/tracking-audit/check.mjs` fails on until its ledger is re-recorded
   with `node tools/tracking-audit/check.mjs --record`. That command re-hashes every
   released section of the root `CHANGELOG.md` and prints what it wrote. Run it only
   as part of a release — it is a maintenance command rather than a check, and
   re-recording is exactly how a change to an already-released section would become
   invisible to the audit.
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
6. **Publish to the stores.** The VS Code Marketplace and Open VSX listings are
   both live and are updated manually (they need publisher credentials) — see
   sections 4 and 5. Neither is published by a workflow. Each further publish
   updates the existing listing.
7. **Check the release left nothing stale.** Re-check the version-related entries
   in `KNOWN_ISSUES.md` / `KNOWN_ISSUES.zh.md`, and the listing text that only
   moves at the next publish (see **Extension description** below). `README.md` /
   `README.zh.md` now describe Open VSX as a live listing (section 5), so that
   wording changes again only when a store's status actually changes.

## Prerequisites

- A [Codeberg](https://codeberg.org) account with push access to `https://codeberg.org/cpf23333/forgejo-toolkit`.
- For store publishing (checklist step 6, sections 4 and 5): a
  [VS Code Marketplace](https://marketplace.visualstudio.com/) publisher account —
  the extension is published under the `cpf23333` publisher id set in
  `packages/forgejo-toolkit/package.json` and uses a Personal Access Token for
  updates — and an **Eclipse Foundation account with a signed Publisher
  Agreement** for [Open VSX](https://open-vsx.org/). Both listings exist today:
  Marketplace under the `cpf23333` publisher id, Open VSX under the `cpf23333`
  namespace. Open VSX refuses an upload without the signed agreement ("You must
  log in with an Eclipse Foundation account and sign a Publisher Agreement
  before publishing any extension."), so create the account and sign it before
  the first upload. If a store's status or account changes, update `README.md`,
  `README.zh.md`, `FAQ.md`, `FAQ.zh.md` and this file in the same change.

## Release workflow

### 1. Record changes

After features or fixes are merged, **two** records are written for the same batch, and
they do different jobs:

- **A changeset** in `.changeset/` is the version arithmetic. Its front matter names the
  package and the semver level — `minor` for a new capability, `patch` for a fix or an
  internal change — and `pnpm run version-packages` consumes the pending ones to bump
  `packages/forgejo-toolkit/package.json` and to write the mechanical per-package record
  `packages/forgejo-toolkit/CHANGELOG.md` (`@changesets/apply-release-plan`).
- **An entry under `## [Unreleased]` in the root `CHANGELOG.md`** is the release-notes
  text. The release workflow publishes a changelog section **verbatim** as the Codeberg
  release body, and it reads the root file first (the paragraph beginning "The release
  body comes from the root `CHANGELOG.md`" under "Automated release workflow (optional)"
  lists the exact order it tries), so this — not the changeset — is what users read.

Create a changeset with:

```bash
pnpm run changeset
```

Follow the interactive prompts to select the affected package and describe the change,
and write the `## [Unreleased]` entry by hand in the same commit.

Both describe the same change, and neither substitutes for the other: a changeset alone
leaves the release body without the feature (the workflow falls through to the next
source, and eventually to a capped commit log), and an `[Unreleased]` entry alone leaves
the version number to be guessed. An internal-only change — a dependency or build change,
a refactor nothing user-visible depends on — still needs a changeset for the version bump
but no `[Unreleased]` entry; the two `CHANGELOG.md` files are release-notes records, not
engineering logs.

**The rule, so this cannot quietly reopen:** a change that ships a feature or a fix
updates `## [Unreleased]` **and** adds a changeset, in the same commit. Before a release
the two lists can be checked against each other and against the history: every entry
under `## [Unreleased]` should have a changeset behind it, and `git log --oneline
<last-release-tag>..HEAD` should show no user-visible commit that `## [Unreleased]`
misses. When they disagree, the root `CHANGELOG.md` is the authoritative text and is
corrected first; the changeset is then written to match it.

At release time the two records meet like this (checklist step 1 is the authoritative
order; the workflow itself does none of it):

1. `pnpm run version-packages` consumes the pending changesets: it bumps
   `packages/forgejo-toolkit/package.json` and writes the per-package
   `packages/forgejo-toolkit/CHANGELOG.md`.
2. In the same commit, the root `CHANGELOG.md`'s `## [Unreleased]` heading is renamed to
   `## [<version>] - <date>`, a fresh `## [Unreleased]` heading is opened above the
   released section, and the root file is copied over
   `packages/forgejo-toolkit/CHANGELOG.md` — the copy is the mechanical step, and a test
   keeps the two files byte-identical.
3. The release workflow then publishes the renamed section. It never consumes a
   changeset, never renames a heading and never copies a file, so steps 1 and 2 are what
   make its output the curated notes instead of the commit-log fallback.

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

**Live, and updated by hand.** The listing exists at
<https://open-vsx.org/extension/cpf23333/forgejo-toolkit>, and it is not updated
by a workflow: an upload needs publisher credentials, and this repository's CI is
human-triggered, so no job carries them. Upload the `.vsix` step 3 produced.

The upload has a prerequisite that is an account and an agreement rather than a
credential: an **Eclipse Foundation account with a signed Publisher Agreement**
for Open VSX. Without it the site refuses an upload with "You must log in with an
Eclipse Foundation account and sign a Publisher Agreement before publishing any
extension." Sign the agreement before the first upload, whichever route you use.

**From the web page.** Sign in at <https://open-vsx.org/user/publish> with the
Eclipse Foundation account and upload the `.vsix` there. This is the route the
live listing was uploaded with, and it needs no token and nothing installed —
but it stores no record of what was uploaded beyond the registry's own version
entry, so the CLI below is the reproducible alternative.

**From the CLI.** [ovsx](https://www.npmjs.com/package/ovsx) publishes the
already-packaged file. It is not a workspace dependency, so install it where you
run it — a global install leaves the repository untouched:

```bash
pnpm add -g ovsx
ovsx publish packages/forgejo-toolkit/forgejo-toolkit-<version>.vsix --pat <token>
```

The token is an Open VSX [personal access
token](https://open-vsx.org/user-settings/tokens) created in the account's
settings, and it is a secret: it belongs in a CI secret, never in the repository.
`--pat` can be left off when `OVSX_PAT` is set in the environment, which is the
form a workflow would use. `ovsx` also reads the `publisher` field of the
manifest as the namespace, so the `cpf23333` namespace must exist — it does,
because the live listing published into it; `ovsx create-namespace cpf23333`
covers the case of a new namespace and is not needed for this one.

**What is not known here.** Whether a token for this repository is already
configured anywhere — a local `OVSX_PAT`, `ovsx login`, or a repository secret —
is not recorded in the repository. Treat the CLI route as available but unproven
until someone confirms a token exists; the web page needs no token at all, and
nothing in `.forgejo/workflows/` publishes to Open VSX or would have to change
for either route to keep working.

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
   code through `extension/out/chunks/` (one Rolldown build with code splitting),
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

### Extension description

The manifest `description` is the one line the VS Code Marketplace and Open VSX
listings show, and what the editor's extension view reads. It lives in
`packages/forgejo-toolkit/package.nls.json` and its Chinese twin
`package.nls.zh-cn.json`, and it reaches a store only when a new version is
published there — editing it changes nothing on an existing listing.

Two copies of that prose are **not** generated from the repository: the GitHub
repository "About" text and the Codeberg repository description are typed by
hand into those forges' web UIs, so the manifest line does not cover them.
A description change therefore means updating all of them in the same pass —
the manifest pair, the GitHub "About" text and the Codeberg description — with
the store listings following at the next publish.

`keywords` and `categories` are different: they live only in
`packages/forgejo-toolkit/package.json` and are not localized, so they need no
such pass.

This rule exists because a capability change once left one copy behind: the
extension shipped three write tools behind their own settings while the GitHub
"About" text still called it a read-only MCP server.

### Package manager pin

pnpm is pinned in two places and they have to agree:

- the root `package.json`'s `packageManager` field
  (`"packageManager": "pnpm@11.28.3"`) — the authoritative pin, which also lets
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
