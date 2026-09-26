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

扩展已发布到
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=cpf23333.forgejo-toolkit)——在扩展视图中搜索「Forgejo Toolkit」直接安装即可。

### 从 VSIX 安装

每个版本也会把打包好的 `.vsix` 附在
[Codeberg Release](https://codeberg.org/cpf23333/forgejo-toolkit/releases) 上，在 VS Code 中点击
**扩展 → ... → 从 VSIX 安装** 选择该文件即可。自行构建：

```bash
pnpm --filter forgejo-toolkit package
```

产物位于 `packages/forgejo-toolkit/forgejo-toolkit-<版本>.vsix`。

### Open VSX

[Open VSX](https://open-vsx.org/extension/cpf23333/forgejo-toolkit) 条目（供 VSCodium 等编辑器使用）计划中但尚未发布；在那之前，VSCodium 用户可以安装 Release 页面上的 `.vsix`。

## 使用

1. 安装扩展后，点击左侧活动栏的 **Forgejo Toolkit** 图标打开 Dashboard。
2. 首次使用会进入引导页，配置 Forgejo 实例地址和 access token。
3. 在 Dashboard 中浏览仓库、Issue、PR；点击仓库卡片进入仓库详情。
4. 在 Issue / PR 详情页可以评论、编辑、关闭 / 重新打开。
5. 在 PR 详情页点击「在 Worktree 中打开」可检出到本地 worktree。

## 命令

所有命令都可以从命令面板（`Ctrl+Shift+P`，前缀 `Forgejo Toolkit`）调用；部分命令也出现在编辑器右键菜单和状态栏中。

| 命令                        | 作用                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 打开仪表板                  | 在侧边栏打开 Forgejo 仪表盘。                                                                                                  |
| 打开设置向导                | 打开首次使用的设置向导。                                                                                                       |
| 打开设置                    | 打开扩展设置视图。                                                                                                             |
| 刷新实例                    | 重新读取实例配置并刷新仪表盘。                                                                                                 |
| 复制永久链接                | 复制当前文件或选区的永久链接（也可从编辑器右键菜单调用）。                                                                     |
| 发布到 Forgejo              | 把当前仓库发布到你的实例（也可从源代码管理视图调用）。                                                                         |
| 查看日志                    | 打开「Forgejo Toolkit」输出频道。                                                                                              |
| 从当前分支创建 PR           | 从当前分支创建 Pull Request（也可从状态栏调用）。                                                                              |
| 添加审查评论                | 在当前 diff 行添加评审评论（也可从 diff 编辑器的行号右键菜单调用）。                                                           |
| 删除审查评论                | 删除光标处的评审评论。                                                                                                         |
| 为 Agents 窗口复制 MCP 配置 | 写入或复制一份可直接使用的 Agents 窗口 MCP 配置（用户级 `mcp.json`、工作区 `.vscode/mcp.json` 或剪贴板；见 MCP Server 一节）。 |

## 兼容性

- **Forgejo ≥ 16.0** —— 最低版本定为 v16：多个已交付功能依赖 v16 才出现的接口（Actions 的 job/artifact/job 日志/取消/删除，以及多行 review 评论）。更老的实例可能部分可用，但不受支持：扩展每会话提示一次温和警告，且不阻断功能，因此 v15 用户会在这些面板上看到请求失败——服务端返回的裸 404（见 KNOWN_ISSUES）。
- **主要目标版本：Forgejo v16.x** —— 扩展基于最新的 Forgejo 稳定版（当前为 v16 系列）开发和验证，最低版本与验证目标为同一系列。
- **VS Code ≥ 1.102** —— 通过扩展的 `engines.vscode` 字段强制约束。
- **Actions 的 1.19 下限低于支持下限** —— Actions API 最早出现在 Forgejo 1.19，扩展会把探测到的服务端版本与这条下限比较：早于 1.19 的服务端会在请求时被拒绝，给出本地化错误「该功能需要 Forgejo 1.19 或更高版本，当前服务器版本为 <版本>。」，而不是拿到裸 404。从 1.21 时代起的版本（含 v7–v16 现代版本序列）都高于 1.19——这道闸门只可能对 1.18 及更早的版本触发——因此在 Forgejo 15 实例上闸门不会触发，那里缺失的 Actions 子端点会返回服务端自己的 404（见 KNOWN_ISSUES）。Actions 相关界面本身仍然显示，被拒绝的是请求。探测不到版本的服务端不会因此被拦（闸门失败时放行）。
- 未来依赖更新 Forgejo 版本的新端点（如 v17 的 rerun API）同样按特性闸门处理，不会抬升整体最低版本。

## MCP Server（AI Agent 集成）

扩展内置 MCP Server，让 Copilot agent mode 等 AI 助手可以用自然语言查询你的 Forgejo 实例。

- **零配置**：每个已配置且已保存 access token 的 Forgejo 实例都会通过 VS Code 的 `contributes.mcpServerDefinitionProviders` API 各自暴露为一个 MCP server，agent 可以在同一会话中访问多个实例，无需任何额外设置，也不用单独启动服务。
- **要求**：VS Code ≥ 1.102，且至少配置了一个带 access token 的实例；不满足时静默不注册。
- **使用方式**：在 Copilot 聊天中切换到 agent mode，直接用自然语言提问，例如「list my issues」或「看一下这个仓库最近一次失败运行的 CI 日志」。
- **代理**：请求会遵循编辑器的 `http.proxy` 设置，其优先级高于环境变量 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`（三者的大小写拼写都会读取），该设置会以 `FORGEJO_MCP_PROXY` 转发给 MCP 服务进程。
- **工具概览**：29 个工具，分为四组——
  - **基础**：Issue、PR、时间线、通知、仓库信息与搜索（如 `list_issues`、`get_pull_request`）。
  - **Actions**：运行历史、run 的 job 列表、job 日志、CI 失败摘要与制品（如 `list_action_runs`、`get_action_run_jobs`、`get_action_job_log`、`get_ci_failure_summary`）。
  - **代码读取**：文件内容与目录列表、仓库内文件搜索、分支、标签、提交、文件历史与 PR diff（如 `list_repo_contents`、`get_file_content`、`search_repo_files`、`get_pr_diff`）。
  - **Review 与元数据**：PR 评审、Release、标签、里程碑与自己的仓库（如 `list_pull_reviews`、`whoami`）。
- **安全说明**：
  - 全部工具均为只读（`readOnlyHint`），agent 无法修改实例上的任何数据。
  - 由于是只读工具，VS Code 不会在每次调用前弹确认框。约束来自工具面本身：每个工具都只映射到 `GET` 接口（唯一例外是 `get_workspace_repository`，它只读取扩展在本地发布的状态文件），且所有会进入请求路径的输入（`owner`、`repo`、文件路径）都做了校验，构造参数无法跳到其他接口。
  - token 从 SecretStorage 经进程环境变量注入 stdio 子进程，不会出现在工具 schema、工具结果或日志中。
  - 过大的响应字段与超长结果会被截断，保护 agent 的上下文窗口。
  - 增删实例后会自动重新解析暴露的 server。
  - 本 server 自身不发起任何模型调用（不使用 MCP sampling），因此 VS Code 服务器菜单里对所有 MCP server 都显示的「配置模型访问」项对本扩展没有实际作用。

### 在 Agents 窗口（或任何静态 `mcp.json` 宿主）中使用

上面的 server 是由扩展贡献的，而 VS Code **不会**在 Agents 窗口（Agent Host）会话中解析扩展贡献的 MCP server——这是平台限制。要在那里使用，通过一份静态 MCP 配置注册它，配置指向扩展在 globalStorage 里维护的 **shim**：

```json
{
  "servers": {
    "forgejo": {
      "command": "node",
      "args": ["%APPDATA%\\Code\\User\\globalStorage\\cpf23333.forgejo-toolkit\\mcp-server.js"]
    }
  }
}
```

globalStorage 目录因平台而异：Windows 上是 `%APPDATA%\Code\User\globalStorage\cpf23333.forgejo-toolkit`，macOS 上是 `~/Library/Application Support/Code/User/globalStorage/cpf23333.forgejo-toolkit`，Linux 上是 `~/.config/Code/User/globalStorage/cpf23333.forgejo-toolkit`（Insiders 版本把 `Code` 换成 `Code - Insiders`）。

有三个文件可以承载这段配置，读取方各不相同：

- **`<profile>/User/mcp.json`**（推荐）——VS Code 的用户级 MCP 注册表：对当前 profile 的所有工作区生效，且 VS Code 会把它转发给 Agent Host 会话。
- **工作区内的 `.vscode/mcp.json`**——VS Code 只为该工作区读取它，并以同样方式转发。
- **工作区根目录的 `.mcp.json`**——只有 Agent Host 原生读它：VS Code 自己会忽略（报 "Cannot start unknown MCP server customization"），而开启工作树隔离的会话根本看不到它，因为会话的工作区是隔离的 worktree，不是你的检出目录。

最简单的做法是运行 **Forgejo Toolkit: 为 Agents 窗口复制 MCP 配置** 命令——它可以把片段合并进用户级 `mcp.json` 或工作区 `.vscode/mcp.json`，也可以复制到剪贴板。无论哪种方式，路径都是 shim `mcp-server.js`，而不是真正的 server bundle：扩展每次激活都会重写 shim 指向当前安装目录，所以配置在扩展升级后依然有效（它替代了带版本号的 `cpf23333.forgejo-toolkit-<版本>` 安装路径，后者升级即失效）。

无需任何环境变量：server 会自己发现扩展发布的实例注册表，并通过匹配会话工作区的 git remote 来选择实例（工作目录由会话的工作区决定，与配置文件无关）。如果 `env` 里没有 `FORGEJO_MCP_TOKEN`，则以匿名方式只读——只能看到公开数据。零配置版本不含任何秘密，但一般仍建议不要把工作区 `mcp.json` 提交进 git：机器相关的绝对路径（以及一旦你加了 `env` 块后的 token）不属于仓库。

**无需在配置里写 token 也能认证（broker 模式）**：只要扩展在任一窗口中运行，静态启动的 server 就不会停留在匿名状态——它会透明地转发到扩展宿主进程内的本地 broker（Windows 上是命名管道，其他平台是 unix socket），真正的工具逻辑带着 token 在宿主进程里执行。token 始终不出扩展进程，也不会落进 `mcp.json`；授权转发器的是扩展 globalStorage 里发布的、每次启动随机生成的握手密钥（只有你自己的用户可读）。当没有任何扩展窗口运行时，同一份静态配置仍然可用——只是降级为匿名只读。两种方式都不需要额外配置。

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

Changesets 生成的是包内的 `packages/forgejo-toolkit/CHANGELOG.md`；根目录的
`CHANGELOG.md` 是面向用户的正式变更日志，也是 Codeberg Release 说明的来源，因此由人工
撰写，并与随扩展发布的副本保持一致（见 `docs/release.md`）。

## 项目状态

这是一个个人业余项目，各项功能仅经过简单测试，可能存在 bug 和未覆盖到的边界情况。如遇到问题，欢迎提交 issue。

## 反馈与贡献

欢迎提交 bug 反馈、功能建议、Pull Request、文档改进，以及任何其他形式的反馈。  
如果你有更好的交互、布局、流程或其他想法，欢迎通过 Issue 或 Discussion 提出。

## License

[MIT](./LICENSE)
