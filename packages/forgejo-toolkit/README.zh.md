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
- **通知**：未读角标、筛选、后台轮询并弹出 VS Code 提醒。同时打开多个窗口时，默认只由一个窗口轮询并弹出提醒（`forgejoToolkit.multiWindowLease`）；每个窗口打开时仍会加载通知，无法使用该协调机制的窗口会自行轮询。
- **CI / Actions**：运行记录、job 日志、制品下载、取消与触发 workflow。
- **发布与克隆**：把本地仓库发布到实例；通过 VS Code 的 Git: Clone 按关键字在服务端搜索并克隆仓库。
- **面向 AI agent 的 MCP server**：每个已配置实例都会暴露为 Copilot agent mode 的独立 MCP server——33 个工具（Issue、PR、PR 评审摘要、Actions、代码浏览、工作区仓库识别，外加三个默认关闭、各自需要单独开关的写工具）、prompt 模板、零配置自动匹配实例。`forgejoToolkit.mcpEnabled` 可关闭整个 MCP 面（不注册 server 定义、不维护工作区映射、停止 broker），无需重载窗口；已连接的客户端会继续使用自己的进程，直到窗口重载。
- **本地化**：English 与中文。

## 命令

除两条 Pull Request 评审评论命令外，所有命令都在命令面板（`Ctrl+Shift+P`，前缀 `Forgejo Toolkit`）中：打开仪表板、打开设置向导、打开设置、刷新实例、复制永久链接、发布到 Forgejo、查看日志、从当前分支创建 PR、为 Agents 窗口复制 MCP 配置、写入 Copilot 指令、复制轮询诊断信息。添加审查评论与删除审查评论这两条命令位于评论与编辑器右键菜单中；另有部分命令也出现在编辑器右键菜单、源代码管理视图或状态栏中。

## 截图

| 引导设置                                                                                                      | 仪表盘                                                                                                     |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| ![引导设置](https://codeberg.org/cpf23333/forgejo-toolkit/raw/branch/main/docs/screenshots/zh/onboarding.png) | ![仪表盘](https://codeberg.org/cpf23333/forgejo-toolkit/raw/branch/main/docs/screenshots/zh/dashboard.png) |

| 仓库概览                                                                                                         | Pull Request                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| ![仓库概览](https://codeberg.org/cpf23333/forgejo-toolkit/raw/branch/main/docs/screenshots/zh/repo-overview.png) | ![Pull Request](https://codeberg.org/cpf23333/forgejo-toolkit/raw/branch/main/docs/screenshots/zh/pull-request.png) |

| Issue                                                                                                 |
| ----------------------------------------------------------------------------------------------------- |
| ![Issue](https://codeberg.org/cpf23333/forgejo-toolkit/raw/branch/main/docs/screenshots/zh/issue.png) |

## 说明

- 扩展通过 REST API（`/api/v1`）与 Forgejo 通信。
- 访问令牌存储在 VS Code SecretStorage 中（绝不写入明文设置），且只有扩展宿主会读取它。扩展注册的 MCP server 定义只携带实例身份——URL、实例 id、工作区映射——绝不带 token：被启动的进程转而转发到扩展宿主内的 broker，因此 token 既不会写进定义，也不会进入任何子进程的环境变量。这些定义依赖那个 broker：broker 不可达时扩展**不发布**任何定义并在日志里说明，而不是注册一个「客户端以为已认证、实际匿名」的 server。
- webview 使用 `acquireVsCodeApi()` 与扩展宿主通信。
- MCP server 需要 VS Code ≥ 1.102，在 agent mode 中自动出现（零配置）。在 Agents 窗口中，扩展贡献的 server 不会进入 Agent Host 会话（VS Code 当前的平台限制）——可在命令面板运行「为 Agents 窗口复制 MCP 配置」，写入指向稳定路径（升级不失效）的用户级 `mcp.json`（或工作区 `.vscode/mcp.json`）。「写入 Copilot 指令」会把工作区对应的 `<instance>/<owner>/<repo>` 写入已链接检出的 `.github/copilot-instructions.md`，已存在文件时是追加而不是替换。`forgejoToolkit.mcpEnabled`（默认开启）可关闭整个 MCP 面——不注册 server 定义、不维护工作区映射、停止本地 broker——无需重载窗口。

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
