# Forgejo Toolkit 功能清单

功能清单：按状态分类（进行中 / 已完成 / 未完成），只列插件面向用户的能力；功能级的现状在这里，具体待办、阻塞与下一步动作在 `TODO.md`。

## 已完成

### 多实例管理

- 添加、删除、测试连接多个 Forgejo/Codeberg 实例。

### Dashboard 面板

- 标签页切换：Repositories / Issues / Pull Requests；Issues / Pull Requests 页签按当前账号筛选（本人创建、被指派、被提及、待评审）。
- 按实例折叠展示数据，折叠面板标题显示服务器地址和当前账号。
- 仓库卡片：名称、描述、默认分支、star/fork、右侧图标支持在浏览器打开和复制克隆地址。
- Issue / PR 卡片：编号、标题、状态、仓库名、复制链接图标。
- 仓库详情页：README、分支列表、最近 commits、返回 Dashboard。
- 初次使用引导页：以编辑器页签形式打开，支持语言、服务器、worktree 配置。
- 首次安装引导：Walkthrough 三步入门指南（添加实例 → 打开仪表板 → 发布/创建 PR，中英双语）；首次激活且无实例时自动打开引导页。

### Pull Request Worktree

- 在 PR 详情页提供「在 Worktree 中打开」按钮。
- 自动 bare clone 源仓库到缓存目录，基于 `refs/pull/<index>/head` 创建本地分支和可编辑 worktree。
- 支持配置 worktree 打开方式（新窗口 / 当前窗口）和缓存目录。
- 设置页管理已创建的 worktree（打开、删除）。
- 未配置打开方式时弹窗询问（新窗口 / 当前窗口），并支持记住选择。
- 本地没有源仓库时支持：clone 到缓存目录、选择已有本地仓库、取消。

### 设置页

- 语言切换、调试日志开关。
- 添加 / 删除 / 修改 Forgejo 实例，测试连接。
- 配置 PR worktree 打开方式和缓存目录，支持文件夹选择器。
- 列出已创建的 worktree。

### 国际化

- 支持中文 / 英文切换。

### 调试日志

- 设置页提供 debug 开关。
- 输出 API 请求 URL、状态码、响应体到 `Forgejo Toolkit` Output Channel。

### Issue / PR 详情

- Issue / PR 列表与详情页。
- Issue / PR 描述的 Markdown 渲染与附件列表。
- Issue / PR 详情页：展示评论、diff、时间线。
- PR 详情页 diff 增强：按提交查看 diff，列出每个 commit 的变更文件并支持单提交 diff 预览。
- PR 详情页右侧栏展示标签、负责人、里程碑、到期时间、引用、参与者。
- PR 详情页支持反应表情、订阅/取消订阅通知、时间追踪、依赖议题管理。
- PR 详情页显示合并状态及具体阻塞原因（冲突、需要审查、状态检查未通过等）。
- PR 详情页直接展示 CI / commit status 列表。

### Issue / PR 操作

- 创建 Issue / PR：仓库 Issue/PR 列表页提供新建弹窗。
- 编辑 / 关闭 / 重新打开 / 删除 Issue 和 PR：详情页弹窗编辑，保存成功后重新获取详情；删除 Issue 需二次确认。
- 为 Issue / PR 添加评论，支持附件上传。
- 合并 PR，支持 merge / squash / rebase 策略。
- 撤销已合并 PR（Revert merge commit）。
- Issue 详情页支持订阅/取消订阅通知、时间追踪、依赖议题管理。
- PR 编辑表单支持负责人、标签、里程碑、到期时间、引用分支/标签。
- 自研 VS Code 风格日期时间选择器，替代浏览器原生 `datetime-local`/`date` 输入；集成到 Issue / PR 创建与编辑表单、详情页到期时间编辑。
- 从代码中的 TODO / FIXME 注释快速创建 Issue：CodeAction 快速修复，正文自动附带源码永久链接。

### PR Review

- PR 内联 review 评论（行级评论）：支持在 VS Code 原生 diff 中查看、添加、删除评论。
- PR diff 行级评论富文本输入（独立编辑面板）：Markdown 工具栏、预览、@/# 提及、图片附件上传；支持「添加单条评论」和「开始评审/继续评审/提交评审」两种模式。
- 提交评审时支持选择结论：评论 / 批准（Approve）/ 要求修改（Request changes），编辑器中的文本作为评审总结一并提交。
- 多行 review 评论：在 diff 编辑器中拖选多行创建评论，与网页端多行评论互通。

### 富文本编辑器与附件

- 描述编辑使用带 Markdown 工具栏与预览的富文本编辑器。
- 富文本内图片上传，上传后固定插入 `![image](/attachments/{uuid})` 格式。
- 编辑弹窗内支持附件上传与删除。
- Issue / PR / Release / 评论创建时支持 pending 附件：先选好附件，实体创建成功后自动上传。

### 仓库浏览

- 文件浏览器：目录树展示、文件内容查看、代码高亮由 VS Code 自动处理。
- 文件浏览器增强：文件搜索、文件历史、文件夹展开 loading 指示器。
- 分支 / 标签 / Release 管理：在仓库详情页展示列表、切换标签页查看，并支持创建 / 删除分支、创建标签 / Release。
- README Markdown 渲染预览：在仓库详情页点击「预览 README」，通过 VS Code 原生 Markdown 预览打开。

### 本地仓库自动关联

- 根据当前 workspace 的 git remote 自动识别 Forgejo 仓库和对应实例。
- 在 Dashboard 顶部显示关联仓库卡片，支持快捷打开仓库、Issues、Pull Requests。
- 发布本地仓库到 Forgejo：「Publish to Forgejo」命令引导选择实例、仓库名与可见性，自动创建远程仓库、添加 origin 并推送当前分支；已关联 Forgejo 仓库时该命令直接推送当前分支。
- 作为 VS Code Git clone 源：已配置实例注册为 `RemoteSourceProvider`，「Git: Clone」快速选择中按关键字在服务端搜索仓库克隆，无关键字时列出当前用户仓库。
- 多仓库 / 嵌套仓库 workspace：workspace folder 一层子目录中的独立 git 仓库（含 repo 内嵌套 repo）参与关联检测，按当前文件/活动编辑器归属仓库，多仓库歧义时交互命令弹 QuickPick 消歧。
- 多 remote 仓库：一个仓库配置多个 git remote 时，任一 remote 匹配已配置实例即参与关联（origin 优先）；Publish 命令可选择推送到匹配的 remote。
- Dashboard 关联仓库卡片列出全部已关联仓库，可手动切换关注对象；活动编辑器切换时自动跟随归属。
- Start Work on Issue：Issue 详情页一键从默认分支创建 `issue-<编号>-<标题>` 分支与 worktree 并打开。

### 状态栏

- 当前 workspace 关联 Forgejo 仓库、当前分支非默认分支且无开放 PR 时，状态栏显示「创建 PR」按钮；点击按需推送分支并打开预填 head/base 的新建 PR 弹窗。
- 分支已有开放 PR 时显示「PR #n」，点击直达 PR 详情。

### 通知与搜索

- Forgejo 通知中心：未读角标、按状态和类型筛选、标记已读/全部已读、Issue/PR 通知直接跳转详情。
- 通知后台轮询与推送：extension host 定期拉取所有实例未读通知，检测到新通知时弹出 VS Code 消息提醒，并自动更新首页铃铛角标；支持开关与轮询间隔配置。
- 全局仓库 / Issue / PR 搜索：跨实例搜索，支持实例、类型、状态筛选。
- 仓库内 Issue / PR 列表支持关键词搜索（服务端 `q` 参数），与状态筛选组合使用。

### 设置与数据

- 实例 URL 同步：当 Forgejo `app.ini` 的 `ROOT_URL` 与用户配置的实例地址不一致时，自动将 API 返回的 URL 重写为配置地址；支持 per-instance 开关，默认开启。
- 实例配置导出 / 导入：支持将已保存实例（含 access token）和设置导出为 JSON 文件，或从 JSON 文件导入。
  - 导出时可选择具体实例、复制到剪贴板、使用密码加密。
  - 导入前预览，显示「已存在」实例的差异和 Token 冲突检测。
  - 导入后自动恢复语言、调试开关、worktree 配置，并自动跳转到 Dashboard。
- 移除实例前二次确认。

### CI / Actions

- 读取仓库 Actions 运行状态和历史。
- 运行列表分页累加加载（Load more），翻到末页后保留已加载内容。
- 在 PR 详情页展示状态检查（status checks）列表，帮助判断是否可以合并。
- Actions 运行详情页：展示 job 列表、job 日志、制品列表。
- Actions 制品本地下载：通过 API 获取 ZIP 并调用系统 save dialog。
- Actions 运行详情页支持取消正在运行的记录。
- Actions 远程触发 workflow：表单读取所选 ref 上 workflow 文件声明的 `on.workflow_dispatch.inputs`（依次查找 `.forgejo/workflows`、`.gitea/workflows`、`.github/workflows`），按声明渲染控件——`string` 文本框、`boolean` 复选框、`choice` 用 `options` 生成下拉框，其他类型（如 `number`、`environment`）退化为文本框——并显示输入名与 `description`、预填 `default`、标出 `required` 且在必填为空时拒绝提交。文件读取或解析失败（私有路径、不支持的写法、没有 `inputs`、接口报错）时回退到原始键值对输入、在界面上说明当前模式，且切换模式不会丢弃已填写的值；触发后轮询展示运行状态。

### MCP Server

- 通过 VS Code `contributes.mcpServerDefinitionProviders` 将每个已配置且存有访问令牌的 Forgejo 实例各暴露为一个 MCP 服务器（每实例一个 definition，label 为 `Forgejo: <实例名>`；两个实例的 label 相同时——同名，或同一主机上的两个账号——只给相撞的那些追加 `<用户名或实例 id>` 判别符，保证列表里可区分），供 Copilot agent mode 等 MCP 客户端使用，零配置（VS Code ≥ 1.102）。
- 工作区 → 仓库映射工具 `get_workspace_repository`：宿主把当前工作区链接到的仓库按窗口写入 `globalStorage/mcp-workspace-<pid>-<nonce>.json`（复用检测的共享扫描缓存，串行化的原子写入，不含凭据），路径经 `FORGEJO_MCP_STATE_FILE` 传给 MCP 子进程；子进程每次调用实时重读，按实例 id（旧版宿主回退到实例 URL）过滤，并能把属于其他实例的仓库指向对应的服务器。AI 在用户说「这个仓库 / 当前项目」而未给 owner/repo 时先调它。
- Phase 1 只读工具集（全部标记 `readOnlyHint`，大字段截断保护上下文）：
  - 基础工具：Issue / PR / 时间线 / 通知 / 仓库信息 / 全局搜索。
  - Actions 扩展：运行历史、job 列表、job 日志、制品列表。
  - 代码读取扩展：文件内容、目录列表、分支、标签、提交、文件历史、仓库内文件搜索、PR diff。
  - Review 与元数据扩展：PR 评审、whoami、Release、标签、里程碑、当前用户仓库列表。
- MCP Prompts：三个只读提示模板 `review-pull-request` / `analyze-ci-failure` / `triage-issue`，把工具按固定顺序串成工作流并规定回答结构（评审意见、CI 根因、issue 分诊建议）。参数全部可选：缺省 owner/repo 时指引先调 `get_workspace_repository`，缺省编号时指引先用对应的列表工具解析。提示模板本身无副作用，不改动只读工具面与安全模型。
- 面向 agent 上下文预算的 CI 失败摘要工具 `get_ci_failure_summary`：一次调用取 run 内每个失败 job 的错误行（各带 2 行上下文）与日志尾部（约 100 行），并标注每处截断——包括客户端 10 MB 上限只保留头部、导致真实尾部不可见的情形；替代连续调用 `get_action_run_jobs` + 每个失败 job 一次 `get_action_job_log`，并避开后者「只保留日志头部 10 KB」而恰好丢掉失败信息的问题。提取文本按共享预算预分片，不依赖 `truncateLargeStrings` 兜底。
- 面向 agent 上下文预算的 PR 评审摘要工具 `get_pr_review_brief`：一次调用返回 PR 头部（标题/状态/作者/基头分支/合并阻塞）、diff 统计（文件数与总增删行，外加按文件的增删行表——不含 diff 文本）、每个 reviewer 的最新结论与汇总判断、以及未解决的 inline 评审评论（path/line/作者/时间/正文），替代评审起步时的 `get_pull_request` + `get_pr_diff` + `get_pr_timeline` + `list_pull_reviews` 四次调用；描述注明 diff 文本、描述、commit 与时间线仍需按需回退原工具。评论按 review 逐条读取（上游没有一次取全的端点），以 4 并发有界扇出，单个 review 读取失败只计入 `unreadableReviewCount`；被解决的会话按 Forgejo 只写在首条评论上的 `resolver` 整体排除。各段预分片（文件表 100 行/16 KB，评论 50 条/24 KB、单条正文 1 KB），`truncated`/`truncatedBy`/`bodyTruncated` 标注每处裁剪且总数保持精确，不依赖 `truncateLargeStrings` 兜底。
- Phase 2 写工具（首批两个，均默认关闭、各自独立开关）：`create_issue_comment` 在 Issue / PR 下新增一条评论；`submit_pull_review` 提交一个已存在的待处理（pending）评审，结论为 `COMMENT` / `APPROVED` / `REQUEST_CHANGES`（拼写与 Forgejo 的 `ReviewStateType` 一致，非法取值在发请求前即被拒），其中 `APPROVED` 可能满足分支保护要求，且 `APPROVED` 与 `REQUEST_CHANGES` 必须有非空正文。两道闸门：VS Code 每次调用弹确认框，并且要在扩展设置里**按工具**开启（`forgejoToolkit.mcpWriteTools.createIssueComment` / `forgejoToolkit.mcpWriteTools.submitPullReview`）；只有**由扩展宿主建立的会话**才能写，只带你自己配置里 token 的会话会被明确拒绝并指出该打开哪个设置。
- 两个写工具都支持 dry-run（先给出计划，含目标、正文长度与摘要哈希，评审还会说明结论的含义）与幂等键（10 分钟内同一 key 的相同调用只发一次、直接回放上次结果）；每次调用都留下不含正文的审计记录（默认只进 `Forgejo Toolkit` Output Channel，可用 `forgejoToolkit.mcpWriteAuditToFile` 同时落盘，评审记录额外带 `reviewId`）。设计与决定记录见 `docs/design/mcp-write-tools-confirmation.md`。
- 设置 `forgejoToolkit.mcpEnabled`（默认开）：关闭后不注册 MCP server 定义、停掉本地 broker，已连接的客户端继续用已启动的进程直到重载窗口；运行时切换即刻生效。
- Copilot 指令生成命令 `forgejoToolkit.writeCopilotInstructions`：在工作区仓库的 `<仓库根>/.github/copilot-instructions.md` 创建 / 追加 / 更新一段只读能力声明；标记不完整或重复时完全不写入并警告。

### 多窗口轮询租约

- 设置 `forgejoToolkit.multiWindowLease`（默认开）：机制健康时**只有持有者窗口轮询与提示**，follower 停止轮询/提示并在被接管后立即轮询一轮；**任何不确定一律退化为全速轮询**。机制不可用时给一次性提示（可复制诊断或关闭设置），并提供 `Forgejo Toolkit: Copy Polling Diagnostics` 命令（脱敏诊断字段）。

## 未完成

### 近期

- 设置同步：可选接入 VS Code Settings Sync。
- PR 描述生成：按 diff 与提交列表生成描述草稿，填入创建 PR 表单。
- Issue 分诊建议：按内容建议标签与负责人。
- AI 预评审（draft-only）：在 PR diff 视图生成预评审意见，只落成待人工逐条确认的评审草稿。
- 通知讨论摘要：在通知列表总结讨论时间线。

### 等上游

- CI / Actions：Workflow / job 重新运行（rerun）与按 job 过滤日志，两者都等 Forgejo v17 的相关接口；见 `TODO.md` 的「等上游版本」条目。

### 长期

- 旧版本 Forgejo / Gitea 兼容：兼容不同 Forgejo 版本（如 1.x、7.x、9.x）的 API 差异，并评估对 Gitea 的兼容支持（API 路径、字段、认证方式的差异）。
- 手动声明服务器版本：在设置中允许用户手动声明服务器版本。
- 多账号权限管理：区分只读 / 读写 token。
- 文件浏览器增强：文件重命名 / 删除（目前更推荐本地 clone 后操作）。
