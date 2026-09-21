[English](https://codeberg.org/cpf23333/forgejo-toolkit/src/branch/main/README.md) | 中文

# Forgejo Toolkit

一个用于 [Forgejo](https://forgejo.org/)（及 Codeberg）的 VS Code 扩展，提供基于 Webview 的仪表盘：浏览仓库、管理 Issue 和 Pull Request、评审 PR diff、处理通知——无需离开编辑器。

## 功能

- **多实例**：连接多个 Forgejo/Codeberg 实例，access token 使用 VS Code SecretStorage 保存。
- **仪表盘**：按实例展示仓库、Issue、Pull Request；关联仓库卡片跟随工作区的 git remote（支持多 remote 与嵌套仓库）。
- **仓库浏览**：README 预览、文件浏览器（搜索与文件历史）、分支 / 标签 / Release 管理。
- **Issue 与 PR**：列表、搜索、创建、编辑、关闭 / 重开、删除；Markdown 渲染与附件；评论支持图片上传。
- **Pull Request**：diff 查看（支持按提交查看）、合并（merge / squash / rebase）、撤销合并、状态检查与合并阻塞原因、状态栏一键从当前分支创建 PR。
- **PR 评审**：在 VS Code 原生 diff 编辑器中查看与添加行内评审评论，支持多行评论与「评论 / 批准 / 要求修改」结论。
- **Worktree**：一键将 PR 检出到本地 worktree；从 Issue 一键创建分支开始工作。
- **通知**：未读角标、筛选、后台轮询并弹出 VS Code 提醒。
- **CI / Actions**：运行记录、job 日志、制品下载、取消与触发 workflow。
- **发布与克隆**：把本地仓库发布到实例；通过 VS Code 的 Git: Clone 按关键字在服务端搜索并克隆仓库。
- **本地化**：English 与中文。

## 截图

| 引导设置 | 仪表盘 |
| --- | --- |
| ![引导设置](https://codeberg.org/cpf23333/forgejo-toolkit/raw/branch/main/docs/screenshots/zh/onboarding.png) | ![仪表盘](https://codeberg.org/cpf23333/forgejo-toolkit/raw/branch/main/docs/screenshots/zh/dashboard.png) |

| 仓库概览 | Pull Request |
| --- | --- |
| ![仓库概览](https://codeberg.org/cpf23333/forgejo-toolkit/raw/branch/main/docs/screenshots/zh/repo-overview.png) | ![Pull Request](https://codeberg.org/cpf23333/forgejo-toolkit/raw/branch/main/docs/screenshots/zh/pull-request.png) |

| Issue |
| --- |
| ![Issue](https://codeberg.org/cpf23333/forgejo-toolkit/raw/branch/main/docs/screenshots/zh/issue.png) |

## 说明

- 扩展通过 REST API（`/api/v1`）与 Forgejo 通信。
- 访问令牌存储在 VS Code SecretStorage 中（绝不写入明文设置）。
- webview 使用 `acquireVsCodeApi()` 与扩展宿主通信。

## 开发

```bash
pnpm install
pnpm run build
pnpm run check
```

在 VS Code 中打开本包，按 `F5` 启动扩展宿主。

## 脚本

| 脚本                       | 说明                             |
| -------------------------- | -------------------------------- |
| `pnpm run build`           | 构建扩展与 webview（生产模式）   |
| `pnpm run build:extension` | 仅构建扩展宿主                   |
| `pnpm run build:webview`   | 仅构建 webview                   |
| `pnpm run watch:extension` | 监听构建扩展宿主                 |
| `pnpm run watch:webview`   | 监听构建 webview                 |
| `pnpm run check`           | 对两个 TypeScript 工程做类型检查 |
| `pnpm run test`            | 运行 webview 与扩展单元测试      |
| `pnpm run package`         | 生产构建并用 vsce 打包 `.vsix`   |

## 打包

请始终通过脚本打包——它会先完成生产构建（剥离 mock、不含 sourcemap），再由 `vsce` 打出 `.vsix`：

```bash
pnpm run package
```
