# TODO

短期任务清单。已交付功能的完整记录见 `ROADMAP.md` 的「已完成」一节；更早的历史完成记录由本文件的 git 日志保存。

## 待开始

### 发布 0.0.1（下一个动作）

- [ ] 重建并跑完发布前走查：`pnpm --filter forgejo-toolkit build` 后按 `tools/ui-review/README.md` 的 Release walkthrough checklist 逐条过（其中 pushurl 拦截与 MCP 入参校验需要真实实例 + token，mock 环境覆盖不到）
- [ ] 打包产物核对：`pnpm --filter forgejo-toolkit package`，确认 `.vsix` 内含 `out/extension.js`、`out/mcp-server.js`、webview 资源、`l10n/` 与 `walkthrough/`（`.vscodeignore` 已排除源码与 `mcp/` 源文件）
- [ ] 发布（需你执行，构建/发布需要凭据）：VS Code Marketplace（publisher `cpf23333`）+ Open VSX，并把 `.vsix` 附到 Codeberg Release。Codeberg 那一步可用 `.forgejo/workflows/release.yml`（手动触发，`dry_run` 默认 true，先跑一次只打包；需配 `FORGEJO_TOKEN` 仓库 secret），其余步骤见 `docs/release.md`
- [ ] 发布后回填：README 安装/版本表述与 `docs/release.md` 对齐实际发布渠道；确认 `KNOWN_ISSUES` 中与版本相关的条目在发版后仍成立

### 规划中的功能

- [ ] MCP Server Phase 2 写工具（需单独批准，方案已定调）——`create_issue`、`create_comment`、`create_pull_request`、`submit_pull_review`、`merge_pull_request`、`mark_notification_read`；默认关 + 设置逐项开启 + 不标记 `readOnlyHint`（让 VS Code 逐次确认）
- [ ] MCP Server：多实例 fan-out（later refinement）——每实例一个 server 或工具加 `instance` 参数；可选 MCP prompts 预置模板（如 "review 这个 PR"），锦上添花
- [ ] MCP Server：加 `forgejoToolkit.mcpEnabled`（默认开）开关——目前只读工具面一旦有实例就无条件暴露，无法关闭
- [ ] Forgejo v17（约 2026-10 底）发布后：实现 workflow/job rerun（2026-09-17 核对上游）——上游主干已加 `POST /repos/{o}/{r}/actions/runs/{run_id}/rerun` 和 `.../jobs/{job_id}/rerun`（forgejo#13924，仅可 rerun 已完成状态的 run/job），v16.x 不含。落地时用版本闸门（≥17.0），并同步移除 KNOWN_ISSUES 里 rerun 限制条目
- [ ] Forgejo v17 发布后：Actions 日志改 ndjson + 服务端过滤（低优先级）——`GET .../jobs/{job_id}/logs` 新增 `?format=ndjson`（#12820）和 `?q=`/`?qi=` 子串过滤（#12821），可替代纯文本解析并把日志搜索下沉到服务端

### 2026-09-22 复审未修项（按优先级）

- [x] P1 创建成功但附件上传失败时表单不清空 → 重试会产生重复 issue/PR/评论——`RepoIssues.vue` / `RepoPullRequests.vue` / `IssueDetail.vue` / `PullRequestDetail.vue` 的创建与评论流程：catch 里写了错误却没清 `isCreating`/正文/待上传附件。方向：创建成功后先关闭表单，附件上传单独 try → 2026-09-22 修复：采用与 release 附件上传一致的「记住已创建资源 + 只重试剩余文件」方案——issue/PR 表单记录 `createdIssueNumber`/`createdPullRequestNumber`，评论表单记录 `createdCommentId` + 创建时的正文（正文被改动视为新评论，避免静默丢弃），重试时不再重复创建；新增 `utils/uploadFilesKeepingFailures.ts`（并发上传、只返回失败项、不 reject，配单测）替换四处重复循环；失败的附件留在待上传列表并给出本地化提示（`dashboard.repoIssues/repoPullRequests.attachmentUploadFailed`、`dashboard.detail.commentAttachmentUploadFailed`），全部成功后才用累计的 blob→附件 URL 映射改写正文并关闭表单
- [x] P1 关闭 PR diff 编辑器后，评论面板（Comments panel）仍残留该文件的 review thread——`_onCloseDocument` 依赖 `onDidCloseTextDocument`，但虚拟文档的 close 事件未及时触发（等 20s+ 仍在）。方向：改用 `onDidChangeVisibleTextEditors`（去抖）兜底清理不可见文档的 thread → 2026-09-22 修复：保留 close 事件为主路径，新增 `onDidChangeVisibleTextEditors` 兜底（250ms 去抖）——凡是不再出现在任何可见编辑器里的 thread 一律 dispose，并清理其 comment context；该事件里本来就要重算范围装饰，数据源与装饰逻辑同源（装饰在实机上已被验证可用）；新增两条用例（不可见即清理 / 仍可见则保留）
- [x] P2 非管理员看不到保护规则：`GET /branch_protections/{name}` 是 repo-admin-only（上游 `api.go` 整组 `reqAdmin()`），403 被 `_probe` 吞掉后等同于「没有保护规则」。2026-09-22 已修掉「探测失败被当成无 push 权限而禁用合并」，剩余方向：仅在 `permissions.admin` 为真时探测，否则显式提示「保护规则未知」 → 2026-09-22 修复：改用 `_readBranchProtection`——仅当 `permissions.admin === true` 才请求（非管理员直接标记 unknown，403 不再被误读为「无规则」），404 视为已知答案「该分支没有保护规则」，其它失败（5xx/网络）也标记 unknown；PR 详情新增 `protectionUnknown` 标志，合并状态区在规则不可读时显示「此合并状态可能不完整」（不新增 blocker，保持既有「未知不阻断」原则）；用例覆盖非管理员不发请求、404 视为已知、管理员请求失败为未知
- [ ] P2 静默截断：`_getRepoTree` 上限 50 页 × 100 条、`_fetchAllPages` 上限 500 条，文件搜索/列表被截断时不返回任何标记。方向：结果携带 `truncated` 标记，并按 `X-Total-Count` 推导上限 → 2026-09-22 部分修复（文件搜索）：`searchRepoFiles` 改为返回 `{ files, truncated }`（`_getRepoTree` 同样返回 `truncated`——服务端 `truncated: true` 且翻到页上限、或服务端重复返回同一页时为 true，空页判定为完整），host 回包带 `truncated` 并在截断时记 info 日志，webview `repoFileSearchTruncated` 按查询 key 记录，文件浏览器在结果下方提示「结果可能不全」，MCP 的 `search_repo_files` 工具描述同步说明返回 `truncated`。**仍未修**：`_fetchAllPages`（issue/PR/commit/文件列表等 500 条上限）没有任何标记，需要逐消息契约改；`X-Total-Count` 仍不可用（请求层不透出响应头）
- [x] P2 通知列表只取一页（`getNotifications` 无分页，>50 条静默丢失） → 2026-09-22 修复：改用游标分页（`before=<已显示的最早 updated_at>`，RFC3339）而非页码——把通知标记为已读会把它移出服务端过滤结果，页码会整体位移并漏条；host 回包回显 `before` 以区分「追加」与「整列替换」，webview 按 id 去重追加，满页（≥ `NOTIFICATIONS_LIMIT`）才显示「加载更多」，全部加载完自动消失；新增 `mergeNotificationPages` / `oldestNotificationTimestamp` 纯函数（时间戳按 `Date.parse` 比较，避免服务端时区偏移破坏字典序）；原「仅显示前 N 条」提示改为真实分页。已知限制：服务端无 body 内总数，若管理员把 `[api] MaxResponseItems` 调到 50 以下则短页会提前判定结束（总数只在响应头里，生成的 client 不透出）
- [ ] P2 无代理支持：所有请求走全局 `fetch`，不读 `HTTP(S)_PROXY` / VS Code `http.proxy`。方向：按设置接入 undici `ProxyAgent`，或至少在文档中声明限制
- [x] P2 PR worktree 目录名不含实例标识（`worktrees/<owner>-<repo>-pr-<n>`）：两个实例的同名仓库会共用同一路径。裸仓库缓存已按实例加后缀（2026-09-22 修复），worktree 目录尚未处理 → 2026-09-22 修复：PR 与 issue worktree 目录名都改为 `worktrees/<owner>-<repo>-<实例后缀>-pr|issue-<n>…`（复用裸仓库缓存的 `instanceCacheSuffix`，并导出供测试使用）；新增 `_resolveWorktreePath`：若已有该 worktree 记录且记录路径仍在当前 worktree 缓存目录内则沿用旧路径，因此升级前创建的 worktree 不会被改名孤立（旧记录路径继续可用，无需迁移）；新增用例「两个实例的同名仓库落到不同目录」，并更新 startWorkOnIssue 既有断言
- [ ] P2 MCP 子进程里的版本闸门是死代码（`serverVersions` 表只在扩展宿主进程填充）；工具调用也不支持取消（未把 SDK 的 signal 透传到 client）
- [x] P3 缓存治理：`timedCache` 只在该 key 被再次读取时清理过期项（过期后不再读的条目会留到会话结束）；`mentionCache` 无上限；`resolveAttachmentImages` 的 key 未包含实例标识 → 2026-09-22 修复：`createTimedCache` 在插入新 key 前先扫掉已过期条目再按插入顺序淘汰（未显式传 `maxEntries` 时默认上限 64，避免「不再被读取的 key 永久驻留」）；`issueMentionProvider` 的 `mentionCache` 同样加 50 条上限（先清过期再淘汰最旧）；`resolveAttachmentImages` 的缓存 key 改为 `instanceId|url`（同一 origin 上两个账号的附件可见性不同，不能互相复用已解析的 data URL）；三处都补了用例
- [x] P3 提交 `pnpm-lock.yaml`（已从 `.gitignore` 移除，需人工 `git add`）——此前 lockfile 未入库，全新 clone 会解析 `^` 浮动版本，安装不可复现 → 已入库（`290d875`，271 KB，CI 的 `--frozen-lockfile` 依赖它），工作区无未提交改动
- [ ] P3 `packages/forgejo-api` 的代码生成源未固定（`kubb.config.ts` 直接读 `https://codeberg.org/swagger.v1.json`）——建议 pin 到上游 tag 并记录版本；`src/generated/client|mocks` 目前无任何 value 导入，可考虑只保留 types
- [ ] P3 确认「未打开 Dashboard 时 MCP server 是否会被 VS Code 发现」——`package.json` 的 `activationEvents` 只有 view/fileSystem（+隐式 command），官方激活事件列表（2026-09-16 版本）里确实没有 `onMcpServerDefinitionProvider`。**文档核对结论**：MCP 指南只要求 `contributes.mcpServerDefinitionProviders` + `lm.registerMcpServerDefinitionProvider`，且 VS Code 仓库 issue #266221 的标题即「MCP Server results in extension always activating in all workspaces」——说明贡献该扩展点的扩展会被自动激活（与 1.74 起 command/view/customEditor 的隐式激活一致），因此暂不添加 `onStartupFinished`（避免每次开窗都激活）。**待验证**：发版走查时确认「未打开 Dashboard 的全新窗口里 Chat 的工具选择器能看到 forgejo 工具」；若看不到，再补 `onStartupFinished`

### 2026-09-22 工作区改动复审新发现（四方向子代理审查）

- [x] P2 ImportPreview 错误态把未本地化英文裸串直接渲染进 UI——`viewProvider.ts:4064` 把 `userFacingErrorMessage(error)` 放进 `error` 字段，`ImportPreview.vue:113` 原样渲染；对 `'No valid instances found in file'`（`instanceImport.ts:172`）这类裸英文 Error，中文 UI 出现英文句子。与上面 P3 未本地化项同源，但本轮改动让它从日志可见变成 UI 可见，建议随 P3 一起优先处理 → 2026-09-22 修复：上述两处裸串改走 `vscode.l10n.t`（`issueMentionProvider.ts` 的 `'Issue'` / `'Pull Request'` 一并在内，l10n 中英各 187 条对齐）；同时把「用户主动取消」与「失败」拆开——`readExportDataFromUri` 在密码框被取消时抛 `ImportCancelledError`，host 两侧改回 `cancelled: true` 且不再记 error 日志，webview 的 `useAppState` 直接丢弃 cancelled 结果，中文 UI 不再把取消显示为「导入失败」
- [x] P3 `pullReviewCommentPanel.test.ts` 的 `../../api/client` 全量工厂 mock 缺 `API_REQUEST_TIMEOUT_MS` 等导出——panel 新引入的 `resolveAttachmentImages.ts` 从该模块 import 此常量，当前测试渲染的 html 无图片、靠空集合短路恰好不触发；一旦有测试渲染含实例附件 URL 的 html，会走到 `AbortSignal.timeout(undefined)` → 2026-09-22 修复：`pullReviewCommentPanel.test.ts` / `pullReviewCommentController.test.ts` / `onboardingPanel.test.ts` 三处全量工厂 mock 补 `API_REQUEST_TIMEOUT_MS`，并新增 panel 用例「markdown 返回实例附件 URL 时内联为 data URL」（同时断言 fetch 带 token；缺常量时该用例会失败）
- [x] P3 Actions 分页边界：`RepoActions.vue:34` 按页大小恒 30 推导下一页，服务端 `[api] MaxResponseItems` 钳到 30 以下时会重请求已加载页并重复追加（`useAppState.ts:2465` 对 page>1 无条件 append）；`actionRunTotalCount` 回退值 `?? incoming.length` 在无 total 时后续页总数缩水（`useAppState.ts:2474`） → 2026-09-22 修复：webview 按 repo 记「已加载页号」（`actionRunsPage`），下一页由计数器推导；只接受 `已加载页 + 1` 的连续页，迟到/重复页丢弃（避免重复或跳页）；`hasMore` 改以服务端精确 `total_count` 为准（空页仍视为结束，短页不再误判结束）；`totalCount` 缺失时不再用当页条数覆盖已有总数；顺带修掉删除单条 run 时 `actionRuns.clear()` 会清空所有 repo 列表状态的问题（改为按 repo 删除）
- [x] P3 UX 小问题：①取消删除附件的 host 确认后，编辑弹窗仍静默关闭、删除标记被丢弃且无「未删除」反馈（`IssueDetail.vue:515`、`CommentTimeline.vue:297`，PR 侧同构）；②`pullReviewCommentPanel.ts` 的 default 分支对无 `_requestId` 的 fire-and-forget 消息也记 `logger.error`，共享 composable mount 广播会刷错误日志，建议降为 debug → 2026-09-22 修复：新增纯函数 `webview/src/utils/attachmentDeleteNotice.ts`（declined 优先于 failed，无则静默）并配单测；issue/PR 详情页把 `Promise.all` 改 `allSettled` 统计「已取消/失败」条数，取消或失败时在详情页顶部显示中性提示（新 i18n key `dashboard.detail.attachmentsNotDeleted` / `attachmentsDeleteFailed`，中英同步），打开编辑弹窗时清除；`CommentTimeline` 此前完全忽略删除结果（仅 `console.error`），现同样统计并显示提示；panel 的 default 分支按 `_requestId` 分流——有请求 id 才记 error 并回 `requestError`，fire-and-forget 广播降为 debug

### 第六轮复审缓议项（2026-09-15 四方向复审已修完，以下已评估暂不动）

- [ ] P5 500 条列表全量渲染无分页/虚拟化——大仓库才感知，待性能实测后定

### 低优先级（历史遗留）

- [ ] vscode-tree 内按钮（IconActionButton）的 Enter/Space 键盘激活被库自身 keydown `preventDefault` 抑制——`@vscode-elements/elements` 2.5.1 的 pre-existing 限制（原 vscode-icon 同样如此），升级库或上游修复后复查
- [ ] onboarding 面板的 CSP 只在 HTML 重建时生效：编辑中实例 URL 已并入 `instanceUrls`，但 `http://` 实例在下一次面板重建前，markdown 预览里的实例图片仍被拦（https 实例不受影响，影响面小）。`_update()` 实际只在构造时调用，需在 `testConnection` 成功后按 origin 变化重建

### 走查方向

- 发布前走查清单见 `tools/ui-review/README.md` 的「Release walkthrough checklist」（脏 worktree 确认、四个 delete 确认、评论面板预览/提及、pushurl 拦截、通知已读、Actions 分页、导入错误、MCP 入参校验）。跑 mock 走查要用 `pnpm --filter forgejo-toolkit build:extension`（不带 `--production`，否则 mock 被剥掉），清单里需真实例的条目另见 README 的构建说明。
- [x] 动态端到端走查：多 remote 关联、关联仓库切换器、中文详情页、Publish 按钮新行为（创建仓库流程 + 中间态报错文案正确；推送成功路径受 insteadOf 测试环境限制未覆盖）、评论 thread 清理（见上方发现）
- [x] 2026-09-22 走查续跑（隔离 dev host，zh-cn + mock）：Dashboard/Issues/Settings/Notifications 均正常渲染；通知「全部已读」清空未读列表 ✔；delete 确认双向验证——tracked time 取消（`{ESC}`）条目仍在、确认（`{ENTER}`）条目消失且摘要 `1 小时 → 0 秒` ✔，依赖议题确认框文案「确定移除对 #1 的依赖吗?」正确。为此把 mock 的 `times`/`dependencies`/`comments/:id/assets` 三个 DELETE 改成有状态（`resetMockState()` 重置），否则确认与取消在界面上无法区分；harness 的窗口匹配改为按 profile 定位（本地化 UI 下原本失效）
- [x] 走查 ① release 附件删除确认（双向）：`{ESC}` 后附件仍在（`crop-l10.png`），`{ENTER}` 后附件行消失（`crop-k10.png`），debug 日志 `DELETE .../releases/5/assets/10 → 204`。前置修复：release 列表返回 fixture、`mockRelease.assets` 带一条附件、删除端点改为有状态
- [x] 走查 ③ 通知轮询报错根因：**mock 启动时序**——`mockServer.listen()` 只把拦截器异步装上，而版本探测与轮询首跳在同一 tick 就发出请求，于是绕过 mock 走真实网络并失败（日志里 `Polling …` 早于 `Mock API server started`）。修法：`startMockServer()` 改为 async 并在 `listen()` 后 await 一个 macrotask，`activate` 里把 mock 启动块移到版本探测之前并 await。修后启动日志为 `Mock API server started → /version 200 {"version":"16.0.5"} → Polling notifications`，无失败；通知视图不再显示红色「刷新通知失败」
- [x] 走查 ② 评论附件删除确认：在 Issue #1 的评论上「编辑 → 附件 log.txt → 删除 → 保存」后按 `{ESC}`，时间线出现本地化提示「有 1 个附件未删除：已取消确认。」且附件仍在（`crop-x3.png`），正是 2026-09-22 那条「取消删除要有反馈」修复的实测。前置修复：mock 时间线评论补 `type: 'comment'`（否则不显示编辑菜单）、`assets` 引用与真实 uuid（客户端只在 body 引用 `/attachments/<uuid>` 时才拉附件列表），并调整了那条依赖「评论无附件引用」的用例改为自带 stub
- [x] 走查 ④ pushurl 拦截：在测试工作区给 `origin` 设 `pushurl=https://mirror.example.com/...`（fetch 保持真实服务器），用真实实例跑「从当前分支创建 PR」——日志 `[createPrFromCurrentBranch] a push target of remote "origin" does not belong to instance …; push aborted to avoid leaking the access token`，界面弹出本地化错误「上游远端 "origin" 不属于当前关联的 Forgejo 实例。已中止推送…」（`crop-bl1.png`），且**无任何推送/请求**。注意：仅当当前分支没有 upstream 且仓库没有已存在的 open PR 时该命令才会走到推送；跑完已还原 pushurl 与分支
- [x] 走查 ⑤ 通知「全部已读」：点击 ✓ 后未读列表清空（「没有符合当前筛选条件的通知。」）且按钮变为**禁用态**（`crop-bm5.png` → `crop-bn1.png`）。注意：该动作是**实例级**的，会把 dev host 里配置的**所有**实例一起标记已读（本次误伤了真实实例的通知，已向用户说明）
- [x] 走查 ⑥ Actions 分页：给 mock 造 35 条 run（`mockActionRuns`，`total_count` 为真实总数并按 `page`/`limit` 切片），页 1 满 30 条 + 显示「加载更多」，点击后日志 `GET …/actions/runs?page=2&limit=30`、追加 #31–#35 且按钮消失（`crop-bs1.png` → `crop-bu2.png`）
- [x] 走查 ⑦ 导入损坏 JSON（**部分**）：harness 无法驱动 Windows 原生文件选择框——SendKeys 完全到不了它（连 `{ESC}` 都不会关闭），新加的 `tools/ui-review/src/win/fileDialog.ps1` 能通过窗口消息把路径写进文件名框（`SetWindowText` + `EN_CHANGE`），但确认「打开」仍不生效（需真实鼠标点击 + 回车，且容易留下多个残留对话框）。改为在用例层验证同一关注点：新增 `readExportDataFromUri` 对非法 JSON **reject**（不会退化成空列表预览），配合既有的「空实例列表报本地化错误」用例；动态侧留待 harness 支持 UIA 后再补
- [ ] 走查 ⑧ MCP 入参校验（已拿到真实 token，未跑）：计划绕过 GUI，直接用 env 配置启动 `out/mcp-server.js`，以 stdio 调 `get_file_content` 传 `../../../../notifications` 期望校验错误，并查大结果是否带截断标记
- [ ] `prFileSystemProvider` 大文件行为实测：contents API 对 >10 MiB 文件返回空 `content`（已确认，见 KNOWN_ISSUES），PR diff 里会显示为空，值得确认提示文案的落点
- [ ] 性能实测：激活耗时、懒加载后 bundle 实测体积（静态部分已完成并修复 P1-P4）

## 进行中

（空）
