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
- [ ] Review 评论面板是单例（`PullReviewCommentPanel.currentPanel`）：切行/切 PR 时编辑器组件按 key 重建，写到一半的草稿直接丢弃（已坐实并修正原假设——草稿不是跟随，是丢失）；需加丢弃确认或缓存草稿
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
- [x] ModalDialog 关闭口径：× 和 Esc 在脏表单下弹放弃确认，表单内「Cancel」直接关闭——已确认为设计决定（显式取消免确认），维持现状
- [ ] mock 数据缺口（剩余）：`contents/:filepath` 通用路径仍 404（仅 src/index.ts 等具体路径有 mock，且忽略 ref 参数）；「No Changed Files」在拉取失败与真空列表两种情况下仍无法区分。已解决：diff 评审编辑器与 Actions 运行数据已有基础 mock，评审/合并全流程可实测
- [ ] 仓库详情的 issue/PR 计数是进入对应列表的唯一入口，渲染得像静态统计文本（有 tooltip 无链接样式），可发现性弱；scm/title 也缺入口（第二轮已记）
- [ ] tab 栏激活态歧义（存疑）：激活 tab 用下划线，但非激活 tab 偶发带深色背景，看起来像两个激活 tab；需复现确认是 hover 残留还是 focus 样式
- [x] 评审操作零反馈 + 提交后不刷新：提交评审/评论成功 toast 按「开始评审/追加到待提交评审/单条评论/批准/要求修改」区分文案（host l10n 双语）；新增 `pullRequestReviewSubmitted` host→webview 消息，提交评审后 Dashboard 已打开该 PR 详情时强制刷新 detail+comments（合并区 blocker 即时核销），未打开则不拉取省流量；已实测全链路
- [ ] 评审入口发现性（剩余）：gutter 区域单击会误设断点（走查中实测误触），与行号右键的评审入口相邻易混淆。已改善：正文右键菜单也加了「Add Pull Review Comment」（`editor/context` + `forgejoToolkit.inPullRequestDiff`，已实测）
- [x] mock 数据不一致：PR 详情 `changed_files` 写死 5，实际 mock diff 只有 1 个文件——已对齐为 1 个文件 +10/−2
- [x] Release 相关文案中英混排——已确认是刻意保留术语（zh.json 中 releases/createRelease/editRelease 统一用 "Release"），非遗漏
- [x] 合并成功的后续行为验证：mock 增加 `prMerged` 状态翻转（POST merge 后列表与详情返回 closed/merged），走查实测合并后 PR 变为已合并态
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

#### 第四轮深度复查（2026-09-03，四方向并行：UX / 宿主端 / API 与状态层 / 安全+mock+l10n）

**严重**

- [x] push 会把实例 token 发给未校验的 upstream 远端——已修：push 确认框前用 `findInstanceForRemote` 校验远端归属，不匹配则报错中止，URL 取不到则无 token 降级
- [x] `importInstancesPreview` 下发存量 token 明文——已修：冲突比较挪到 host 侧（`computeTokenConflicts`），webview 只收 `tokenConflicts: boolean[]`，语义与旧逻辑完全等价（含空 token）

**中**

- [x] 评审评论面板复用切行——已修：`PullReviewCommentPanel.vue` 给编辑器加 `:key`（含 instanceId/owner/repo/index/path/lineNumber/isBase/mode/pendingReviewId），context 更换即重建组件，draft/pendingReviewId/mode 不再泄漏到其他行或 PR；草稿丢失行为保持现状（见第二轮「面板单例」条）
- [x] 11 个评审链路 `l10n.t()` key 未写入 bundle——已补 10 个（删除评论确认/成功/失败、提交/取消评审失败、取消评审确认等，`commands/index.ts` 复用已有 key 无需新增），双语同步
- [ ] `_fetchAllPages` 终止条件 `items.length < 50`：服务端 `MAX_RESPONSE_ITEMS` 调低（如 30）时第一页即满足条件停止，后续数据静默消失（`client.ts:226-236`）；改「返回 0 条」终止或读 `X-Total-Count`
- [ ] 重命名文件 diff 渲染成「整文件新增」：compare 路径丢弃 `previous_filename`（`client.ts:1077-1086`），base 侧按新路径在 baseSha 取内容 404 被吞成空文件（`viewProvider.ts:1872-1873`、`prFileSystemProvider.ts:71-73`）；类型已有 `previous_filename`（`api/types.ts:168`）但宿主端从未使用；base 侧评论位置语义也随之全错
- [ ] 通知单槽位三方混用：轮询推送（无类型过滤）会覆盖用户的筛选视图；切「已读」后 Dashboard 未读徽标掉到 0（`notificationPoller.ts:113` → `useAppState.ts:2545-2564,4035-4042`）；轮询应写独立槽位或携带当前筛选
- [ ] 仓库 Issue/PR 列表一经加载永不过期：无 TTL、无 force、无刷新按钮（`useAppState.ts:3502-3512,3735-3752`），同会话内他人在服务端的变更永不出现；与已记的「无分页」是不同缺陷
- [x] 评论渲染并发竞态——已修：所有 load+render 串行到 `_renderChain` promise 链，同一文档的双触发（onDidOpenTextDocument + onDidChangeActiveTextEditor）顺序执行且后者命中 TTL 缓存，不再交错创建重复 thread
- [x] 评审数据零缓存按文档放大请求——已修：按 `(instanceId, owner, repo, index)` 加 15s TTL 缓存（新 `src/utils/timedCache.ts`）+ InFlightTasks 合并并发加载；`_refreshOpenPrDocuments` 先失效缓存再拉一次数据渲染所有文档
- [x] onboarding 与设置页实例 id 生成不一致——已统一为 `host`（onboardingPanel 改从 `new URL().host` 取，与 viewProvider 一致；旧实例不迁移，仅影响新添加）
- [x] `forgejoToolkit.hasLinkedRepo` 只在侧栏可见时更新——`setContext` 已移到可见性早退之前，`_reply('linkedRepository')` 保持 gated
- [ ] 多窗口 token 内存表不刷新：`_tokens` 只在 `init()` 读一次 SecretStorage，未监听 `secrets.onDidChange`（`config.ts:16,22-43`）；窗口 A 改 token 后窗口 B 全部 API 匿名化失败直到重启（TODO 已记实例列表覆盖，这是另一半机制）
- [ ] worktree「替换当前窗口」确认框取消后仍回 `worktreeOpened`（`gitOperations.ts:322-330` + 三个调用方 `viewProvider.ts:3521,3665,3690`），webview 把取消当已打开，且取消前记录已写入；应返回 boolean/改回 `worktreeCancelled`，记录写入移到确认后
- [ ] GlobalSearch 结果行操作图标会同时触发整行导航：`@click.capture` 父级先触发且 open 函数无守卫（`GlobalSearch.vue:299` 等 6 处）；对比 `DashboardInstanceItem.vue:165-170` 有 `isActionClick` 守卫；点「复制 clone 地址」会被带进仓库详情
- [ ] 创建 Release 附件上传失败被静默吞错且状态残留：`RepoRefs.vue:166` 空 catch，无错误提示、pending 列表未清、弹窗保持打开，再点提交会重复创建同名 Release（tag 冲突）
- [ ] 键盘可达性系统性短板：主列表项用 `div/li @click` 无 tabindex/keydown（`RepoActions.vue:360` 进运行详情唯一入口、`RepoFileHistoryDialog.vue:87`、`CommitDiffList.vue:99`、`RepoFileBrowser.vue:219`、`AttachmentList.vue:86`）；`ViewTabs.vue` 声明 `role="tablist"` 但无方向键导航/roving tabindex
- [ ] mock 保真度（会让走查误判为扩展 bug）：仓库级 issues 端点忽略 `type`/`q` 参数（`handlers.ts:111-116`，搜 PR 返回 Issue、搜 Issue 恒全量）；Issue/PR 关闭/重开 state 不持久化（PATCH 后 GET 回静态数据，只有 merge 有翻转）；评审 pending-only 约束不模拟（两条 422 错误路径在 mock 下是死代码）；仓库详情端点忽略 `:repo`（another-repo 显示 demo-repo 数据）；`mockPullReview.state` 用了 GitHub 式 `'COMMENTED'`（真实为 `'COMMENT'`）
- [ ] msw + 全部 mock 数据被打进生产扩展包：`extension.ts:31-41` 动态 import mock server，`esbuild.js` 无剥离配置，`out/extension.js`（479KB）含全部 handlers；`useMockApi` 是公开设置，用户开启后 msw 以 warn 模式拦截宿主所有 HTTPS 请求；production 构建应剥离并把设置标注为开发用途
- [ ] 「刷新实例」按钮坐实只刷实例列表：`refreshInstances` → `_sendInstances()`（`viewProvider.ts:3110-3112`），仓库/issue/PR 数据不刷新（TODO 第二轮的"需实测"可坐实）

**轻**

- [x] 评审编辑器提交防重复形同虚设——已修：编辑器消费 host 的 `pullReviewCommentSubmitted`/`pullReviewSubmitted`/`pullReviewDeleted` 回包，`submitting` 等到回包才复位；`submitReview`/`cancelReview` 加同样守卫并禁用按钮；host 补齐未配对路径的回包（空 body、取消评审的确认框被拒绝时回 `cancelled: true`）
- [ ] Trigger workflow 成功无反馈、轮询 60s 静默超时（`RepoActions.vue:57-71,190-206`）
- [ ] 删除已记录工时/移除依赖无确认（`IssueDetail.vue:898,920`、`PullRequestDetail.vue:1344`），与其它删除路径均有确认不一致
- [ ] i18n 补充点位：`Notifications.vue:203` 渲染 `subject.type` 原文；`viewProvider.ts:2524,2625,2990`/`onboardingPanel.ts:229` 的 `Unable to open ...`、`Copied to clipboard` 硬编码；`PullReviewCommentPanel.vue:27` `Loading...` 硬编码
- [ ] `revertMergeCommit` 不校验当前分支（revert 提交可能落到错误分支并推上去），且此 push 不带 token 与其它路径不一致（`gitOperations.ts:302-311`）
- [ ] 只增不减的 Map：`pullReviewCommentController.ts:50,342` `_commentContextMap` 从不清理；`resolveAttachmentImages.ts:8` session 级图片 dataURL 缓存无 LRU 上限
- [ ] mention 文档链接每次调用都重跑仓库探测（`issueMentionProvider.ts:70-85,138`，无缓存）
- [x] 导入解密不校验 `iterations`——已加 `MAX_IMPORT_PBKDF2_ITERATIONS = 1_000_000`，非整数/<1/超上限抛 RangeError（不静默按上限算，避免报"密码错误"误导），补 5 个测试
- [x] JSON 兜底路径 `status: 'deleted'` 未归一化——`getPullRequestFiles` 出口已统一映射为 `'removed'`，补 client 测试
- [ ] 通知筛选在途切换时旧响应先落库再补发，中间窗口短暂显示错误类型（`useAppState.ts:2545-2564`）
- [ ] `renderedMarkdownCache` 无条数上限（key 含完整正文，只有 30s TTL；`useAppState.ts:183,3904-3915`）；`createTimedCache` 可加 maxEntries
- [ ] `client.renderMarkdown` 绕过 `_client()` 管道（`client.ts:1323-1339`）：无错误体截断、不走 `syncApiUrlsToInstanceUrl` URL 改写、无 debug 日志
- [x] debug 日志 URL 与实际请求不符——删 `_buildDebugUrl`，改用 shared/request 已导出的 `buildUrl`，与实际请求同一序列化（数组参数重复键）
- [x] `dispatchWorkflow` 的 204 归一化无效——显式判空对象返回 undefined（baseClient 把 204 变 `{}`，`??` 兜不住），补测试
- [ ] Dashboard「我的 Issue/PR」未传 limit，受服务端默认页大小截断（`client.ts:253-265`）
- [ ] mock 数据把宿主计算字段（`mergeBlockers`/`statusChecks`/`repoPermissions`/`is_pull`）烘进「API 响应」，误导后续开发；`resetMockServer()` 清不掉模块级可变状态（`prMerged`/`submittedReviews`），测试靠执行顺序硬撑
- [ ] package.json 的 7 个设置项 description 硬编码英文，未走 package.nls（命令标题已全部走占位）

**存疑（需实测/验证）**

- [ ] `App.vue:15` 返回按钮：webview 重建后直落深路由时 `router.back()` 无历史可退，按钮点了没反应（需 webview 重载 + 深链实测）
- [ ] `execFile` 默认 maxBuffer 1MB，`git clone --bare` 超大仓库 stderr 进度可能超限被杀（需大仓库实测；可加 maxBuffer 或 `--quiet`）
- [ ] 评论面板与 diff 编辑器同 column 打开盖住代码（`pullReviewCommentPanel.ts:44-55`，确认是否刻意，否则改 `ViewColumn.Beside`）
- [ ] `prFileSystemProvider.stat` 的 `mtime: Date.now()` 恒变化，可能导致 VS Code 反复 readFile 真实拉 API（影响程度需实测）
- [ ] `_detectServerOrigin` 启发式可能把外部头像服务 origin 误判为服务器 origin 导致头像 404（`client.ts:1341-1388`，需外部头像源实例实测）
- [ ] git 进程存活期间 token 在命令行中同机可读（`gitOperations.ts:30-32`，威胁模型取决于本机权限；可改 GIT_ASKPASS/stdin）

## 进行中

（空）

## 已完成

### 最近完成

- [x] 评论子系统专题（第四轮走查的四条评论链路缺陷）：面板复用切行状态泄漏——编辑器按完整 context `:key` 重建（draft/pendingReviewId/mode 不再跨行/跨 PR 残留，草稿丢弃行为保持现状）；`_onOpenDocument` 并发竞态——load+render 全部串行到 `_renderChain`，同文档双触发不再交错建重复 thread；评审数据零缓存——按 PR 加 15s TTL 缓存 + InFlightTasks 合并并发加载，`_refreshOpenPrDocuments` 失效后一次拉取渲染全部文档（30 文件 multi-diff 提交评论从 60 倍请求降为 1 次）；编辑器提交防重复——webview 消费 host 完成回包后才复位 `submitting`，`submitReview`/`cancelReview` 同步加守卫，host 补齐空 body 与确认取消两条未配对回包（协议加 `cancelled` 字段）；补 controller 4 个、panel host 1 个、webview 组件 6 个测试

- [x] 快修批（第四轮复查小项）：onboarding 实例 id 统一为 `host`（含端口，与设置页一致；旧实例不迁移）；`hasLinkedRepo` 的 `setContext` 移到侧栏可见性早退之前（Copy Permalink 对不开侧栏的用户可用）；补齐评审链路 10 个 l10n key 双语（删除/提交/取消评审的错误与确认文案）；`getPullRequestFiles` 出口归一化 `deleted`→`removed`；`dispatchWorkflow` 204 显式返回 undefined；debug 日志 URL 改用 shared 的 `buildUrl`（与实际请求同一序列化）；导入解密 `iterations` 钳制上限 1e6（超限抛 RangeError）；补 client 2 个、instanceImport 5 个测试

- [x] 安全修复批（第四轮复查的两个严重项）：push 前校验 upstream 远端归属——确认框前用 `findInstanceForRemote` 给用户友好报错，`pushBranch` 内部（新增 `tokenInstanceUrl` 参数 + `remoteMatchesInstance` helper）在 push 执行前再校验一次闭合 TOCTOU 间隙，不匹配实例则中止、URL 取不到降级为无 token push，杜绝 token 随 `http.extraHeader` 外泄到第三方主机；导入实例预览的 token 冲突比较挪到 host 侧（新增 `computeTokenConflicts`，协议字段 `existingTokens` → `tokenConflicts: boolean[]`），webview 不再接触存量 token，恢复「token 不出扩展宿主」不变式；补 createPullRequest 3 个 + instanceImport 5 个 + gitOperations 6 个测试

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
