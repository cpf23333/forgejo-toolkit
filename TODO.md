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
- [ ] 请求无超时：client 无 `AbortSignal`/timeout，webview pending 请求无超时，host 侧大量 `if (!instance) return` 早退不回包（如 mergePullRequest），提交按钮可永久卡 loading；应统一加超时 reject，host 每个 case 保证必然 `_reply`
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

### 代码审查发现的问题（2026-08-24）

六个方向（发布功能、状态栏创建 PR、宿主核心、评论/worktree 等子系统、API 层、webview 状态层）的深度审查结论。修复优先级建议：安全与数据正确性先行，一行级 bug 随手修。

**必须尽快修（确认 bug / 安全问题）**

- [ ] 评论位置语义整体错位：`parseDiff.ts` 按 GitHub diff-position 建模，但 Forgejo API 的 `position`/`new_position`/`old_position` 是文件行号（已核对 Forgejo 源码）；渲染错行、左侧评论（position=0）永不显示、提交评论落错行或被 422；废弃 diff-position 映射，渲染直接用 `position || original_position`，提交直接发文件行号
- [ ] `_renderThreads` 清理循环 dispose 全局 `_threads` 中所有不匹配线程：开同 PR 的文件 B 清掉文件 A 的线程，开 PR #2 清掉 PR #1 的；`_threadKey` 不含 instanceId 跨实例互串（`pullReviewCommentController.ts:280-285`）
- [ ] 评论面板复用时新 callbacks 被丢弃，沿用旧 PR 闭包：对 PR B 提交评论后刷新的是 PR A 的文档（`pullReviewCommentPanel.ts:44-48`）

**高（功能正确性）**

- [ ] 「按需推送」缺口：只在无 upstream 时才推送，有 upstream 但本地领先 N 个 commit 时直接开弹窗，创建的 PR 不含未推送 commit（`createPullRequest.ts:44-63`）；用 `git rev-list --count @{upstream}..HEAD` 判断 ahead>0 一并提示
- [ ] 状态栏「已有开放 PR」匹配不校验 head 仓库 owner：他人 fork 中同名分支的开放 PR 会命中，遮蔽自己的创建入口（`createPrStatusBar.ts:120`）
- [ ] 多窗口实例配置互相覆盖：globalState 读-改-写无跨窗口监听，窗口 B 用陈旧列表回写丢掉窗口 A 新增的实例（`config.ts` `addInstance`/`removeInstance`）
- [ ] token 全量推送到 webview（`_sendInstances`/`initialState` 含明文 token），CSP 允许 `connect-src http: https:`，一旦有注入点所有实例 token 可外带；默认剥离 token，仅导出流程按需单独取
- [ ] 10 处列表请求 `limit: 100` 超服务端默认上限 50 且无翻页（用户仓库/分支/tag/release/label/milestone/PR files/时间线/PR commits/reviews），大仓库数据静默缺失；加分页循环或处理 `X-Total-Count`
- [ ] 生成客户端路径参数全程未 encodeURIComponent：分支名含 `#`、tag 含 `/`（如 `release/1.0`）、文件路径含 `?` 时对应 API 直接坏（`packages/forgejo-api/src/generated/client/` 统一模板）
- [ ] keep-alive 下轮询定时器不停止：`ActionRunDetail` 切走后仍每 4s 全量刷新直到被 LRU 挤出；全代码库无一个 `onDeactivated`，deactivated 视图的 route watch 仍触发加载；轮询与 watch 改用 onActivated/onDeactivated 启停
- [ ] webview 状态层竞态：删除响应晚到无条件 `router.go(-1)` 篡改用户后续导航；列表 clear 后 Dashboard 显示空列表需手动切页签才恢复；`actionJobLogs` 在删除 run 时漏清理（体积最大的条目永不释放）；单槽 ref（testConnectionResult 等）无 requestId，快速操作响应乱序覆盖
- [ ] mention 补全 range 回扫吞字：`foo@` 触发补全选中后 `foo` 被整体替换删除（`issueMentionProvider.ts:90-103`）；`@` 文档链接误匹配邮箱 `foo@bar.com`；`forgejo-pr` scheme 分支是死代码（只注册了 `file` scheme）
- [ ] permalink 不做 URL 编码：文件名含 `#`/`?`/`%` 生成坏链接（`permalink.ts:69,92`）；新增文件的 base 侧生成 404 链接
- [ ] worktree 子系统：删除用 `fs.delete` 而非 `git worktree remove`（`.git/worktrees` 元数据残留、分支仍标记 checked out，且先删记录后删目录，Windows 文件锁失败时无入口自愈）；创建无并发锁（双击并发 fetch/worktree add 同路径）；残留目录只查存在性不校验合法性/新旧；裸缓存仓库永不清理无磁盘策略

**中低**

- [ ] 发布功能：422 被合并误判为「名称冲突」且无客户端仓库名校验；空仓库（无 commit）发布提示「No branch is checked out」偏离真实原因且已创建半成品远程仓库；发布成功后无任何列表刷新；同主机多账号 `findInstanceForRemote` 只取第一个命中，可能用错 token push
- [ ] 状态栏：PR 合并/关闭后「PR #n」可无限期残留（TTL 只在 refresh 触发时求值，merge/close 路径不通知）；`.git/HEAD` watcher 漏掉仓库根在 folder 之上与 worktree 场景；命令面板入口未拦截默认分支；瞬时网络错误导致按钮消失而非保持旧状态
- [ ] 实例导入：`importInstances` 对 webview 回传数据无逐项校验；文件导入漏拷 `syncApiUrlsToInstanceUrl` 字段（导出有、导入丢）
- [ ] `_getRepoTree` 对不支持分页参数的老服务器有死循环风险（仅以 truncated 为退出条件）
- [ ] 错误体/Action 日志/artifact 下载无大小限制（整段塞进 Error.message 或内存）；debug 日志把响应体写进输出通道（CI 日志可能含密钥明文）
- [ ] NotificationPoller：dispose 后仍可 start；并发 poll 的 `_updateSeenIds` 读-改-写丢 seen ids 导致重复 toast；全新安装首 poll 把所有未读当新通知弹一遍；实例删除后在途 poll 仍推送
- [ ] 配置激活链路：`config.init()` 的 secrets 迁移失败会导致整个扩展激活失败（无 keyring 环境），应 try/catch 降级；同 id 空 token 重新添加时旧 token 残留
- [ ] `openExternal` 不校验 scheme（webview 可传 `file://`）且未 await；viewProvider 多个 handler 无 try/catch 兜底（globalState.update 抛错 → unhandled rejection）
- [ ] 无版本探测/降级：Actions、`return_run_info`、PR files 等较新端点对老 Gitea/Forgejo 实例直接 404；建议首次连接调 `/api/v1/version` 特性门控，或文档声明最低版本
- [ ] 杂项：`_pendingMessage` 单槽位连续两条 open\* 消息第一条被覆盖；`readmeProvider` 模块级 Map 只增不减；`extension.ts` 残留 `console.log`；`useVsCodeMessages.ts` 全库无人使用（可删）；`DashboardInstanceItem.vue` 遗留 console.log；`loadMyIssues` 的 state 参数不进缓存 key（签名陷阱）
- [ ] 测试覆盖偏科：`config.ts`、viewProvider 消息协议、`parseDiff`、`permalink`、`issueMentionProvider`、`worktreeManager`、`gitOperations`、`publish.ts`、`createPullRequest.ts` 全部零测试；两处 mock（评论 position、通知逗号拆分）恰好掩盖真实 bug；优先补纯函数（parsePullDiff 位置映射、permalink URL 构造、getMentionRange 边界）与 findInstanceForRemote/push 错误路径用例

## 进行中

（空）

## 已完成

### 最近完成

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
