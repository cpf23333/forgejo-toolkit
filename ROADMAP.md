# Forgejo Toolkit 功能规划

## 已完成

### 多实例管理

- 添加、删除、测试连接多个 Forgejo/Codeberg 实例。
- 使用 VS Code SecretStorage 安全保存 access token。

### Dashboard 面板

- 标签页切换：Repositories / Issues / Pull Requests；Issues / Pull Requests 页签按当前账号筛选（本人创建、被指派、被提及、待评审），不返回实例全量数据。
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
- 打开 worktree 前检测当前 workspace 是否就是 PR base repo。
- 未配置打开方式时弹窗询问（新窗口 / 当前窗口），并支持记住选择。
- 本地没有源仓库时支持：clone 到缓存目录、选择已有本地仓库、取消。
- worktree 目录命名包含 sanitized PR title。
- 打开已存在的 worktree 前校验 PR head：过期时重新创建，本地有未提交改动或本地提交时必须确认后才丢弃，避免静默删除本地工作。

### 设置页

- 语言切换、调试日志开关。
- 添加 / 删除 / 修改 Forgejo 实例，测试连接。
- 配置 PR worktree 打开方式和缓存目录，支持文件夹选择器。
- 列出已创建的 worktree。

### 国际化

- 支持中文 / 英文切换。
- 扩展清单（名称、简介）与包内 README 中英双语，扩展详情页跟随 VS Code 显示语言。

### 调试日志

- 设置页提供 debug 开关。
- 输出 API 请求 URL、状态码、响应体到 `Forgejo Toolkit` Output Channel。

### API 客户端

- 基于 Forgejo OpenAPI 规范使用 Kubb 生成 `@cpf23333-forgejo-toolkit/api`。
- 源码交付，无 build/pack 步骤。
- 共享请求客户端放在 `@cpf23333-forgejo-toolkit/shared`。

### 工程规范

- 使用 `vue-tsc` 推导 `.vue` 组件类型，并开启 `strictTemplates` 进行严格模板类型检查。
- `@vscode-elements/elements` web components 直接在 webview 中使用，不再维护 Vue wrapper 包；为所有使用的原生组件补充 `DefineCustomElement` props / events 类型声明。
- 使用 `oxlint` + `oxfmt` 作为 lint/format 工具。
- 使用 Changesets 管理 monorepo 版本号与 CHANGELOG。
- 图标统一使用 VS Code `codicon`（含 EasyMDE 工具栏的自定义按钮），已移除 `font-awesome` 依赖。

### Mock 与测试

- 接入 MSW mock：覆盖核心 API 端点的 fixtures 与 handlers，支持离线开发（`forgejoToolkit.useMockApi`）。
- `ForgejoClient` MSW 测试覆盖所有公开方法；shared request 客户端单元测试。
- webview `ModalDialog`、`FileTreeItem` 组件测试与 `useAppState` 的 API 调用 / 消息处理单元测试。

### Issue / PR 详情

- Issue / PR 列表与详情页。
- Issue / PR 描述的 Markdown 渲染与附件列表。
- Issue / PR 详情页：展示评论、diff、时间线。
- PR 详情页 diff 增强：按提交查看 diff，列出每个 commit 的变更文件并支持单提交 diff 预览。
- PR 详情页改为左右两栏布局。
- PR 详情页右侧栏展示标签、负责人、里程碑、到期时间、引用、参与者。
- PR 详情页支持反应表情、订阅/取消订阅通知、时间追踪、依赖议题管理。
- PR 详情页显示合并状态及具体阻塞原因（冲突、需要审查、状态检查未通过等）。
- PR 详情页直接展示 CI / commit status 列表。
- PR diff 使用 `merge_base` 与 `head.sha`，避免 fork PR 内容漂移。
- 打开 PR 的新增/删除文件时给出状态提示。

### Issue / PR 操作

- 创建 Issue / PR：仓库 Issue/PR 列表页提供新建弹窗。
- 编辑 / 关闭 / 重新打开 / 删除 Issue 和 PR：详情页弹窗编辑，保存成功后重新获取详情；删除 Issue 需二次确认。
- 编辑弹窗使用原生 `<dialog>` 封装，不留下路由历史。
- 为 Issue / PR 添加评论，支持附件上传。
- 合并 PR，支持 merge / squash / rebase 策略。
- 撤销已合并 PR（Revert merge commit）：在本地仓库执行 `git revert -m 1` 并 push。
- Issue 详情页支持订阅/取消订阅通知、时间追踪、依赖议题管理。
- PR 编辑表单支持负责人、标签、里程碑、到期时间、引用分支/标签。
- 自研 VS Code 风格日期时间选择器，替代浏览器原生 `datetime-local`/`date` 输入；集成到 Issue / PR 创建与编辑表单、详情页到期时间编辑。
- 从代码中的 TODO / FIXME 注释快速创建 Issue：CodeAction 快速修复，正文自动附带源码永久链接。

### PR Review

- PR 内联 review 评论（行级评论）：支持在 VS Code 原生 diff 中查看、添加、删除评论。
- PR diff 行级评论富文本输入：使用独立 webview panel 内嵌 EasyMDE，提供 Markdown 工具栏、预览、@/# 提及、图片附件上传；支持「添加单条评论」和「开始评审/继续评审/提交评审」两种模式。
- 提交评审时支持选择结论：评论 / 批准（Approve）/ 要求修改（Request changes），编辑器中的文本作为评审总结一并提交。
- 多行 review 评论：在 diff 编辑器中拖选多行创建评论（Forgejo `extra_lines_count` 语义），与网页端多行评论互通。

### 富文本编辑器与附件

- 集成 EasyMDE 富文本编辑器，支持描述编辑。
- 富文本内图片上传，上传后固定插入 `![image](/attachments/{uuid})` 格式。
- 编辑弹窗内支持附件上传与删除。
- 附件删除改为 pending 模式：标记后随保存一起提交，取消编辑则放弃删除。
- 保存成功后重新获取详情，确保附件等数据最新。
- Issue / PR / Release / 评论创建时支持 pending 附件，创建实体后自动上传。
- 新建 Release 时支持多文件附件选择。
- 提取 PendingAttachmentList 组件，统一 pending 附件列表的展示与 object URL 管理。

### 仓库浏览

- 文件浏览器：目录树展示、文件内容查看、代码高亮由 VS Code 自动处理。
- 文件浏览器增强：文件搜索、文件历史、文件夹展开 loading 指示器。
- 分支 / 标签 / Release 管理：在仓库详情页展示列表、切换标签页查看，并支持创建 / 删除分支、创建标签 / Release。
- README Markdown 渲染预览：在仓库详情页点击「预览 README」，通过 VS Code 原生 Markdown 预览打开。

### 本地仓库自动关联

- 根据当前 workspace 的 git remote 自动识别 Forgejo 仓库和对应实例。
- 在 Dashboard 顶部显示关联仓库卡片，支持快捷打开仓库、Issues、Pull Requests。
- workspace 文件夹变化或实例增删时自动重新检测。
- 发布本地仓库到 Forgejo：「Publish to Forgejo」命令引导选择实例、仓库名与可见性，自动创建远程仓库、添加 origin 并推送当前分支；已关联 Forgejo 仓库时该命令直接推送当前分支。
- 推送前校验 git 实际使用的推送目标（含 `remote.<name>.pushurl` 与 `url.<base>.pushInsteadOf`）属于目标实例，不一致则中止，token 不会被发往其他主机。
- 作为 VS Code Git clone 源：已配置实例注册为 `RemoteSourceProvider`，「Git: Clone」快速选择中按关键字在服务端搜索仓库克隆，无关键字时列出当前用户仓库。
- 多仓库 / 嵌套仓库 workspace：workspace folder 一层子目录中的独立 git 仓库（含 repo 内嵌套 repo）参与关联检测，按当前文件/活动编辑器归属仓库，多仓库歧义时交互命令弹 QuickPick 消歧。
- 多 remote 仓库：一个仓库配置多个 git remote 时，任一 remote 匹配已配置实例即参与关联（origin 优先）；Publish 命令可选择推送到匹配的 remote。
- Dashboard 关联仓库卡片列出全部已关联仓库，可手动切换关注对象；活动编辑器切换时自动跟随归属。
- Start Work on Issue：Issue 详情页一键从默认分支创建 `issue-<编号>-<标题>` 分支与 worktree 并打开。

### 状态栏

- 当前 workspace 关联 Forgejo 仓库、当前分支非默认分支且无开放 PR 时，状态栏显示「创建 PR」按钮；点击按需推送分支并打开预填 head/base 的新建 PR 弹窗。
- 分支已有开放 PR 时显示「PR #n」，点击直达 PR 详情。
- 通过监听 `.git/HEAD` 与实例变更事件驱动刷新，不轮询。

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
  - 导入条目复用了已存在的实例 id 但 origin 不同时，不接受原 token（需重新输入），避免凭据被带到其他主机。
  - 导入后自动恢复语言、调试开关、worktree 配置，并自动跳转到 Dashboard。
- 移除实例前二次确认。
- onboarding 面板与侧栏主视图通过事件同步实例变更。

### CI / Actions

- 读取仓库 Actions 运行状态和历史。
- 运行列表分页累加加载（Load more），翻到末页后保留已加载内容。
- 在 PR 详情页展示状态检查（status checks）列表，帮助判断是否可以合并。
- Actions 运行详情页：展示 job 列表、job 日志、制品列表。
- Actions 制品本地下载：通过 API 获取 ZIP 并调用系统 save dialog。
- Actions 运行详情页支持取消正在运行的记录。
- Actions 远程触发 workflow，支持输入参数，并轮询展示运行状态。

### MCP Server

- 通过 VS Code `contributes.mcpServerDefinitionProviders` 将每个已配置且存有访问令牌的 Forgejo 实例各暴露为一个 MCP 服务器（每实例一个 definition，label 为 `Forgejo: <实例名>`），供 Copilot agent mode 等 MCP 客户端使用，零配置（VS Code ≥ 1.102）。
- token **不再经进程环境变量注入 stdio 子进程**：每个 definition 的 `env` 只有身份（实例 URL / 实例 id / 同步开关 / 本窗口工作区状态文件 / 可选代理）加 `FORGEJO_MCP_BROKER_ONLY=true`——VS Code 会把已注册定义的全部内容（含 `env`）以明文持久化到 profile 的 workspace storage，写进 token 就等于把凭据落在 SecretStorage 旁边的磁盘上。子进程改为转发到扩展宿主内的本地 broker，由宿主用 SecretStorage 里的 token 执行工具调用；broker 对握手里显式给出的实例 id 解析不到带 token 的实例时**拒绝该会话**。**没有存活的 broker 时不下发任何 definition 并记录原因**（宁可不提供，也不发布一个看起来已认证、实际匿名读取的 server）。无实例或无 token 时静默不注册（无 token 的实例逐个跳过并记 debug 日志），实例增删后自动重解析。token 不出现在定义、工具 schema / 结果 / 日志中。
- 工作区 → 仓库映射工具 `get_workspace_repository`：宿主把当前工作区链接到的仓库按窗口写入 `globalStorage/mcp-workspace-<pid>-<nonce>.json`（复用检测的共享扫描缓存，串行化的原子写入，不含凭据），路径经 `FORGEJO_MCP_STATE_FILE` 传给 MCP 子进程；子进程每次调用实时重读，按实例 id（旧版宿主回退到实例 URL）过滤，并能把属于其他实例的仓库指向对应的服务器。AI 在用户说「这个仓库 / 当前项目」而未给 owner/repo 时先调它。
- Phase 1 只读工具集（全部标记 `readOnlyHint`，大字段截断保护上下文）：
  - 基础工具：Issue / PR / 时间线 / 通知 / 仓库信息 / 全局搜索。
  - Actions 扩展：运行历史、job 列表、job 日志、制品列表。
  - 代码读取扩展：文件内容、目录列表、分支、标签、提交、文件历史、仓库内文件搜索、PR diff。
  - Review 与元数据扩展：PR 评审、whoami、Release、标签、里程碑、当前用户仓库列表。
- 工具入参校验：`owner`/`repo`/文件路径拒绝路径分隔符与 `..`（生成客户端会原样拼接 URL），并限制单次结果总量（64 KB，带截断标记）。
- 只读工具不弹确认框（`readOnlyHint` 的既定行为），保证来自工具面本身：全部映射到 `GET`，路径类入参均校验。
- MCP Prompts：三个只读提示模板 `review-pull-request` / `analyze-ci-failure` / `triage-issue`，把工具按固定顺序串成工作流并规定回答结构（评审意见、CI 根因、issue 分诊建议）。参数全部可选：缺省 owner/repo 时指引先调 `get_workspace_repository`，缺省编号时指引先用对应的列表工具解析。提示模板本身无副作用，不改动只读工具面与安全模型。
- MCP broker 模式：静态 `mcp.json`（Agents 窗口 / 第三方 MCP 客户端）拉起的 server 在扩展宿主运行时变成纯转发器——首行握手（每次启动随机生成的密钥，发布在 globalStorage 的 `mcp-broker.json`，同用户可读）后把 stdio 逐行桥接到宿主的命名管道 / unix socket，真正的工具逻辑带 token 在扩展宿主进程里执行，token 不出边界。**扩展自己提供的 definition 也走同一条转发路径**（它同样不带 token），握手里额外带上该 definition 的实例 id、本窗口的工作区状态文件与同步开关。每连接一个独立 MCP server 实例；实例解析**先看握手里的显式实例 id**（解析不到就拒绝会话），没有时按会话 cwd 命中的已链接检出，找不到时用第一个有 token 的实例。多窗口只留第一个绑定成功的 broker，其余静默让位；**静态** `mcp.json` 启动在 broker 不可达时降级到匿名零配置启动，扩展提供的 definition 则带 `FORGEJO_MCP_BROKER_ONLY`，此时记 stderr 日志并以退出码 1 结束（不降级）。
- 面向 agent 上下文预算的 CI 失败摘要工具 `get_ci_failure_summary`：一次调用取 run 内每个失败 job 的错误行（各带 2 行上下文）与日志尾部（约 100 行），并标注每处截断——包括客户端 10 MB 上限只保留头部、导致真实尾部不可见的情形；替代连续调用 `get_action_run_jobs` + 每个失败 job 一次 `get_action_job_log`，并避开后者「只保留日志头部 10 KB」而恰好丢掉失败信息的问题。提取文本按共享预算预分片，不依赖 `truncateLargeStrings` 兜底。
- 面向 agent 上下文预算的 PR 评审摘要工具 `get_pr_review_brief`：一次调用返回 PR 头部（标题/状态/作者/基头分支/合并阻塞）、diff 统计（文件数与总增删行，外加按文件的增删行表——不含 diff 文本）、每个 reviewer 的最新结论与汇总判断、以及未解决的 inline 评审评论（path/line/作者/时间/正文），替代评审起步时的 `get_pull_request` + `get_pr_diff` + `get_pr_timeline` + `list_pull_reviews` 四次调用；描述注明 diff 文本、描述、commit 与时间线仍需按需回退原工具。评论按 review 逐条读取（上游没有一次取全的端点），以 4 并发有界扇出，单个 review 读取失败只计入 `unreadableReviewCount`；被解决的会话按 Forgejo 只写在首条评论上的 `resolver` 整体排除。各段预分片（文件表 100 行/16 KB，评论 50 条/24 KB、单条正文 1 KB），`truncated`/`truncatedBy`/`bodyTruncated` 标注每处裁剪且总数保持精确，不依赖 `truncateLargeStrings` 兜底。

### 0.0.1 之后（首个发布版之后的加固与优化）

- **MCP 开关**：`forgejoToolkit.mcpEnabled`（默认开）。关闭时不注册 MCP server 定义、不维护 shim / 实例注册表 / 工作区映射，并停掉本地 broker；共享的 shim 与注册表文件保留（其他窗口可能仍开着），已连接的客户端继续使用它已启动的进程直到重载窗口。运行时切换即刻生效，不留陈旧监听。
- **Copilot 指令生成命令**：`forgejoToolkit.writeCopilotInstructions` 走既有归因路径解析工作区仓库，在 `<仓库根>/.github/copilot-instructions.md` 创建 / 追加 / 原地更新一段声明（只声称只读能力），标记不完整或重复时**完全不写入**并警告，URL 去凭据、原子写入。
- **Webview 入口按面拆分**：dashboard / onboarding / 评论编辑器各自一份 HTML 与入口模块，面板不再下载 dashboard 外壳（onboarding −15.9%、评论面板 −28.8%），并加构建期图断言：面板一旦触达 `App.vue`/router/vue-router 或未使用的 `@vscode-elements` 模块即构建失败。
- **消息目录按语言拆分**：三面共用的 vendor chunk 里，两份目录实测占 31.3%（49,574 B）；改为 `en` 静态作基语言与回退、`zh` 动态导入成独立 chunk（20,815 B，任何面都不预加载）后，vendor chunk 158,289 → 118,495 B，dashboard −5.4%、评论面板 −5.8%。语言切换仍是原子的：先加载目录再发布、被取代的请求丢弃、加载期间显示旧语言、失败保留旧语言。
- **MCP broker 窗口间自动交接**：让位窗口每 5 s 检查注册文件里的 pid，持有者正常关闭或被强杀后自行重新绑定（`listen` 即仲裁，无文件锁/无选举），失败一律不重试；定时器 `unref` 且随停用/关闭开关清理。之前「关掉持有窗口后其余窗口永不接管、必须重载或切换设置」的行为由此消除，令牌始终不出 SecretStorage/扩展宿主。
- **多窗口轮询租约：阶段 0（不接线）**：`src/lease/` 落地常量、类型、**纯决策函数**与 IO 层（唯一仲裁 `fs.open(path,'wx',0o600)`；心跳重试 3 次/250 ms，连续失败 >2× 过期才降级；任何不确定都退化为全速轮询），配 88 个用例——含**反向守卫**（模块内出现 `globalState` 或单窗口分支即失败）与 **5 个并发者的真实文件系统互斥**（主线程 + 4 个 `worker_threads`，会合屏障后同时抢占，25 轮恰好一个赢）。
- **harness：共享 profile 双窗口模式**：`tools/ui-review/src/dual.ts` 在既有「每次 launch 一个隔离 profile」之上加第二窗口（运行实例内 `Ctrl+Shift+N`；`code --new-window` 只会重载，实测无效），两窗口分别可按 target id 寻址、可单独杀掉自己的扩展宿主、日志按窗口抓取。真机验证通过，并因此修掉三个缺陷（CDP 的 `id` 被读成 `targetId`、本版 VS Code 的扩展宿主进程形态、失败启动留下孤儿窗口）。
- **多窗口轮询租约：阶段 1（影子接线）**：`leaseSupervisor.ts` 接入 `extension.ts`（仅 start/dispose，14 行；轮询与提示路径零改动），真实参与选主、心跳、让位与 `releaseStale`，并按 §7.1 打日志、影子记录焦点。**行为零变化**由两层保证：每行日志都带 `polling=unchanged`，且结构性守卫禁止租约被 `notifications/**` 引用、禁止出现抑制轮询的导出。真机双窗口实测：一个 leader 每 10 s 心跳、另一个 follower，杀掉持有者后幸存窗口 **11–13 s** 接管（pid 探测短路了原以为要等的 35 s 过期）。
- **多窗口轮询租约：阶段 1 的两处 soak 修复**：真机双窗口跑出两个只有实测才能发现的缺陷并修掉——加速接管的陈旧阈值（5 s）**低于心跳周期**（10 s），健康持有者常态被判陈旧，改为 **30 s = 3 × 心跳**并让加速路径同时受 N 约束；**让位守卫写反**（自己不聚焦时反而保持），在同实例两窗口都自报 focused 的形态下导致每 ~17 s 换手一次（90 s 内 12 claims / 10 yields），改为「只有自己不聚焦时才让位」。同时记录平台事实：逐窗口焦点保真度需按平台验证，不可信时的正确降级是**完全不换手**（什么都不丢）。**2026-09-27 追加发现（休眠分支）**：在出厂常量下 `follower-takeover-accelerated` **不可达**——该分支要起作用只能落在「心跳已陈旧、但尚未过期」的那个窗口里，而它的宽度只有 `LEASE_EXPIRY_MS − LEASE_ACCELERATED_STALE_MS = 35 s − 30 s = 5 s`；一个已聚焦的 follower 却要先等去抖 `H = 12.5 s` 才发出第一个请求，再累积 `K = 3` 次未获响应（2 s 一次 tick，约 6 s）才升级，合计 18.5 s > 5 s，记录总是先过期。因此今天真正生效的接管路径是「文件消失」与「过期」，加速臂是一条**保持正确但休眠**的分支（实施者把这条算术写进了 `leasePollingGate.test.ts` 的断言）；只有将来重调 H/N/K 或心跳周期时它才可能活过来，在那之前**不要为此改常量**。
- **多窗口轮询租约：阶段 2（默认开启）**：新增设置 `forgejoToolkit.multiWindowLease`（默认 `true`）；机制健康时**只有持有者轮询与提示**，follower 停止轮询/提示且在被接管后**立即**轮询一轮；**任何不确定一律退化为全速轮询**（失败即放行的安全轨，poller 只是纯增量接入）。配套交付：机制不可用时的一次性提示（可一键复制诊断或关闭设置）、`Forgejo Toolkit: Copy Polling Diagnostics` 命令（schemaVersion 1 的七组字段，硬脱敏：无令牌/授权头/SecretStorage 值）、`KNOWN_ISSUES`×2 改写、两份 `CHANGELOG` 一致地标注**默认行为变化**。
- **精确截断**：`X-Total-Count` 贯通到全部列表方法（含 11 个此前只返回裸数组的方法新增 `<name>WithTotal` 形式）与 MCP 工具结果，恰好 500 条的完整列表不再被说成截断，真实被截断时报出真实数字；`get_pr_review_brief` 的 `reviewStatus.truncated` 同样按服务端总数判断。
- **结构化错误契约**：`shared/request` 抛 `RequestError{status,statusText,headers,body}`（消息格式不变），宿主从字段分类与渲染服务端消息，正则只作为外来错误回退。
- **列表回包按请求归属**：三个列表命令（`getRepositories`/`getMyIssues`/`getMyPullRequests`）请求带 `_requestId`、宿主原样回显、webview 严格按 id 归属——被替换服务器的迟到回包在**任意到达顺序**下都不会再写进列表或缓存；向导面板同样回显。
- **多窗口通知基线合并**：已读基线改为「只覆盖本窗口拥有的条目」的合并写，删除也要求「配置里没有了 且 本窗口拥有」，窗口之间不再互相清空基线。
- **凭据轮换后重新提示**：401/403 提示的去重键折入所失败凭据的指纹（SHA-256 前缀 + 长度），同一 URL 换了令牌会重新提示，令牌本身不入日志、不入提示。
- **创建 PR 状态栏按分支查询**：改用拉取列表的 `head` 过滤 + 命中即停的分页（常见的首页命中 10 次请求 → 1 次），"可能超出上限"的警告只在真的没找到时出现。
- **可访问性与播报**：16 处进度环改用本地化的 `aria-label`（此前每次都播报英文 "Loading"）；Test/Save 结果进 live region；视图过滤控件不再冒充 tab 关系；`openDashboard` 不再重挂载与重复播报；依赖/反应/标签等失败不再伪装成空结果；计时器状态读不到时不再显示为"未运行"。
- **MCP shim 修复**：`91b7650` 改 ESM 后 shim 写成驱动器路径，Windows 上被 ESM 加载器拒绝（外部启动器完全起不来）；改用 `pathToFileURL` 生成的 `file://` 说明符，并补一条真正解析该说明符的测试。
- **两份设计文档**（实现待定）：`docs/design/mcp-write-tools-confirmation.md`（写工具的人类确认模型）与 `docs/design/multi-window-polling-lease.md`（多窗口轮询租约）。

## 后续迭代

### 设置与数据

- 设置同步（可选 VS Code Settings Sync）。

### 旧版本 Forgejo / Gitea 兼容

- 测试并兼容不同 Forgejo 版本（如 1.x、7.x、9.x）的 API 差异。
- 评估对 Gitea 的兼容支持，处理 API 路径、字段、认证方式的差异。
- 在设置中允许用户手动声明服务器版本（自动探测已交付：激活时会探测每个已配置实例的版本，用于功能闸门并在版本低于支持下限时给出软提示；目前缺少的只是手动覆盖入口）。

## 长期可能

- 多账号权限管理：区分只读 / 读写 token。
- MCP Server Phase 2：写操作工具（默认关闭、逐项开启）。
- 文件浏览器增强：文件重命名 / 删除（目前更推荐本地 clone 后操作）。
- 构建工具统一：将 extension host 打包从 esbuild 迁移到 Rolldown。已评估：可行但收益有限，暂缓实施；需验证 Node builtins 处理、CJS 输出、sourcemap、minify、watch 模式等能力。
