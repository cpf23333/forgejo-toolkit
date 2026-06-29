# Forgejo Toolkit

A VS Code extension for [Forgejo](https://forgejo.org/) with a rich Webview-based dashboard.

## Features

- Connect to multiple Forgejo instances
- Browse connected instances in the Explorer sidebar
- Open a Vue 3 dashboard panel styled with VSCode Elements
- Cross-platform: VS Code desktop and code-server

## Tech Stack

- **Extension host**: TypeScript + esbuild (CJS)
- **Webview UI**: Vue 3 + Vite 6 + @vscode-elements/elements + @cpf23333-forgejo-toolkit/vscode-elements-vue

## Development

```bash
pnpm install
pnpm run build
pnpm run check
```

Open this package in VS Code and press `F5` to launch the Extension Host.

## Scripts

| Script                     | Description                         |
| -------------------------- | ----------------------------------- |
| `pnpm run build`           | Build both extension and webview    |
| `pnpm run build:extension` | Build extension host only           |
| `pnpm run build:webview`   | Build webview only                  |
| `pnpm run watch:extension` | Watch extension host                |
| `pnpm run watch:webview`   | Watch webview                       |
| `pnpm run check`           | Type-check both TypeScript projects |

## Packaging

```bash
npx vsce package
```

## Notes

- The extension communicates with Forgejo via the REST API (`/api/v1`).
- Access tokens are stored in VS Code's global state.
- The webview uses `acquireVsCodeApi()` to communicate with the extension host.
- The Vite configuration uses `@cpf23333-forgejo-toolkit/vscode-elements-vue` to automatically mark every `vscode-*` tag as a custom element.
