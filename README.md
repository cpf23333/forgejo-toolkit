# Forgejo Toolkit (Monorepo)

A VS Code extension for [Forgejo](https://forgejo.org/) with a rich Webview-based dashboard, built as a pnpm workspace monorepo.

## Packages

| Package                                                          | Description                                                                                                                                         |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/forgejo-toolkit`](./packages/forgejo-toolkit)         | The VS Code extension itself.                                                                                                                       |
| [`packages/vscode-elements-vue`](./packages/vscode-elements-vue) | Vue 3 adapter for [@vscode-elements/elements](https://www.npmjs.com/package/@vscode-elements/elements): types, Vite plugin, and wrapper components. |

## Tech Stack

- **Extension host**: TypeScript + esbuild (CJS)
- **Webview UI**: Vue 3 + Vite 6 + @vscode-elements/elements
- **Package manager**: pnpm workspaces

## Development

```bash
pnpm install
pnpm run build
pnpm run check
```

Open `packages/forgejo-toolkit` in VS Code and press `F5` to launch the Extension Host.

## Scripts

| Script           | Description                      |
| ---------------- | -------------------------------- |
| `pnpm run build` | Build all packages               |
| `pnpm run check` | Type-check all packages          |
| `pnpm run dev`   | Start all packages in watch mode |

## Packaging

```bash
cd packages/forgejo-toolkit
npx vsce package
```

## Notes

- The extension communicates with Forgejo via the REST API (`/api/v1`).
- Access tokens are stored in VS Code's global state.
- The webview uses `acquireVsCodeApi()` to communicate with the extension host.
- `@cpf23333-forgejo-toolkit/vscode-elements-vue` provides a Vite plugin that automatically configures Vue's `isCustomElement` for all `vscode-*` tags.
