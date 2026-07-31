[English](./README.md) | 中文

# Forgejo Toolkit

[![Codeberg](https://img.shields.io/badge/Codeberg-forgejo--toolkit-blue.svg)](https://codeberg.org/cpf23333/forgejo-toolkit)

一个用于 [Forgejo](https://forgejo.org/) 的 VS Code 扩展，提供基于 Webview 的仪表盘、仓库浏览、Issue / PR 管理、PR worktree 等功能。

## 功能概览

- **多实例管理**：添加、编辑、删除多个 Forgejo/Codeberg 实例，access token 使用 VS Code SecretStorage 保存。
- **Dashboard 面板**：在 VS Code 侧边栏展示仓库、Issue、Pull Request 列表，按实例折叠。
- **仓库详情**：查看 README、最近提交、分支 / 标签 / Release 列表、文件浏览器。
- **文件浏览器**：目录树展示、文件内容查看、文件搜索、单文件历史、文件夹展开 loading 指示器。
- **Issue / PR 管理**：列表、详情、创建、编辑、关闭 / 重新打开；支持 Markdown 渲染与附件列表。
- **PR diff**：查看变更文件列表，支持按提交查看 diff，调用 VS Code 原生 diff 编辑器。
- **PR Worktree**：在 PR 详情页一键检出 `refs/pull/<index>/head` 到本地 worktree，支持配置打开方式和缓存目录。
- **国际化**：支持中文 / 英文切换。
- **调试日志**：可选开启 API 请求日志到 `Forgejo Toolkit` Output Channel。

## 安装

### 从 VSIX 安装

```bash
pnpm --filter forgejo-toolkit package
```

然后在 VS Code 中点击 **扩展 → ... → 从 VSIX 安装**，选择生成的 `forgejo-toolkit-0.0.1.vsix`。

### 从 Marketplace 安装

> 暂未发布，后续会上架 VS Code Marketplace。

## 使用

1. 安装扩展后，点击左侧活动栏的 **Forgejo Toolkit** 图标打开 Dashboard。
2. 首次使用会进入引导页，配置 Forgejo 实例地址和 access token。
3. 在 Dashboard 中浏览仓库、Issue、PR；点击仓库卡片进入仓库详情。
4. 在 Issue / PR 详情页可以评论、编辑、关闭 / 重新打开。
5. 在 PR 详情页点击「在 Worktree 中打开」可检出到本地 worktree。

## 截图

> 以下截图占位符对应 `docs/screenshots/` 目录下的图片，发布前请补充实际截图。

### Dashboard

![Dashboard](./docs/screenshots/dashboard.png)

### 仓库详情 - 概览

![Repository Overview](./docs/screenshots/repo-overview.png)

### 仓库详情 - 文件浏览器

![Repository File Browser](./docs/screenshots/repo-file-browser.png)

### 仓库详情 - 分支 / 标签 / Release

![Repository Refs](./docs/screenshots/repo-refs.png)

### Issue 列表与详情

![Issue List and Detail](./docs/screenshots/issue-list-and-detail.png)

### Pull Request 列表与详情

![Pull Request List and Detail](./docs/screenshots/pr-list-and-detail.png)

### PR diff

![PR Diff](./docs/screenshots/pr-diff.png)

### Issue / PR 编辑弹窗

![Issue PR Edit Dialog](./docs/screenshots/issue-pr-edit-dialog.png)

### PR Worktree

![PR Worktree](./docs/screenshots/pr-worktree.png)

### 设置页

![Settings](./docs/screenshots/settings.png)

## 已知限制

参见 [KNOWN_ISSUES.md](./KNOWN_ISSUES.md)（英文）和 [KNOWN_ISSUES.zh.md](./KNOWN_ISSUES.zh.md)（中文）。

主要限制包括：

- PR 附件需要从 Issue API 获取。
- Issue / PR 附件上传仅在编辑已有项时可用。
- 创建 Release 时无法同时上传附件。
- 多文件 diff 编辑器中修改 / 重命名文件不显示 M/R 徽章。
- Forgejo 的 PR 文件 API 可能漏掉删除文件（扩展已改用 compare API 规避）。

## 开发

这是一个 pnpm workspace monorepo。

### 包结构

| Package                                                          | 说明                                                                                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [`packages/forgejo-toolkit`](./packages/forgejo-toolkit)         | VS Code 扩展主体。                                                                                                            |
| [`packages/vscode-elements-vue`](./packages/vscode-elements-vue) | Vue 3 适配 [@vscode-elements/elements](https://www.npmjs.com/package/@vscode-elements/elements) 的类型、Vite 插件和包装组件。 |
| [`packages/shared`](./packages/shared)                           | 共享请求客户端与通用类型。                                                                                                    |
| [`packages/forgejo-api`](./packages/forgejo-api)                 | 基于 Forgejo OpenAPI 规范生成的 API 客户端。                                                                                  |

### 技术栈

- **Extension host**: TypeScript + esbuild (CJS)
- **Webview UI**: Vue 3 + Vite 6 + @vscode-elements/elements
- **包管理**: pnpm workspaces

### 常用命令

```bash
# 安装依赖
pnpm install

# 构建所有包
pnpm run build

# 类型检查
pnpm run check

# 运行测试
pnpm --filter forgejo-toolkit test
pnpm --filter @cpf23333-forgejo-toolkit/shared test

# 开发模式
pnpm run dev
```

在 VS Code 中打开 `packages/forgejo-toolkit` 目录，按 `F5` 启动 Extension Host。

### 打包

```bash
pnpm --filter forgejo-toolkit package
```

生成的 `.vsix` 文件位于 `packages/forgejo-toolkit/`。

### 版本管理

本项目使用 [Changesets](https://github.com/changesets/changesets) 管理 monorepo 版本号。

```bash
# 开发完一个功能后，记录变更
pnpm run changeset

# 准备发版时，自动更新版本号和 CHANGELOG
pnpm run version-packages
```

`pnpm run release` 用于 npm 包发布；VS Code 扩展本身通过 `pnpm --filter forgejo-toolkit package` 打包成 `.vsix`。

## 截图清单（发布前补充）

请在 `docs/screenshots/` 目录下放置以下截图，文件名与 README 中引用保持一致：

1. `dashboard.png` — Dashboard 面板，展示仓库 / Issue / PR 列表和实例折叠效果。
2. `repo-overview.png` — 仓库详情「概览」标签页，展示 README、最近提交、默认分支信息。
3. `repo-file-browser.png` — 仓库详情「文件」标签页，展示目录树、文件搜索或文件历史弹窗。
4. `repo-refs.png` — 仓库详情「引用」标签页，展示分支 / 标签 / Release 列表。
5. `issue-list-and-detail.png` — Issue 列表 + Issue 详情页。
6. `pr-list-and-detail.png` — PR 列表 + PR 详情页。
7. `pr-diff.png` — PR 详情页的变更文件列表，或 VS Code diff 编辑器。
8. `issue-pr-edit-dialog.png` — Issue / PR 编辑弹窗，展示 Markdown 编辑器与附件区域。
9. `pr-worktree.png` — PR 详情页「在 Worktree 中打开」流程，或 worktree 设置面板。
10. `settings.png` — 设置页，展示实例列表、worktree 配置、语言切换。

## License

[MIT](./LICENSE)
