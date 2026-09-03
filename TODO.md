# TODO

短期任务清单。已交付功能的完整记录见 `ROADMAP.md` 的「已完成」一节；更早的历史完成记录由本文件的 git 日志保存。

## 待开始

### 高优先级

（空）

### 中优先级

- [ ] 从 TODO/FIXME 注释创建 Issue（CodeAction 快速修复）
- [ ] Start Work on Issue：从 Issue 一键创建分支并 checkout
- [ ] 多仓库 / 嵌套仓库 workspace 支持
- [ ] 作为 VS Code Git clone 源（`RemoteSourceProvider`，支持服务端搜索仓库）
- [ ] 多行 review 评论（Forgejo API 的 `ExtraLinesCount`）：渲染侧把 thread range 扩成多行（容易）；提交侧需先验证锚点语义（`position` 为首行、向后延伸），再改 diff 编辑器选区触发评论的交互（主要工作量）

### 用户视角走查发现的问题（2026-08-24）

按影响排序；多数需要实测确认后单独拆任务处理。

- [ ] 同一实例配置多账号时，仓库关联检测按 `instanceId + owner/repo` 匹配第一个实例，可能以错误身份执行评论/合并等写操作；应提示用户选择或显式绑定仓库到账号
- [ ] Token 过期或 scope 不足时只有报错弹窗，没有修复引导；添加实例表单也应列出推荐 scope 清单
- [ ] 10+ 处 `.catch(() => undefined)` 静默吞错，部分用户操作（如同步）失败时无任何反馈；至少加日志，关键路径提示用户
- [ ] 多根 workspace 下关联检测只取第一个匹配的仓库，状态栏与命令上下文可能张冠李戴
- [ ] 通知轮询默认间隔 300s 延迟偏大，新通知弹窗也无聚合（一次弹多个）；考虑缩短默认值、聚合提示、动作失败时回滚已读标记
- [ ] Review 评论面板是单例（`PullReviewCommentPanel.currentPanel`），一行写到一半切到另一行时面板上下文被替换；需实测确认未提交内容是否丢失，丢失则加确认或缓存草稿
- [ ] `package.json` 的 `publisher` 仍是占位符 `your-publisher-name`，发布前必须改

#### 第二轮走查（同日补充，均有代码证据）

**严重**

- [ ] 首次安装零引导：无 walkthrough / viewsWelcome / 首次激活逻辑，`openDashboard`/`openOnboarding` 等核心命令还被 `when: "false"` 从命令面板隐藏；应加 walkthrough、首启自动打开引导、解禁核心命令
- [ ] client 层 fetch 无 `AbortSignal`/timeout（webview pending 60s 超时与 host 早退回包已在阶段 7 修复；实例能连接但不响应时 host 侧请求仍会悬挂，需给 client 加请求超时）
- [ ] 网络错误与 HTTP 状态码无归类：断网/实例宕机显示 `fetch failed` 英文原文；401/404/409/422 一律 `Failed to X: {raw}`（PR 合并冲突 409 只显示原始报错）；应在 client 层抛结构化错误，按状态码映射 i18n 文案

**中等**

- [ ] 「Open Settings」按钮在侧栏 webview 未打开时静默失效（`publish.ts` 直接 postMessage 给 undefined）；`openSettings`/`openDashboard` 命令统一先 reveal/focus 视图再发消息
- [ ] 长操作（push / clone / 发布）无 `withProgress` 进度反馈，大仓库发布几十秒用户分不清在跑还是卡死
- [ ] Issue/PR 列表无分页（不传 limit/page），超出服务端默认页大小的老条目静默消失；全局搜索 limit 20、通知 limit 50，截断无提示；至少加「加载更多」或截断标识
- [ ] 通知异常不可见：某实例 token 失效且无通知时显示「暂无通知」而非错误；轮询失败只写日志，列表停在旧数据无感知
- [ ] `#`/`@` 补全和文档链接注册到所有文件类型（`scheme: 'file'` 无语言过滤），写 Python `#` 注释、C `#include` 都会触发 issue 补全；限定语言或加行内上下文判断（需实测干扰程度）
- [ ] 403 scope 不足提示每请求弹一次且无去重（轮询 + 手动刷新会持续弹英文 toast）；按 instance+scope 去重，每会话一次并附「打开设置」
- [ ] 报错通知无可行动按钮（24 处 showErrorMessage 仅 1 处带按钮）；无「查看日志」命令，OutputChannel 默认日志不带 URL/状态码
- [ ] 关闭/重开 Issue/PR 失败时错误写入编辑弹窗的 key，用户毫无反馈；需单独的错误展示位

**轻微**

- [ ] 表单/搜索框无 autofocus（新建 Issue、全局搜索进入后不聚焦）
- [ ] 原生 `<select>`/`<checkbox>` 与 vscode-elements 组件混用（GlobalSearch、IssueDetail 依赖选择），观感与键盘体验不统一
- [ ] 切换 state/tab 时列表闪烁（新 key 无缓存直接替换为加载中）；可保留旧列表渲染
- [ ] 通知筛选切换无防抖，连续切换产生多次请求
- [ ] i18n 漏网：state 徽章直接渲染英文 "open"/"closed"、`aria-label="Close"` 硬编码、`Connected to Forgejo as ...` 等成功提示不走 l10n
- [ ] Onboarding 缺「去实例上创建 token」链接；`scm/title` 缺 Publish/Create PR 图形入口；「刷新实例」按钮可能只刷新实例列表不刷新数据（需实测）
- [ ] `InstanceList.vue` 整段英文硬编码且已无人引用（死代码，可删）

#### 第三轮走查（2026-09-03，CDP 截图 + 坐标点击实测 mock 环境）

- [ ] 窄侧栏（默认宽度）多处截断：Dashboard tab 栏（Issues 挤成 "Iss…"）、Notifications 工具栏（「重试」按钮挤成残片）、仓库详情「Preview README」按钮文字被切；需响应式处理（换行 / 窄宽图标化 / 最小宽度）
- [ ] ModalDialog 关闭口径不一致：× 和 Esc 在脏表单下弹放弃确认，但表单内「Cancel」按钮直接关闭不弹确认；要么 Cancel 也走确认，要么明确设计为「显式取消免确认」
- [ ] mock 数据缺口阻碍走查：`contents/:filepath` 按 ref（sha）取文件未 mock，diff 评审编辑器只能显示「No Changed Files」，评论/评审提交界面无法实测；Actions 无运行数据，rerun/产物/日志界面无法实测；建议补 mock（注：「No Changed Files」在拉取失败与真空列表两种情况下无法区分）
- [ ] 仓库详情的 issue/PR 计数是进入对应列表的唯一入口，渲染得像静态统计文本（有 tooltip 无链接样式），可发现性弱；scm/title 也缺入口（第二轮已记）
- [ ] tab 栏激活态歧义（存疑）：激活 tab 用下划线，但非激活 tab 偶发带深色背景，看起来像两个激活 tab；需复现确认是 hover 残留还是 focus 样式
- [ ] 评审操作零反馈：开始评审/添加评论/提交评审成功后没有任何成功提示；且提交评审后 PR 详情的合并区不自动刷新（`pullReviewCommentPanel` 的 `onSubmitted` 只刷新 diff 文档里的评论 thread，未通知 Dashboard），需手动返回重进才能看到 blocker 消失、按钮亮起
- [ ] 评审入口发现性差：只能从 diff 编辑器行号右键菜单进入评审评论；且 gutter 区域单击会误设断点（走查中实测误触），与评审入口相邻易混淆
- [ ] mock 数据不一致：PR 详情 `changed_files` 写死 5，实际 mock diff 只有 1 个文件，「5 个文件变更」统计与文件树对不上
- [ ] Release 相关文案中英混排（「新建 Release」「没有 Release。」），需确认是刻意保留术语还是遗漏
- [ ] 合并成功的后续行为未完整验证：mock 的 PR 详情恒为 open，合并后详情不会变为已合并态，真实服务器下的刷新行为待实测
- [x] UI 走查基建：`tmp-ui-review/` harness 已沉淀为正式工具 `tools/ui-review`（隔离 profile + CDP 截图/坐标点击 + 系统截屏 + 原生对话框按键）；VS Code modal 确认框是原生窗口，CDP 截图看不到，需系统截屏配合

### 代码审查发现的问题（2026-08-24）

六个方向（发布功能、状态栏创建 PR、宿主核心、评论/worktree 等子系统、API 层、webview 状态层）的深度审查结论。修复优先级建议：安全与数据正确性先行，一行级 bug 随手修。

**必须尽快修（确认 bug / 安全问题）**

（本节三项已全部修复，见「最近完成」的阶段 2 条目）

**高（功能正确性）**

- [ ] 多窗口实例配置互相覆盖：globalState 读-改-写无跨窗口监听，窗口 B 用陈旧列表回写丢掉窗口 A 新增的实例（`config.ts` `addInstance`/`removeInstance`）
- [ ] mention 补全 range 回扫吞字：`foo@` 触发补全选中后 `foo` 被整体替换删除（`issueMentionProvider.ts:90-103`）；`@` 文档链接误匹配邮箱 `foo@bar.com`；`forgejo-pr` scheme 分支是死代码（只注册了 `file` scheme）
- [ ] permalink 不做 URL 编码：文件名含 `#`/`?`/`%` 生成坏链接（`permalink.ts:69,92`）；新增文件的 base 侧生成 404 链接
- [ ] worktree 裸缓存仓库（`cacheDir/repos/*.git`）永不删除，无磁盘清理策略（阶段 6 明确排除，独立功能）

**中低**

- [ ] 发布功能：422 被合并误判为「名称冲突」且无客户端仓库名校验；空仓库（无 commit）发布提示「No branch is checked out」偏离真实原因且已创建半成品远程仓库；发布成功后无任何列表刷新；同主机多账号 `findInstanceForRemote` 只取第一个命中，可能用错 token push
- [ ] 实例导入：`importInstances` 对 webview 回传数据无逐项校验；文件导入漏拷 `syncApiUrlsToInstanceUrl` 字段（导出有、导入丢）
- [ ] Action artifact 下载改流式写盘：现在 `arrayBuffer()` 全量读进扩展宿主内存（为此加了 50MB 上限），改流式下载直接写盘后可去掉上限，支持大产物
- [ ] 无版本探测/降级：Actions、`return_run_info`、PR files 等较新端点对老 Gitea/Forgejo 实例直接 404；建议首次连接调 `/api/v1/version` 特性门控，或文档声明最低版本
- [ ] onboardingPanel 的消息入口未加 tracker 兜底（viewProvider 已有，其 handler 均自带 try/catch，可后续套用同一模式）
- [ ] 测试覆盖偏科：`permalink`、`issueMentionProvider`、`publish.ts` 等仍缺测试；优先补纯函数（permalink URL 构造、getMentionRange 边界）与 findInstanceForRemote/push 错误路径用例（config、viewProvider 消息协议、parseDiff、gitOperations、createPullRequest、worktree 等已在阶段 1-7 补齐）

## 进行中

（空）

## 已完成

### 最近完成

- [x] 合并 blocker 判定修复：`required_approvals` 不再无条件显示——拉取评审列表统计 official 且非 stale/dismissed 的 APPROVED 数量，达标即核销（否则已批准的 PR 永远显示「需要 N 个审查通过」、合并按钮恒灰）；mock 补仓库 `permissions` 字段（修复走查时误报「没有合并权限」）、分支保护改 `apply_to_admins: true` 使核销路径可达、已提交评审持久化到列表；走查实测「提交 APPROVED → 可以合并 → 原生确认弹窗 → 合并」全链路
- [x] 文件树回归修复：`FileTreeItem` 恢复 `data-file-path`/`data-type`/`data-size` 属性（3d28835 误删导致目录展开不加载子级），`global.d.ts` 的 `DefineCustomElement` 支持声明额外属性
- [x] diff 编辑器行号右键菜单失效修复：when 子句改用自定义 context key `forgejoToolkit.inPullRequestDiff`（`resourceScheme` 在 diff 编辑器中不可靠，实测原写法菜单不出现），「Add Pull Review Comment」恢复可用
- [x] `tools/ui-review` harness 增强：新增 `hover`/`rclick` 命令
- [x] 独立复核修复轮（对阶段 1-7 的 diff 复核后修复）：评论 thread 清理 scope 补 `isBase`（diff 两侧不再互相误删，737686b 的遗留洞）；notificationPoller 读侧容忍旧版 `{}` 脏数据且写队列防毒化（否则老用户升级后通知 toast 永久失效）；编辑实例测试连接时 host 端回填存储 token；webview 补 `worktreeError` 消费（打开/删除 worktree 失败不再永远转圈）；testConnection/saveInstance 加 60s 超时释放槽位、importPreview 改 host 主动回 cancelled；renderMarkdown 统一改 `_requestId` 配对；removeWorktree 双重报错收敛为 webview 单条；gitOperations 剩余 shell 插值（remote add/worktree add/revert）全部 execFile 化；`createPrFromCurrentBranch` 的 getRepoDetail 加 try/catch 降级；补约 20 个测试
- [x] 审查修复阶段 7（宿主协议兜底与生命周期）：viewProvider 消息入口加兜底分发（`_unansweredRequests` tracker，handler 早退/抛异常统一回 `requestError`，70+ handler 零改动）；webview pending 请求统一 60s 超时 reject 并清 loading；openExternal 加 http/https 白名单，worktree 路径改走专用 `openWorktreePath` 消息并校验已登记；**发 webview 的实例载荷剥离 token**（`toPublicInstance`，导出/导入预览按需单独取，webview 类型删 token 字段）；`config.init()` 迁移失败降级继续激活；空 token 语义统一为「不修改保留旧值」；NotificationPoller 加 disposed 标志、实例删除丢弃在途结果、seenIds 串行化合并写入（原 Set 经 JSON 持久化退化成 `{}` 的 bug 一并修复）、首 poll 只建基线不弹 toast；`_pendingMessage` 改队列；readmeProvider Map 加 LRU 上限；补 23 个测试（dispatch 兜底/poller 生命周期/config/webview 超时）
- [x] 审查修复阶段 6（worktree 子系统）：删除改走 `git worktree remove --force`（失败回退 prune + 手动删，成功后才清记录，失败保留记录并报错）；openWorktree 按 PR 加 in-flight 并发锁（`InFlightTasks`）；复用前校验残留目录合法性（`validatePrWorktree`：rev-parse 比对 PR head sha，过期则重建；记录的路径不在磁盘则清记录重建）；缓存目录设置统一走校验（不存在则创建、不可写则拒绝，viewProvider 与 onboardingPanel 四处入口收敛）；openWorktree 确认弹窗与目录选择 openLabel 改 l10n 双语；补 13 个测试（worktreeManager/InFlightTasks/validatePrWorktree）
- [x] 审查修复阶段 5（API 层分页、路径编码、响应大小限制）：10 处 `limit: 100` 列表请求改用 `fetchAllPages` 按页拉取（页大小 50 不超服务端默认上限、最多 10 页，返回数不足即停）；路径参数在调用层统一编码（分支/tag/ref 用 encodeURIComponent，文件路径逐段编码保留 `/`，generated 目录未改动）；错误体截断到 500 字符并标注 (truncated)；Action 日志超 10 MB 截断标记、artifact 超 50 MB 拒绝下载；debug 日志对 text/arraybuffer 响应只记元信息不写 body；`_getRepoTree` 加页数上限与重复首项 sha 检测防死循环；`buildUrl` 的 null 参数与 undefined 一样跳过；附件上传复制 Uint8Array 视图避免带出整个底层 buffer；补 shared 6 个、extension 12 个测试
- [x] 审查修复阶段 4（webview 状态层竞态与 keep-alive 轮询）：轮询改 onActivated/onDeactivated 启停，六个路由视图的 immediate watch 加 isActive 守卫；Dashboard 在 onActivated 时自愈重载（列表 clear 后不再空列表）；删除 Action Run 连带清理 job 日志；testConnection/saveInstance/importPreview 单槽 ref 加「单在途 + 最新意图」守卫；renderBody 加序号守卫；通知筛选在途丢请求改「记录意图、落地后补发」；globalSearchResults/repoFileSearchResults/loading/errors Map 加 LRU 上限；latestRunIndex 按当前仓库过滤；PR worktree watch 按条目对象引用匹配；loadMyIssues 的 state 进缓存 key；删除 useVsCodeMessages 死代码与遗留 console.log；loader 统一走 beginLoading 清 stale errors（58 处收敛）；补 17 个测试
- [x] 审查修复阶段 3（创建 PR 与状态栏判定）：有 upstream 但 ahead>0 时也会提示推送（`getAheadCount`）；预填 head 用 upstream 远端分支名（本地/远端名不同不再创建失败）；状态栏开放 PR 匹配校验 head 仓库 owner（fork 同名分支不再误判）；merge/close PR 成功后通知状态栏失效缓存（`notifyPullRequestsChanged`）；命令面板入口拦截默认分支；查询失败保留上一次显示状态而非直接隐藏；HEAD watcher 改监听解析后的实际 gitdir（覆盖仓库根在 folder 之上与 worktree 场景）；补 createPrFromCurrentBranch 7 个用例 + 状态栏测试更新至 15 个
- [x] 审查修复阶段 2（评论系统位置语义重写）：渲染/提交两侧废弃 GitHub 式 diff-position 映射，直接用 Forgejo 的文件行号语义（`position`/`original_position`，新增 `resolveReviewCommentLine` 纯函数，左侧评论 position=0 现在能渲染）；`_renderThreads` 清理范围限定到当前文档 scope，thread key 改 JSON 序列化并含 instanceId（不再跨文件/跨 PR/跨实例误删）；评论面板复用时同步更新 callbacks（提交后刷新正确的 PR）；放开 context 行评论限制；parseDiff 缩减为「行是否属于本 PR diff」校验；补 parseDiff/位置解析/thread key/panel 复用共 20 个单测，修正 mock 的 position 语义
- [x] ModalDialog 增强：`closeOnEsc` 参数 + 脏检查确认（`confirmCloseIfDirty`/`isDirty`，Esc/背景点击/× 统一走确认，i18n 双语）；新建/编辑 Issue、新建/编辑 PR、编辑评论五处表单接入
- [x] 审查修复阶段 1（安全与一行级 bug）：git 操作改 `execFile` 数组参数并清洗错误消息（杜绝 push 失败时 token 进日志/弹窗与分支名 shell 注入）；数组 query 参数改重复键序列化（修复通知状态过滤对真实服务器失效，同步修 mock）；删除 Action Run 后导航到不存在的 `repoActions` 路由改为 `repoDetail` 并加迟到响应守卫；`getPullRequestFiles` 的 `??`/`+` 优先级 bug；webview provider 注册入 subscriptions、workspaceFolders 监听去累积、`_view` 加 onDidDispose 清理；`locale` 删默认 `zh` 统一走系统语言兜底；ModalDialog 原生 close 事件同步父组件（Esc 不再失联）；合并 PR / 删除 worktree / 取消 Action 运行加二次确认（i18n 双语）；ActionRunDetail 错误状态补重试按钮；Copy Permalink 右键菜单改 `forgejoToolkit.hasLinkedRepo` 上下文键（去掉 `\|\| true` 调试残留）
- [x] API 缓存审计与第一批修复：mention 补全加 TTL 缓存、Markdown 渲染按内容缓存、loader 全量 in-flight 去重、PR 文件列表缓存 key 包含 diff 范围
- [x] API 缓存第二批修复：时间线附件请求按正文引用过滤（消除 N+1）、仓库文件搜索复用 git tree 缓存（60s）、labels/assignees/milestones/repoDetails 改为 60s 定时缓存、Action 轮询不再重拉已完成 job 日志、状态栏 PR 缓存加 60s TTL
- [x] 状态栏「创建 PR」按钮：当前分支非默认分支且无开放 PR 时显示，点击按需推送分支并打开预填的新建 PR 弹窗；分支已有开放 PR 时显示「PR #n」直达详情
- [x] 发布本地仓库到 Forgejo：`Publish to Forgejo` 命令，无 origin 时创建远程仓库（实例/名称/可见性可选）并推送当前分支；已有关联仓库时直接推送当前分支
- [x] Access token 迁移到 VS Code SecretStorage（激活时自动从 globalState 迁移）；clone / fetch 改用 `http.extraHeader` 传 token，不再写入 HTTPS URL
- [x] 仓库内 Issue / PR 列表支持关键词搜索（服务端 `q` 参数，输入防抖 300ms）
- [x] PR review 提交支持选择结论：评论 / 批准（Approve）/ 要求修改（Request changes），可附带评审总结
- [x] 自研 VS Code 风格日期时间选择器组件（替代浏览器原生 datetime-local 弹窗）
- [x] Issue 详情页支持删除 Issue
- [x] 清理已废弃的 `VscodeDateField` / `VscodeDateTimeField` 组件
- [x] 移除 `packages/vscode-elements-vue` 包，改用原生 `@vscode-elements/elements` 组件
- [x] MSW mock 接入（测试与离线开发，`forgejoToolkit.useMockApi`）
- [x] `ForgejoClient` MSW 测试覆盖所有公开方法；webview 组件与 `useAppState` 单元测试
