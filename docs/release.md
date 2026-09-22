# Release Guide

This document describes how to publish Forgejo Toolkit.

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

Inputs: `tag` (override the tag), `prerelease` (mark the release as a
prerelease), `dry_run` (defaults to `true`, so the first run only builds).

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
