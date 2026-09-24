[English](./README.md) | 中文

# Forgejo Toolkit

[![Codeberg](https://img.shields.io/badge/Codeberg-forgejo--toolkit-blue.svg)](https://codeberg.org/cpf23333/forgejo-toolkit)

一个用于 [Forgejo](https://forgejo.org/) 的 VS Code 扩展，提供基于 Webview 的仪表盘、仓库浏览、Issue / PR 管理、PR worktree 等功能。

## 功能概览

- **多实例管理**：添加、编辑、删除多个 Forgejo/Codeberg 实例，access token 使用 VS Code SecretStorage 保存。
- **Dashboard 面板**：在 VS Code 侧边栏展示仓库、Issue、Pull Request 列表，按实例折叠，支持关键词搜索与状态筛选。
- **关联仓库**：自动识别 workspace 的 git remote（含多 remote、多根工作区），在 Dashboard 顶部展示关联仓库卡片便于快捷跳转。
- **仓库详情**：README 预览、最近提交、分支 / 标签 / Release 管理（创建 / 删除、Release 附件），以及带搜索和文件历史的文件浏览器。
- **Issue / PR 管理**：列表、详情、创建、编辑、关闭 / 重新打开、删除；支持 Markdown 渲染、评论、附件、标签、负责人、里程碑、到期时间、依赖、反应表情、订阅与时间追踪。
- **PR Review**：在原生 diff 编辑器中添加行级 review 评论（单行 / 多行），配备富文本输入框；提交评审时可选择评论 / 批准 / 要求修改。
- **PR diff 与合并**：变更文件列表、按提交查看 diff、合并状态与阻塞原因、CI 状态检查，支持 merge / squash / rebase / revert。
- **PR Worktree**：一键检出 `refs/pull/<index>/head` 到本地 worktree，支持配置打开方式和缓存目录；Start Work on Issue 以同样方式创建 issue 分支。
- **发布与创建 PR**：将本地仓库或分支发布到 Forgejo，通过 Git: Clone 快速选择克隆服务端仓库，状态栏按钮一键创建 PR。
- **通知中心**：未读角标、后台轮询与消息提醒、状态 / 类型筛选、标记已读。
- **全局搜索**：跨实例搜索仓库、Issue、PR。
- **CI / Actions**：运行历史、job 日志、制品下载、取消运行、带输入参数的 workflow 触发。
- **MCP Server**：零配置将 Forgejo 实例暴露给 Copilot agent mode 等 MCP 客户端，提供 Issue、PR、Actions、代码浏览等只读工具（需 VS Code ≥ 1.102）。
- **设置导出 / 导入**：将实例（可选加密）与设置导出为 JSON，导入前提供冲突预览。
- **国际化**：支持中文 / 英文切换。
- **调试日志**：可选开启 API 请求日志到 `Forgejo Toolkit` Output Channel。

## 安装

### 从扩展商店安装

在 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=cpf23333.forgejo-toolkit)
搜索「Forgejo Toolkit」安装；使用 VSCodium 等编辑器时，可从
[Open VSX](https://open-vsx.org/extension/cpf23333/forgejo-toolkit) 安装。
若某个商店还没上架当前版本，用下面的 `.vsix` 安装。

### 从 VSIX 安装

每个版本都会把打包好的 `.vsix` 附在
[Codeberg Release](https://codeberg.org/cpf23333/forgejo-toolkit/releases) 上，
下载后在 VS Code 中点击 **扩展 → ... → 从 VSIX 安装** 选择该文件。

想自己构建：

```bash
pnpm --filter forgejo-toolkit package
```

产物位于 `packages/forgejo-toolkit/forgejo-toolkit-<版本>.vsix`。

## 使用

1. 安装扩展后，点击左侧活动栏的 **Forgejo Toolkit** 图标打开 Dashboard。
2. 首次使用会进入引导页，配置 Forgejo 实例地址和 access token。
3. 在 Dashboard 中浏览仓库、Issue、PR；点击仓库卡片进入仓库详情。
4. 在 Issue / PR 详情页可以评论、编辑、关闭 / 重新打开。
5. 在 PR 详情页点击「在 Worktree 中打开」可检出到本地 worktree。

## 兼容性

- **Forgejo ≥ 16.0** —— 最低版本定为 v16：多个已交付功能依赖 v16 才出现的接口（Actions 的 job/artifact/job 日志/取消/删除，以及多行 review 评论）。更老的实例可能部分可用，但不受支持：扩展每会话提示一次温和警告，且不阻断功能，因此 v15 用户会在这些面板上看到请求失败——服务端返回的裸 404，或由扩展自行闸门拦下的 Actions 调用给出「需要 Forgejo 1.19 或更高版本」的说明（见 KNOWN_ISSUES）。
- **主要目标版本：Forgejo v16.x** —— 扩展基于最新的 Forgejo 稳定版（当前为 v16 系列）开发和验证，最低版本与验证目标为同一系列。
- **VS Code ≥ 1.102** —— 通过扩展的 `engines.vscode` 字段强制约束。
- **Actions 功能需要 Forgejo ≥ 1.19** —— 在最低版本之上按特性闸门处理：扩展把探测到的服务端版本与 1.19 这条下限比较，早于 Actions API 的实例会在请求时立即失败并给出本地化错误「该功能需要 Forgejo 1.19 或更高版本，当前服务器版本为 <版本>。」，而不是让服务端返回裸 404。Actions 相关界面本身仍然显示，被拒绝的是请求。探测不到版本的服务端不会因此被拦（闸门失败时放行）。
- 未来依赖更新 Forgejo 版本的新端点（如 v17 的 rerun API）同样按特性闸门处理，不会抬升整体最低版本。

## MCP Server（AI Agent 集成）

扩展内置 MCP Server，让 Copilot agent mode 等 AI 助手可以用自然语言查询你的 Forgejo 实例。

- **零配置**：首个已配置的 Forgejo 实例会通过 VS Code 的 `contributes.mcpServerDefinitionProviders` API 自动暴露给 MCP 客户端，无需任何额外设置，也不用单独启动服务。
- **要求**：VS Code ≥ 1.102，且至少配置了一个带 access token 的实例；不满足时静默不注册。
- **使用方式**：在 Copilot 聊天中切换到 agent mode，直接用自然语言提问，例如「list my issues」或「看一下这个仓库最近一次失败运行的 CI 日志」。
- **工具概览**：约 27 个工具，分为四组——
  - **基础**：Issue、PR、时间线、通知、仓库信息与搜索（如 `list_issues`、`get_pull_request`）。
  - **Actions**：运行历史、job 日志与制品（如 `list_action_runs`、`get_action_job_log`）。
  - **代码读取**：文件内容、分支、标签、提交、文件历史与 PR diff（如 `get_file_content`、`get_pr_diff`）。
  - **Review 与元数据**：PR 评审、Release、标签、里程碑与自己的仓库（如 `list_pull_reviews`、`whoami`）。
- **安全说明**：
  - 全部工具均为只读（`readOnlyHint`），agent 无法修改实例上的任何数据。
  - 由于是只读工具，VS Code 不会在每次调用前弹确认框。约束来自工具面本身：每个工具都只映射到 `GET` 接口，且所有会进入请求路径的输入（`owner`、`repo`、文件路径）都做了校验，构造参数无法跳到其他接口。
  - token 从 SecretStorage 经进程环境变量注入 stdio 子进程，不会出现在工具 schema、工具结果或日志中。
  - 过大的响应字段与超长结果会被截断，保护 agent 的上下文窗口。
  - 增删实例后会自动重新解析暴露的 server。

## 截图

| 引导设置                                                                                                      | Dashboard                                                                                                     |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| ![引导设置](https://codeberg.org/cpf23333/forgejo-toolkit/raw/branch/main/docs/screenshots/zh/onboarding.png) | ![Dashboard](https://codeberg.org/cpf23333/forgejo-toolkit/raw/branch/main/docs/screenshots/zh/dashboard.png) |

| 仓库概览                                                                                                         | Pull Request                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| ![仓库概览](https://codeberg.org/cpf23333/forgejo-toolkit/raw/branch/main/docs/screenshots/zh/repo-overview.png) | ![Pull Request](https://codeberg.org/cpf23333/forgejo-toolkit/raw/branch/main/docs/screenshots/zh/pull-request.png) |

| Issue                                                                                                 |
| ----------------------------------------------------------------------------------------------------- |
| ![Issue](https://codeberg.org/cpf23333/forgejo-toolkit/raw/branch/main/docs/screenshots/zh/issue.png) |

## 已知限制

参见 [KNOWN_ISSUES.md](./KNOWN_ISSUES.md)（英文）和 [KNOWN_ISSUES.zh.md](./KNOWN_ISSUES.zh.md)（中文）。

主要限制包括：

- PR 附件需要从 Issue API 获取。
- 多文件 diff 编辑器中修改 / 重命名文件不显示 M/R 徽章。
- Forgejo 的 PR 文件 API 可能漏掉删除文件（扩展已改用 compare API 规避）。
- 列表最多返回 500 条，且只有部分视图（Issue、PR、评论、变更文件、提交、refs、文件搜索、MCP 结果）会提示列表被截断。

## 开发

这是一个 pnpm workspace monorepo。

### 包结构

| Package                                                  | 说明                                         |
| -------------------------------------------------------- | -------------------------------------------- |
| [`packages/forgejo-toolkit`](./packages/forgejo-toolkit) | VS Code 扩展主体。                           |
| [`packages/shared`](./packages/shared)                   | 共享请求客户端与通用类型。                   |
| [`packages/forgejo-api`](./packages/forgejo-api)         | 基于 Forgejo OpenAPI 规范生成的 API 客户端。 |

### 技术栈

- **Extension host**: TypeScript + esbuild (CJS)
- **Webview UI**: Vue 3 + Vite 8 + @vscode-elements/elements
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

## 项目状态

这是一个个人业余项目，各项功能仅经过简单测试，可能存在 bug 和未覆盖到的边界情况。如遇到问题，欢迎提交 issue。

## 反馈与贡献

欢迎提交 bug 反馈、功能建议、Pull Request、文档改进，以及任何其他形式的反馈。  
如果你有更好的交互、布局、流程或其他想法，欢迎通过 Issue 或 Discussion 提出。

## License

[MIT](./LICENSE)
