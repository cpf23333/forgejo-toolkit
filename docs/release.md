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
