# TODO

短期任务清单。已交付功能的完整记录见 `ROADMAP.md` 的「已完成」一节；已完成条目的细节由本文件的 git 日志保存（2026-09-23 清理过一次，只保留未完成项与仍然需要的上下文）。

## 发布 0.0.1（代码侧已完成，等待人工步骤）

- [ ] 推送 `main`：2026-09-23 复查为领先 `codeberg` 12 / `origin` 13 条（以 `git rev-list --count <remote>/main..main` 为准）
- [ ] 派发 `.forgejo/workflows/release.yml`：先勾 `dry_run` 确认输入回显与产物 8 项检查，再取消勾选正式创建 `v0.0.1` Release 并附上 `.vsix`
- [ ] 商店发布（需凭据）：VS Code Marketplace（publisher `cpf23333`）+ Open VSX，见 `docs/release.md` 的 Checklist
- [ ] 发布后回填：README 安装段与 `docs/release.md` 对齐实际发布渠道；复核 `KNOWN_ISSUES` 中与版本相关的条目

## 0.0.1 之后（按优先级）

- [x] P2 API 核对发现的扩展侧偏差——**已修部分**（2026-09-23，基准 commit `62c6d1c`，细节见 `docs/api-verification-checklist.md` 各端点的「差异记录」）：
  - [x] Actions 状态词表：新增 `webview/src/utils/actionStatus.ts`（真实状态集 + `blocked` 可取消 + 图标映射，去掉并非 Forgejo 状态的 `pending`/`requested`），`ActionRunDetail.vue` 与 `RepoActions.vue` 改用共享实现、CSS 图标分组同步为 `.waiting/.blocked`，新增 6 条用例
  - [x] `GET /pulls` 的 `null` 元素：`client.ts` 新增 `_definedPullRequests` 过滤（关键字路径与非关键字路径都经过它），避免 `createPrStatusBar` 解引用崩溃
  - [x] `GET .../issues/{index}/dependencies` 分页：改为经 `_fetchAllPages(page/limit)` 取全量，不再默认只取 30 条且无总数头
  - [x] timeline 短页提前结束：`_fetchAllPages` 新增 `shortPageMarksEnd` 选项，timeline 调用关闭该启发式（持续翻页到空页，因为过滤发生在分页之后）
  - [x] `stopwatch/delete` 的确认文案改为「取消正在运行的计时器」（en/zh，l10n 187/187 对齐）；删除冗余的 `artifactDownloadUrl`；修正 `serverVersion.ts` 注释里的 `gitea-1.22` → `gitea-1.22.0`
- [x] P2 API 核对发现的**其余偏差**——已全部修（2026-09-23，`3fe67b9`）：
  - [x] 时间追踪「汇总」语义：新增 `webview/src/utils/trackedTime.ts` 的 `isTrackedTimeTotal`，两个详情页把合计标注为「记录的总工时 / 我的工时」——仅当调用者是 issue 作者、或列表里已出现他人条目时才声称是总计（绝不夸大）
  - [x] 他人计时条目的删除按钮：`canDeleteTrackedTime` 只在本人（或名字未知）的行上渲染；`KNOWN_ISSUES`（en/zh）记录「站点管理员无法从扩展删除他人计时」与走网页端的规避方法
  - [x] stopwatch 每用户全局唯一：`findStopwatchElsewhere` + 面板提示「{issue} 上已有计时，在这里启动会结束它并记入工时」，按钮不再是静默暗算
  - [x] `stopwatch/delete` 的确认文案改为「取消正在运行的计时器」（en/zh）；`isNameConflictError` 注释说明 409 与 422 各自对应的场景
- [ ] P3 生成的 `IssueAddTime` 错误类型缺少服务端实际会返回的 422（`client.ts` 已加注说明）——随「kubb 规格源未固定」那条一起，重新生成时补齐

- [~] P2 `_fetchAllPages` 截断标记：**MCP 侧已完成**——`client.ts` 导出 `LIST_ITEM_LIMIT`（=500），`mcp/tools.ts` 的 `callTool` 对达到上限的数组结果追加 `(list truncated at 500 items; narrow the query to see the rest)`（`listTruncationNote`，2 条测试：纯函数 + 经注册工具的端到端接线）。**仍待做**：host → webview 的列表界面（issue / PR / commit / 评论 / 分支 / 标签 / Release / 仓库浏览）还没有提示，文件搜索那套 `{ files, truncated }` 模式可以照搬；实现时无需改 client 契约——上限现在是共享常量 `shared/src/limits.ts` 的 `LIST_ITEM_LIMIT`（host 与 webview 同源），界面用 `isListTruncated(items)` 判断即可（shared 有 2 条测试）。**已完成两个界面**：`RepoIssues.vue` 与 `RepoPullRequests.vue` 在列表底部显示 `dashboard.repoIssues.truncated` / `dashboard.repoPullRequests.truncated`（en/zh 同步，parity 测试通过）；剩余的列表界面结构不同，需要逐个做（已勘察）：
  - `IssueDetail.vue` / `PullRequestDetail.vue` 里的**评论时间线、提交列表、变更文件、分支**等，各自是独立 payload（都受 500 上限约束），且空状态用的是 `dashboard.detail.*` 键、没有 `<列表名>.empty`——所以每个列表要各自加一个 `isListTruncated(...)` computed + 一条独立文案（建议新增 `dashboard.detail.commentsTruncated` / `commitsTruncated` / `filesTruncated` 等）；
  - `RepoIssues.vue` / `RepoPullRequests.vue` 里的分支/标签只是下拉选项，不需要这条提示；
  - **详情页三处已补齐（2026-09-23）**：评论时间线（`CommentTimeline.vue` → `dashboard.detail.commentsTruncated`）、变更文件（`DiffFileList.vue` → `filesTruncated`）、提交（`CommitDiffList.vue` → `commitsTruncated`），都放在组件内部，所以 Issue/PR 两个详情页同时受益；测试：`DiffFileList.test.ts` 新增「500 条出现提示、499 条不出现」，`IssueDetail.test.ts` 的 harness 新增「500 条时间线出现提示」（顺带给该 harness 补了子组件需要的 `loadCommentReactions`/`renderComment` 与 `commentReactionsKey`/`issueCommentEditFormKey` 桩）。
  - **仓库级 refs/Release 也补齐了（2026-09-23）**：`RepoRefs.vue`（分支 / 标签 / Release 三个 tab 共用一份 paged 数据）按当前 tab 的列表判断并显示 `dashboard.repoRefs.truncated`；测试加在既有的 `RepoRefs.test.ts`（500 条出现、499 条不出现）。仓库浏览（`RepoFileBrowser.vue`）本来就有 `searchTruncated`，无需改动。至此 C① 的界面侧覆盖：Issues / PR / 评论时间线 / 变更文件 / 提交 / 分支 / 标签 / Release + MCP 结果 + 共享常量。`X-Total-Count` 仍不可用（请求层不透出响应头）。当前限制与规避方法见 `KNOWN_ISSUES`
- [ ] P2 代理支持：请求走全局 `fetch`，不读 `HTTP(S)_PROXY` / VS Code `http.proxy`。方向：按设置接入 undici `ProxyAgent`——需要新增依赖，且代理行为无法在 CI 覆盖；当前限制见 `KNOWN_ISSUES`
- [x] P2 MCP 工具调用取消：`ForgejoClient.withSignal(signal)` 会为该客户端的**每个**请求带上信号（`withAbortSignal` 合并进请求配置，共享请求层本来就把它转给 fetch），MCP 侧在派发时用 `handlersFor(extra)` 以带信号的客户端重建处理器（不改 27 个处理器签名）。测试：`mcp/__tests__/tools.test.ts` 断言派发把信号交给 `withSignal`、无信号时不重建；`src/api/__tests__/clientSignal.test.ts` 断言合并本身。（MSW 会重建 Request 丢掉调用方信号，所以端到端断言放在请求层与合并两步上。）
- [ ] P3 `packages/forgejo-api` 规格源固定：`kubb.config.ts` 仍直接读上游 swagger（生成器包已钉到 `4.39.2`），建议 pin 到上游 tag 并记录版本；`src/generated/client|mocks` 目前无 value 导入，可考虑只保留 types
- [x] P3 通知分页的边界：不再把「短页」当作列表结束——只有空页才结束（服务端可能把页大小压到 50 以下，而总数只在生成的 client 不透出的响应头里）。代价是最末尾多一次「加载更多」请求/点击；`useAppState.ts` 的规则 + `Notifications.test.ts`/`useAppState.test.ts` 共 5 条断言已同步。
- [~] P3/D⑧ 「未打开 Dashboard 时 MCP server 是否会被 VS Code 发现」：**机制已核实（2026-09-23），只差你机器上的一次实机确认**。
  - VS Code 官方的**全部激活事件**清单里**没有** MCP 相关条目（`onLanguageModelTool`/`onChatParticipant` 分别对应语言模型工具与聊天参与者，不适用），所以「贡献 `mcpServerDefinitionProviders` 后 VS Code 为取定义而激活扩展」是平台自带行为，**不需要也无法**声明专门激活事件；这也印证了当初不加 `onStartupFinished` 的决定。
  - 已知代价：VS Code 会因此主动激活扩展来查询 MCP 定义（上游 issue microsoft/vscode#266221 的标题即「MCP server 导致扩展在所有工作区、连空工作区都被激活」），属平台行为，扩展侧无法改成惰性。
  - **为什么没能在 dev host 里做完确认**：`mcpServerProvider.ts` 在 `config.getInstances()[0]` 为空（或无 token）时返回 `[]`；harness 的隔离 profile 没有实例，也**无法**预置——实例要经「添加实例」向导写进 globalState/SecretStorage，而该向导是**编辑器区面板**，驱动器只能操作侧边栏 webview（既有结论）。所以 dev host 里 Chat 的工具选择器必然是空的，不构成结论。
  - **给你的一次确认（约 1 分钟）**：在你自己的 VS Code 里配好实例 → **不要**打开 Forgejo Dashboard → 新开窗口 → 打开 Chat → 打开工具选择器（或输入 `#tools`）→ 看是否出现 `Forgejo: <实例名>` 的工具。若看不到，再补 `onStartupFinished`（代价：每次开窗都激活）。
- [x] `prFileSystemProvider` 对 >10 MiB 文件的文案：contents API 返回 `content: ""` + 真实 `size` 时，PR diff 现在返回一条本地化说明（`missingPayloadNotice`，带 2 条单测）而不是空文档；`KNOWN_ISSUES` en/zh 已同步。
- [ ] 同一提示还该落到仓库浏览（webview 文件查看器）与仓库概览的 `README.md`：它们仍把空 `content` 渲染成空文档。原条目：- [ ] 走查补充：`prFileSystemProvider` 对 >10 MiB 文件在 PR diff 里的文案落点（contents API 返回空 `content`，见 `KNOWN_ISSUES`）；性能实测（激活耗时、懒加载后体积）
- [~] P5 500 条列表全量渲染、无虚拟化：**已拿到部分实测证据**（2026-09-23）——
  - 客户端：500 条 issue 列表 = **10 次请求**（PAGE_SIZE 50，硬上限 `LIST_ITEM_LIMIT` 500），已在 `client.test.ts` 用分页 mock 钉住；仓库内搜索返回**上限 200 条 + truncation 标记**（`client.test.ts` 既有断言），所以搜索列表不需要虚拟化。
  - 打包产物（dev 构建）：入口 `index-*.js` **432 KB**、入口 CSS **204 KB**（内含 codicon TTF 的 base64）、`easymde` 懒加载块 319 KB、`PullRequestDetail`/`RepoDetail` 各 41-42 KB ⇒ C⑥ 的入口拆分与 codicon 去重有明确目标。
  - **仍缺**真实渲染成本：需要 dev host（或按 `IssueDetail.test.ts` 那套生成式 harness 给列表视图建测试）量 DOM 节点数与渲染耗时，再决定是否虚拟化。等构建授权后做。
- [ ] 低优先级（等上游）：`vscode-tree` 内按钮（IconActionButton）的 Enter/Space 被库自身 `keydown` 的 `preventDefault` 抑制（`@vscode-elements/elements` 2.5.1 既有行为）
- [x] onboarding 面板的 CSP：改为该面板直接允许 `http:` 图片（`allowInsecureImages`，`content.ts` 的 `buildContentSecurityPolicy` 抽出并加了 3 条 CSP 断言；向导的表单不做持久化，重建面板会清空输入，所以不能靠重建套用 origin）。原条目：- [ ] 低优先级：onboarding 面板的 CSP 只在 HTML 重建时生效——`http://` 实例的 markdown 图片在下一次面板重建前仍被拦（https 实例不受影响），需在 `testConnection` 成功后按 origin 变化重建
- [ ] 规划中的功能：MCP Phase 2 写工具（默认关 + 设置逐项开启 + 不标 `readOnlyHint`）、MCP 多实例 fan-out、`forgejoToolkit.mcpEnabled` 开关
- [ ] 等上游版本：Forgejo v17（约 2026-10 底）的 workflow / job rerun（`forgejo#13924`，用 ≥17.0 版本闸门，并同步移除 `KNOWN_ISSUES` 对应条目）；Actions 日志 ndjson + 服务端过滤（#12820 / #12821，低优先级）

## 走查

- 清单在 `tools/ui-review/README.md` 的「Release walkthrough checklist」；跑 mock 走查要用 `pnpm --filter forgejo-toolkit build:extension`（不带 `--production`，否则 mock 被剥掉）。
- ①–⑧ 已于 2026-09-23 在隔离 dev host 上跑完（做法、证据与 harness 限制见该 README 与 git 日志）：delete 确认双向、通知全部已读、Actions 分页、导入损坏 JSON 均实测；④ pushurl 拦截用真实 git 仓库、⑧ MCP 入参校验与截断标记用真实实例（`tools/ui-review/src/mcpCheck.mjs`，8/8）。
- 仍需在真实环境补做：`prFileSystemProvider` 大文件文案、性能实测（见上）。

## 进行中

（空）

## 代码审查（2026-09-23，已完成主体）

8 个审查小组 + 8 个独立交叉核对小组（16 个 agent）覆盖：① 当日 6 条提交的 diff；② 高风险区域（`useAppState.ts` 的 pending/超时/竞态、`viewProvider.ts` 的消息分发与错误回传、安全面：token 流向 / MCP 路径校验 / 附件代理 / CSP / URL 重写 / worktree 与 git 副作用）；③ 全面复审（性能与打包、i18n 与可访问性、测试与文档一致性、AGENTS 合规）。共 61 条发现，53 条确认、4 条被反驳。

- [x] 已修（18 项）：release 工作流 `.vsix` 检查的大小写（发版阻断）、timeline 空页翻页洞（两空页前瞻）、git 参数注入（`assertGitRevision`/`assertCommitSha`，9 个调用点）、Actions run 删除按钮缺状态闸门、通知错误不复位、评论编辑/删除跨实例误改（3 处）、附件上传回复缺 `id`、导出取消被报成失败、实例 id 冲突（`instanceIdFor`）、`KNOWN_ISSUES` 结构与 tab、`i18nParity` 覆盖 `translate()`、CI 补 Lint + API 审计 + shared 测试、API 清单的状态更新节、CI 日志缓存上限（10 条）、文件搜索截断标记（200 条上限，复用 `repoFileSearchTruncated`）、依赖选择器懒加载（`repoIssuesFetched` 判断是否已加载）、评论 reactions 撤回懒发并加 4 并发上限（`e75357c`）。
- [x] 已补 6 处弱测试（审查确认「回退修复仍全绿」）：依赖 >50 的 mock 分页、`[null, pr]` 过滤、timeline 空页（`client.test.ts`）、视图层 blocked 取消按钮与删除闸门（`ActionRunDetail.test.ts`）、tracked-time 标签/删除按钮/计时提示（新建 `IssueDetail.test.ts` harness，4 条）、reactions 并发上限与队列放行（`useAppState.test.ts`）。
- [x] 第 7 处也补上了：导出取消的 dispatch 用例（`viewProviderDispatch.test.ts` 断言「警告弹窗关闭」与「保存对话框取消」两条路径都回 `{ success: false, cancelled: true }`；顺带给共享 vscode mock 补了 `showSaveDialog`）。至此 8 处弱测试全部补齐。
- [x] T2 已完成：文件搜索截断标记、依赖选择器懒加载（含「是否已加载」判断）、评论 reactions 预取 + 4 并发上限（原「懒发」方案已撤回：评论显示时就必须看到数字）。
- [ ] 发版后再做：webview 入口拆分（三面板并集，441 KB JS + 208 KB CSS，三个 webview 共用一个 index.html）、codicon CSS/TTF 去重（入口 CSS 内联 168 KB base64）。

## C/D 类收尾时的状态（2026-09-23，目标 12 轮用尽）

- [x] C③ MCP 工具调用取消（`withSignal` + 派发重建处理器，2 条测试）
- [x] C⑤ 通知分页边界（只有空页算结束，5 条断言同步）
- [~] C① 截断标记：MCP（`listTruncationNote`，2 条测试）+ 共享上限（`shared/src/limits.ts`，2 条测试）+ Issues/PR 两个列表界面；其余视图（commit / 评论 / 分支 / 标签 / Release / 仓库浏览）照三行补即可
- [x] D⑦ 导出取消 dispatch 测试（并给共享 vscode mock 补了 `showSaveDialog`）
- [x] D⑨ >10 MiB 文案（PR diff 返回本地化说明 + 2 条测试）
- [x] D⑪ onboarding CSP（`allowInsecureImages` + 3 条 CSP 断言 + KNOWN_ISSUES）
- [~] D⑩ 性能实测：客户端与打包数字已拿到（500 条 = 10 次请求；入口 432 KB JS / 204 KB CSS / codicon TTF 内联；easymde 319 KB 懒加载）；**500 行列表的 DOM 实测仍缺**，需构建授权或生成式 harness
- [x] D⑬ 虚拟化决策（2026-09-23，已定）：**暂不虚拟化**。证据——`RepoIssues.renderCost.test.ts` 实测整页 500 行 = **500 个 `.item-card`、5,536 个元素、约 200 ms**（jsdom，浏览器实测会更快；元素数是可移植指标），列表本身已被 `LIST_ITEM_LIMIT` 封在 500，且 C① 已让用户知道被截断；仓库内搜索更早封在 200。虚拟化的复杂度（窗口化 + 键盘/滚动可达性）不值得，等真实 profile 出现卡顿再议。
- [x] C② HTTP 代理（2026-09-23）：`pnpm --filter forgejo-toolkit add undici`（^8.11.0）；共享请求层新增 `dispatcher` 并透给 `fetch`；`src/api/proxy.ts` 的 `resolveProxyUrl`（设置优先于 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`，忽略空白）与 `createProxyDispatcher`（按 URL 缓存一个 `ProxyAgent`）；`ForgejoClient` 新增 `withDispatcher` + `setDefaultRequestDispatcher`，激活时（`extension.ts`）与 MCP 进程（`mcp/server.ts`）各设置一次；`KNOWN_ISSUES` en/zh 改写为「支持代理，但 `no_proxy` 不被解释」。测试：`proxy.test.ts`（解析顺序/空白/缓存）+ `clientSignal.test.ts` 的 `withDispatcher` 合并断言。
- [x] C③-规格目标（2026-09-23，按「API 要对应目标版本」）：快照改为**发行 tag** `v16.0.0`（`templates/swagger/v1_json.tmpl`，853,826 字节 / 326 路径 / `IssueMeta` 无 required），不再用 `https://codeberg.org/swagger.v1.json`——那个端点当时供的是 `16.0.0-dev-753-…` 的**开发版**，会带进 16.0.x 之后才有的改动（例如把 `IssueMeta.index/owner/repo` 标成必填）。`spec:update` 现在按 `FORGEJO_SPEC_TAG`（默认 `v16.0.0`）取 tag 里的文件；**快照已换成 v16.0.0，生成产物待用 `generate:safe` 重跑一次即可回到与目标版本一致**。
- [x] C④ 规格源固定（2026-09-23）：快照落到 `packages/forgejo-api/spec/swagger.v1.json`（853,940 字节，`info.version = 16.0.0-dev-753-6bcc6da0+gitea-1.22.0`，326 条路径，2026-09-23 抓取），`kubb.config.ts` 改读该文件，新增 `spec:update` 脚本与 `spec/README.md`（来源/版本/刷新流程）；**生成产物未动**——它本来就对应这份规格，所以没有引入漂移。
  - **更正**：`IssueAddTime` 缺 422 **不是生成器的问题**——固定下来的规格里 `POST /repos/{owner}/{repo}/issues/{index}/times` 只声明 `200/400/403/404`，重新生成补不上这个类型。`client.ts` 的注释已记录服务端实际会返回 422；要类型层面补齐得等上游 swagger 注解，或由我们本地补类型（你定）。
  - **重新生成受阻（2026-09-23）**：`pnpm --filter @cpf23333-forgejo-toolkit/api generate` 在本机 Windows 上**两次崩溃**（exit 134，V8/libuv abort，默认堆与 `NODE_OPTIONS=--max-old-space-size=6144` 都一样），崩溃点在 `kubb` 已经**清空输出目录之后**——工作树因此被删了 2178 个文件，我用 `git restore --source=HEAD --worktree packages/forgejo-api/src/generated` 复原（未动索引与历史）。已把这条风险与复原命令写进 `spec/README.md`。生成树完好，快照可用；重新生成需要换一个能跑通 kubb 的环境（CI 容器是 Node 22，优先在那里试）。
  - **已加防护（2026-09-23）**：新增 `pnpm --filter @cpf23333-forgejo-toolkit/api generate:safe` —— 先拒绝在「`src/generated` 有本地改动」时启动，运行失败时自动 `git restore` 复原。已实测（第 3 次崩溃 exit 134 后脚本自动复原，`git status` 只剩脚本自身的新增/修改），并在 `spec/README.md` 里写明「kubb 先清后写」的风险与用法。
- [x] C⑥ 打包优化（2026-09-23，构建验证）：入口**按面板拆分**（`main.ts` 里两个独立面板改动态 `import()`，产出 `OnboardingPanel` 8 KB / `PullReviewCommentPanel` 5 KB 独立块）并**去掉重复的 codicon 样式导入**（`@vscode/codicons/dist/codicon.css` 已由 `content.ts` 以 `<link id="vscode-codicon-stylesheet">` 注入、文件由 `copyCodicons` 拷进产物，vscode-elements 正是读该 link 的 href）。实测入口 **JS 432 → 327 KB**、入口 **CSS 204 → 1 KB**（不再内联 164 KB base64 TTF；`codicon.ttf` 仍以文件形式随包，123 KB），仪表盘首屏从 636 KB 降到 328 KB（约 −48%）。`vite build` 通过、全量测试/检查通过。
- [~] D⑧ MCP 激活核对：见上面 P3 条目（机制已核实；实机确认需你在配好实例的窗口里做一次，harness 无法预置实例）。
- [ ] D⑫ vscode-tree 键盘：等上游库修复（`vscode-tree` 的 `IconActionButton` 在 `keydown` 里 `preventDefault`），当前仅在 KNOWN_ISSUES/待办里登记
