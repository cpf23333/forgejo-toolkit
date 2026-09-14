[English](https://codeberg.org/cpf23333/forgejo-toolkit/raw/branch/main/packages/forgejo-toolkit/README.md) | 中文

# Forgejo Toolkit

一个用于 [Forgejo](https://forgejo.org/) 的 VS Code 扩展，提供基于 Webview 的仪表盘。

## 功能

- 连接多个 Forgejo 实例
- 在 Explorer 侧栏浏览已连接的实例
- 打开使用 VSCode Elements 构建的 Vue 3 仪表盘面板
- 跨平台：支持 VS Code 桌面版与 code-server

## 技术栈

- **扩展宿主**：TypeScript + esbuild（CJS）
- **Webview UI**：Vue 3 + Vite 8 + @vscode-elements/elements

## 开发

```bash
pnpm install
pnpm run build
pnpm run check
```

在 VS Code 中打开本包，按 `F5` 启动扩展宿主。

## 脚本

| 脚本                       | 说明                        |
| -------------------------- | --------------------------- |
| `pnpm run build`           | 构建扩展与 webview          |
| `pnpm run build:extension` | 仅构建扩展宿主              |
| `pnpm run build:webview`   | 仅构建 webview              |
| `pnpm run watch:extension` | 监听构建扩展宿主            |
| `pnpm run watch:webview`   | 监听构建 webview            |
| `pnpm run check`           | 对两个 TypeScript 工程做类型检查 |

## 打包

```bash
npx vsce package
```

## 说明

- 扩展通过 REST API（`/api/v1`）与 Forgejo 通信。
- 访问令牌存储在 VS Code 的 global state 中。
- webview 使用 `acquireVsCodeApi()` 与扩展宿主通信。
- Vite 配置将所有 `vscode-*` 标签标记为 custom element，使 Vue 将属性透传给底层 web component。
