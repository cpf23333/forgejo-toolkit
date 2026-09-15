# TODO

短期任务清单。已交付功能的完整记录见 `ROADMAP.md` 的「已完成」一节；更早的历史完成记录由本文件的 git 日志保存。

## 待开始

### 高优先级

第五轮走查（2026-09-14，五方向子代理 + 主代理抽查坐实）中需要最先处理的项；前两项关系首次发布。

- [x] 打包流程缺口：`vsce package` 不触发生产构建，当时 `forgejo-toolkit-0.0.1.vsix` 是 watch 产物（banner 可证），含 msw + fixtures（144 处）与 2.1MB sourcemap——核实后 `package` 脚本（`pnpm run build && vsce package --no-dependencies`）本就先跑生产构建，漏的是旧包未重打与文档误导；已重打并验证包内无 msw/sourcemap（曾试 `vscode:prepublish` 钩子，vsce 只会用 npm/yarn 调它、不认 pnpm，放弃）
- [x] 随包 README（`packages/forgejo-toolkit/README.md`/`README.zh.md`）严重过时：打包命令写 `npx vsce package`（正好绕过生产构建）、token 存储写 global state（实际早已是 SecretStorage）、功能清单停留在早期形态、Scripts 表缺 test/package——已重写对齐现状
- [x] 编辑评论后时间线仍显示旧内容：`CommentTimeline.vue:51-69` 渲染缓存 key 只有 comment.id 不含 body，编辑保存后缓存命中旧 HTML，面板重载才更新（已坐实）——已加 body 来源比对，body 变化即重渲染
- [x] DateTimePicker date 类型序列化少一天：`DateTimePicker.vue:239-244` 对 iso 一律 `toISOString()`，日历格是本地午夜，UTC+8 选 5/10 发出 `2024-05-09T16:00Z`，Forgejo 网页端显示前一天（已坐实）——date-only 改发 UTC 正午，任何时区都落在所选日
- [x] 多 remote 后 worktree fetch 仍硬编码 `origin`：`viewProvider.ts` 的 `fetchBranch`/`fetchPullRequestHead`，而解析侧任一 remote 匹配即接受——fork 布局（origin=fork、upstream=base）下 `refs/pull/N/head` 从 fork 拉，fork 有同号 PR 时拉到错误代码且从不校验 sha——已加 `resolveRemoteForRepo` 按 URL 匹配 remote（origin 优先），PR fetch 后校验 sha 不符即删分支报错
- [x] onboarding 面板 `_resolveImageUrls` 对任意绝对 img URL 带 `Authorization: token` 抓取，未归一到实例源（对比 `resolveAttachmentImages` 的安全实现）——已删除该方法，改复用 `resolveAttachmentImages`

### 中优先级

- [x] `.vscodeignore` 排除不全：未排除 `*.vsix`（旧包会被嵌套打进新包）、`out/**/*.map`、`vitest.extension.config.ts`、`PRODUCT.md`——已全部补上
- [x] `revertMergeCommit` 的 `remoteMatchesInstance` 只比 host，同实例 fork 可通过 push 前校验（多 remote fetch 修复的遗留子项）——`revertMergeCommit` 新增 `expectedRepo` 参数，push 前解析目标 remote URL 并要求 owner/repo 与 PR 仓库一致（大小写不敏感），调用方传入 PR 的 owner/repo
- [x] 根 README 功能清单落后 ROADMAP「已完成」：PR review、通知中心、全局搜索、CI/Actions、Publish、RemoteSourceProvider、状态栏 PR、导出/导入、Start Work on Issue 等 10+ 项未提——中英清单已重写对齐
- [x] FAQ 与 release 文档过时：`FAQ.md`/`FAQ.zh.md` 称创建 Release 不能传附件（实际支持 pending 附件创建后自动上传，已核实 `RepoRefs.vue` 流程）改为「可以」并说明失败重试语义；`docs/release.md` publisher 前提改为已配置 `cpf23333`、只需其 PAT
- [x] 评论 thread key/scope 不含 ref：同 PR 文件 force-push 后新旧 sha 两个 diff 文档 thread key 相同，互相改写 range/误 dispose（`pullReviewThreadKeys.ts:19-30`、`pullReviewCommentController.ts:368-381`）——`PullReviewThreadScope` 新增 `ref` 字段并进入 key 与 `matchesScope` 比对，scope 构建取 URI 参数里的 ref
- [x] mention 补全/文档链接多仓库归属错误：`issueMentionProvider.ts:50-59` 不传 `preferredPath` 且全局缓存单一结果，多仓库时指向活动编辑器的仓库——改为缓存 `detectLinkedRepositories` 的完整 `all` 列表，按文档路径本地归属（含文档路径的最长 localPath 优先，无包含匹配回退首个），`isPathInsideFolder` 从 gitOperations 导出
- [x] 侧栏行内修改 due date 失败无提示且错误残留：`IssueDetail.vue`/`PullRequestDetail.vue` 错误写入编辑弹窗的 key，弹窗未开则静默，下次开弹窗看到旧错误——镜像 `state_toggle` 模式新增 `due_date_update` 回显与 `issueDueDateKey`/`pullRequestDueDateKey`，编辑器保存期间保持打开、成功才关闭、错误就地展示
- [x] 编辑态附件上传失败静默：`IssueDetail.vue`/`PullRequestDetail.vue` 的 `handleAttachmentUpload` 只有 try/finally 无 catch，零反馈 + unhandled rejection——补 catch，错误写入编辑弹窗 key 就地显示
- [x] 大体积下载仍受 30s 全局超时约束：`client.ts` 默认 `AbortSignal.timeout(30_000)` 覆盖 artifact 流式下载（2GB 上限）/CI 日志（10MB）/PR diff，慢网络中途 abort——CI 日志/PR diff 改用 5 分钟 `API_DOWNLOAD_TIMEOUT_MS`；artifact 流式下载取消总时长上限，改为 30s 无数据的 idle watchdog，停滞报错文案明确
- [x] `_treeCache` 完全失效：client 每消息新建（约 110 处 `new ForgejoClient`），60s TTL 缓存生命周期=单次请求——改为模块级共享缓存，key 含 origin + token 哈希（同 origin 多账号不共享），上限 50 条先进先出；新增 `clearTreeCache()` 供测试
- [x] `_detectServerOrigin` 误判：`website`/`original_url` 等外部 URL 字段参与计数可被「检测」为服务器源，随后仓库主页/镜像源链接被改写成实例坏链（`client.ts`）——两个 key 加入与 `avatar_url` 同级的忽略名单
- [x] compare 状态合并把「先 added 后 modified」错标为 `modified`：`client.ts` 条件写宽，base 侧拉取 404/空 diff——抽出 `mergeCompareStatuses`：added 后 modified 仍为 added、added 后 removed 抵消、removed 后 added 记 modified、renamed 优先于 generic changed
- [x] 零变更文件的 PR 永久显示加载中：`PullRequestDetail.vue` `filesLoading = files.length === 0 && !filesError`，空 diff 加载成功后 spinner 不消失——改为按 key 是否存在判断（与 comments/commits 一致）
- [x] RepoRefs 操作失败整列表被错误行替换且无重试入口：`RepoRefs.vue` 错误独占渲染，缓存数据不兜底——有缓存数据时保留列表 + 顶部错误条带 Retry；无数据时错误页也带 Retry；顺带解决低优先级「每次刷新整列表闪 Loading」（loading 仅在无数据时显示）
- [x] 删除实例后其 keep-alive 视图永久转圈：load 类消息无 `_requestId`/超时，host `_findInstance` 失败静默 return，webview 无任何错误提示——`viewProvider` 新增 `LOAD_RESULT_COMMANDS` 映射表与 `_handleMessage` 入口守卫：load 类命令目标实例不存在时按对应结果命令回 `{ error }`（原样回显 owner/repo/index 等路由字段），webview 各视图按既有错误路径展示
- [x] 日期面板按 Esc 连带关闭整个编辑模态框：`DateTimePicker.vue` 无法阻止原生 `<dialog>` 的 cancel 事件（`ModalDialog.vue`），脏表单还会额外弹放弃确认——面板打开时 Esc 做 preventDefault + stopPropagation，只关面板
- [x] `currentWindow` 模式打开 worktree 记录永不落盘：`openFolder` 重载销毁扩展宿主，其后的 `addWorktree()`/`_reply` 不执行（`gitOperations.ts:491`、`viewProvider.ts:3916-3924`）——`openWorktree` 新增 `beforeOpenInCurrentWindow` 回调，在用户确认后、`vscode.openFolder` 重载前执行；两个创建路径在该回调里写 WorktreeManager，新窗口路径维持打开后记录
- [x] `startWorkOnIssue` 的 issue worktree 从不写入 WorktreeManager：UI 删不掉、源仓库不受 LRU 活跃保护；复用残留目录只查 `fs.access` 无合法性校验（`viewProvider.ts:3709-3793`）——`WorktreeInfo` 新增 `kind?: 'pr' | 'issue'`（缺省视为 pr，`findWorktree` 与 PR 详情页 `hasWorktree` 只匹配 pr），issue worktree 以 `#issue-<n>` id 写入 WorktreeManager（记录时机同 PR 路径）；残留目录无 `.git` 条目时视为损坏，删除后重建
- [x] onboarding 的 `importInstances` 缺 `sanitizeImportedInstances` 校验：`onboardingPanel.ts:292-298` 直接 cast，与 viewProvider 同消息处理不一致——onboarding 面板对齐主面板：逐条 sanitize、全部无效时回 `instancesImported { success:false, error }`、部分丢弃记日志

### 低优先级

- [x] 4 个列表端点未分页被默认页大小截断——四个端点改经 `_fetchAllPages` 分页拉取（MSW handler 同步改 page 感知）
- [x] `_fetchAllPages` 与服务端 limit 钳制叠加时无声截断——MAX_PAGES 改 MAX_ITEMS（10×50）按总条数封顶，服务端钳 limit 不再缩窗口
- [x] i18n 漏网约 8 处硬编码英文错误串——en/zh.json `common` 下新增 7 键，替换 CommentTimeline/IssueDetail/PullRequestDetail 与 useAppState 全部硬编码
- [x] PR 详情页删除依赖无确认——新增 `handleRemoveDependency` 带 `showConfirm`，复用既有 key `dashboard.detail.removeDependencyConfirm`
- [x] 列表搜索防抖回调无 keep-alive 守卫——RepoIssues/RepoPullRequests 防抖回调内加 `isActive` 守卫
- [x] Notifications 视图只在 onMounted 加载一次——改 `onActivated`，keep-alive 返回时重新 loadAll
- [x] PullRequestForm 标签色无对比度计算——复制 IssueForm 的 `labelStyle`/`isLightColor`，模板改用动态样式，删除固定白字 CSS
- [x] RepoRefs 每次刷新整列表闪 Loading（与 RepoIssues「保留旧列表」策略不一致）——已随中优先级 RepoRefs 错误兜底一并修复（loading 仅在无缓存数据时显示）
- [x] FileTreeNode 目录行点击不展开/emoji 图标——整行点击与 Enter/Space 触发展开，行加 tabindex 与 focus-visible 样式，图标换 codicon
- [x] 源仓库被手动删除后 worktree 记录卡死在列表——`removeWorktree` 在源仓库不存在时跳过 git 直接删记录
- [x] PR 本地分支 `pr-<n>-<sha7>` 从不清理——PR 类型 worktree 删除后顺带 `deleteBranch`（issue 类型保留分支）
- [x] `openWorktree` 已打开检测用 fsPath 严格相等——新增 `pathsEqual`（win32 小写比较）处理盘符大小写差异
- [x] `_pendingMessages` 无界增长——加 MAX_PENDING_MESSAGES=50 上限，队满丢最旧并记日志
- [x] codicon（CC-BY-4.0）随包分发无署名——新增 `packages/forgejo-toolkit/NOTICE`（.vscodeignore 不排除，随包分发）
- [x] `msw` 在 `@cpf23333-forgejo-toolkit/api` 的生产 dependencies——移到 devDependencies（只被 generated/mocks 用）
- [x] `@types/vscode` 声明 ^1.85.0 实际装 1.125.0——改 `~1.85.0`
- [x] `docs/api-verification-checklist.md` 漂移 2 处——artifact 下载改记 stream（含 2GB 上限与 30s idle watchdog）、getUserRepositories 改记 `_fetchAllPages` 分页
- [ ] 根 README 引用 `docs/screenshots/` 10 张图片，目录不存在（发布前补截图或移除引用）
- [x] `forgejoToolkit.locale` 配置无 default 值——有意不加：`resolveLocale.ts` 在配置缺省时回退 VS Code UI 语言，静态 default 'en' 会破坏中文用户自动检测
- [x] shared/request 静默丢弃 falsy body——body 判空改 `!== undefined && !== null`，Content-Type 判断同步

### 存疑（需实测/核实）

- [ ] 私有实例（强制登录）commit 头像 401 裂图：`_resolveAvatarUrl` 不带 token 抓头像（防泄漏正确但与私有实例冲突），修法需先钉 origin 再带 token
- [ ] `ssh://` 带自定义端口的 remote 无法匹配实例（`shared/src/git/url.ts:21` host 含端口，自托管 SSH 2222/HTTPS 443 场景）；scp 式无此问题
- [ ] 行号右键评论被非空 selection 覆盖：`pullReviewCommentController.ts:532-543` 无条件用 selection 覆盖显式 lineNumber，取决于 VS Code 右键行号时是否重置 selection（需实测）
- [ ] `prFileSystemProvider.readFile` 的 `err.includes('404')` 匹配过宽吞掉真实错误；PR 中二进制文件经 base64→UTF-8 往返显示乱码（与 repoFileProvider 保留原始字节不一致）
- [ ] 文档关闭后 thread 无清理：无 `onDidCloseTextDocument` 监听，关闭 diff 后 thread 留在 Comments 面板（可视为导航特性，需确认意图）
- [ ] CSP `img-src`/`connect-src` 放行所有 http(s)（`content.ts:66`），可收敛到实例源 + cspSource
- [ ] webview config 注入未转义 `</script>` + `src|href` 全局重写发生在注入之后，怪异文件路径可截断 config 或被篡改（`content.ts:56,69-75`，CSP nonce 挡执行，仅 DoS/路径篡改）
- [ ] 键盘展开仓库文件树目录可能不加载子项（`RepoFileBrowser.vue:56-67` 只监听 vsc-tree-select，需 harness 实测）
- [ ] `vscode-icon` 操作图标（评论 kebab、通知行内操作）键盘可达性需真实 webview Tab 实测
- [ ] MentionHoverCard 无视口边界钳制，窄侧栏可能被裁（`MentionHoverCard.vue:74-86`，需窄栏实测）
- [ ] 含 `/` 分支名在 `git/trees/{sha}` 路由 404 导致文件搜索不可用（`client.ts:665` 注释已承认，需对照 Forgejo 源码 chi 路由核实 `%2F` 行为；branch protection `_probe` 吞 404 同理）

### 走查方向备忘（2026-09-14 盘点）

- [x] 打包/发布链路审计——已查（发现见高优先级前两项与中优先级 `.vscodeignore` 条目）
- [x] 依赖与 license 合规检查——已查：无强 copyleft；遗留的 codicon 署名、msw 归属、@types/vscode 漂移三项已随低优先级条目全部修复
- [x] 文档一致性走查——已查（发现见中优先级 README/FAQ 条目与低优先级 checklist/screenshots 条目，checklist 漂移已修）
- [ ] 性能专项检查：激活成本、webview bundle 体积、长列表渲染、git 子进程频率——暂缓
- [ ] 动态端到端走查：静态发现修复并重新打包 vsix 后，用 tools/ui-review harness 实测新功能闭环（多 remote 关联、关联仓库切换器、中文详情页）

## 进行中

（空）
