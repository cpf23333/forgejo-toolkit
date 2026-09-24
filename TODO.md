# TODO

短期任务清单。已交付功能的完整记录见 `ROADMAP.md` 的「已完成」一节；已完成条目的细节由本文件的 git 日志保存（2026-09-23 清理并同步过两次，只保留未完成项与仍然需要的上下文）。

## 发布 0.0.1（代码侧已完成，等待人工步骤）

- [ ] 推送 `main`：领先 `codeberg` / `origin`，条数以 `git rev-list --count <remote>/main..main` 为准（不写死，避免过期）
- [ ] 派发 `.forgejo/workflows/release.yml`：先勾 `dry_run` 确认输入回显与产物 **9 项**检查（其中 `.vsix` 的 `extension/changelog.md` 大小写那条是本次修好的发版阻断；`extension/NOTICE` 那条是本次新增，用于确认 DOMPurify 的 Apache-2.0 许可文本随包发出），再取消勾选正式创建 `v0.0.1` Release 并附上 `.vsix`
- [ ] 商店发布（需凭据）：VS Code Marketplace（publisher `cpf23333`）+ Open VSX，步骤见 `docs/release.md` 的 Checklist
- [ ] 发布后回填：① 把根 `CHANGELOG.md` 的 `## [Unreleased]` 改成 `## [0.0.1] - <发布日期>`，并原样复制到 `packages/forgejo-toolkit/CHANGELOG.md`（`packagingFiles.test.ts` 要求两份逐字节一致）；② 删掉 `README.md` / `README.zh.md` 安装段的「Not published yet / 尚未发布」提示，把 Marketplace 与 Open VSX 链接恢复成正常入口，并与 `docs/release.md` 的实际发布渠道对齐；③ 复核 `KNOWN_ISSUES` 中与版本相关的条目

## 0.0.1 之后

- [ ] P3 `IssueAddTime` 缺 422：**上游规格本身没有这个响应**（`packages/forgejo-api/spec/swagger.v1.json` 里 `POST /repos/{owner}/{repo}/issues/{index}/times` 只声明 `200/400/403/404`），所以重新生成补不上。`client.ts` 已注释服务端实际行为；要类型层面补齐得等上游 swagger 注解，或由我们本地手写类型（决定：暂不做）
- [ ] P3 重新生成 kubb 客户端需要能跑通的环境：本机 Windows + Node 24.14.0/25.6.1 上 `kubb generate` 稳定崩溃（exit 134，V8/libuv abort，出现过 3 次，崩溃点在它已经清空输出目录之后）。已加防护 `pnpm --filter @cpf23333-forgejo-toolkit/api generate:safe`（脏树拒绝启动 + 失败自动 `git restore`）；CI 容器是 Node 22，优先在那里跑并核对 diff
- [ ] P2 `X-Total-Count` 仍拿不到：**不是**共享请求层的问题——`packages/shared/src/request/index.ts` 的 `ResponseConfig` 一直返回 `headers`，丢掉它的是生成的 operation 包装层：每个 `packages/forgejo-api/src/generated/client/*.ts` 函数都只 `return res.data`（如 `issueListIssues.ts`）。所以列表总数与「是否还有更多」无法精确展示；要修得改生成流程让包装层透出 `headers`/`status`，或在调用处绕开包装层直接用请求客户端。通知分页已按「只有空页才算结束」处理，列表截断按「长度达到 500 即可能被截断」提示
- [ ] P5 低优先级（等上游）：`vscode-tree` 内按钮（IconActionButton）的 Enter/Space 被库自身 `keydown` 的 `preventDefault` 抑制（`@vscode-elements/elements` 2.5.1 既有行为）
- [ ] 等上游版本：Forgejo v17（约 2026-10 底）的 workflow / job rerun（`forgejo#13924`，用 ≥17.0 版本闸门，并同步移除 `KNOWN_ISSUES` 对应条目）；Actions 日志 ndjson + 服务端过滤（#12820 / #12821，低优先级）
- [ ] 规划中的功能：MCP Phase 2 写工具（默认关 + 设置逐项开启 + 不标 `readOnlyHint`）、MCP 多实例 fan-out、`forgejoToolkit.mcpEnabled` 开关
- [ ] P3 打包优化：`out/mcp-server.js` 里约 **350 KB** 的代码与 `out/extension.js` 重复——`packages/forgejo-toolkit/esbuild.js`（约 7–47 行）为扩展宿主和 MCP 服务器各配一份 esbuild，共享运行时（生成客户端、`shared` 请求层、zod 等）被打进两个包。做法是让两份 bundle 共用一个 chunk（或把 MCP 入口作为第二个 entry 输出），但**必须跑一次构建才能核对体积与 `forbid-vscode` 约束**，因此暂缓（决定：等发版后再做）
- [ ] P3 打包优化：onboarding / review 评论两个面板各自加载的是整份 dashboard webview 入口（`webview/src/main.ts` 在入口里同步注册 13 个 `@vscode-elements/elements` 模块，入口 335 KB，而面板 chunk 只有 8 KB / 5 KB），所以打开评论编辑器要解析整个 dashboard 外壳。做法是按面板拆分 webview 入口，或把 dashboard 主体改成懒加载路由；同样需要构建核对，因此暂缓
- [ ] P4 「创建 PR」状态栏仍会拉取整个打开中 PR 列表（上限 500 条 ≈ 10 次请求）才能回答分支查询。正确但浪费：要真正减少请求数需要在 `client.ts` 暴露分页方法（例如 `getRepoPullRequests(owner, repo, state, { page, limit })`），再由状态栏只取第一页。当前实现会在达到 500 条上限时写一条明确的警告日志，因此计数不会悄悄出错。改动涉及共享 API 面，留到发版后
- [ ] P5 已知代价（仅记录）：`API_REQUEST_TIMEOUT_MS`（30 s）约束的是**每一页请求**，而不是整次分页操作——`client.ts` 的分页辅助 `_fetchAllPages` 每页各发一次请求、超时按页重新计时，所以一次达到 500 条上限的分页读取在慢实例上累计可能持续数分钟（约 10 页 × 30 s）。需要整体上限的调用方必须自己传 `AbortSignal`
- [ ] P4 多窗口重复轮询/探测（每个窗口各跑一份通知轮询与版本探测，首次运行向导标记也存在竞态）已作为平台代价记录在 `KNOWN_ISSUES.md`；若之后要收敛，可选方向是用 globalState 时间戳做「一个窗口主导」的租约
- [ ] P4 两处已确认但发版前未修的低危问题（2026-09-23 第二轮审查）：① 依赖选择器读的是非响应式的 `TimedCache` 标记（`useAppState.ts` 的 `repoIssuesFetchedAt`），所以 `IssueDetail.vue`/`PullRequestDetail.vue` 里「无可选依赖」的提示永远不会渲染，且 `ensureRepoIssuesLoaded` 是空实现（按需加载从未发生）；② `Settings.vue` 的 `saveInstanceResult` 未按实例区分，实例 A 的保存回包落在用户正在编辑的实例 B 表单上会清空 B 已输入的 URL/token 并提示已保存
- [ ] P4 仓库详情对「没有 README」的仓库会多发一次 `/contents/README.md` 请求（`viewProvider.ts` 的 README 提示探测，而 `client.getRepoDetail` 已经取过同一份内容）。做法：给 `ForgejoRepoDetail` 加 `readmeSize?: number`（`src/api/types.ts` 与 `webview/src/types/api.ts` 两处镜像），`getRepoDetail` 复用已取到的 entry（`readme: entry?.content`、`readmeSize: entry?.content === undefined ? entry?.size : undefined`），`viewProvider` 改为读 `detail.readmeSize` 并在本地化提示里用该尺寸，即可去掉第二次请求并让提示继续生效
- [ ] P5 已确认但发版前未修的低危项（2026-09-23 第五轮审查）：① 导入设置只做类型断言不做校验，预览界面可能渲染原始 i18n key（`src/webview/instanceImport.ts` 的 `sanitizeImportedInstances` 附近；要按 locale / worktreeOpenMode / 轮询开关与间隔 / debug 等已知字段校验取值，未知值丢弃或回退）；② `host:/srv/git/repo.git` 这类带绝对路径的 scp 远端会被归一化成 `host/srv/git/repo` 并解析出 owner/repo（`gitOperations.ts` 的 `remoteComparisonKeys`），当前选择是“去掉前导斜杠后继续解析”而不是拒绝——需要决定按哪种语义处理（Forgejo 的仓库路径必然是 `/owner/repo.git`，因此拒绝更贴近真实）
- [ ] 已知的平台代价（无解，仅记录）：贡献 `mcpServerDefinitionProviders` 后，VS Code 会为查询 MCP 定义而**主动激活**扩展（上游 issue microsoft/vscode#266221「MCP server 导致扩展在所有工作区、连空工作区都被激活」）。官方激活事件清单里没有 MCP 条目（`onStartupFinished` 本身是标准事件），所以既不需要也无法声明专门事件；这一条只是记录代价本身——激活事件的实际取法（已补 `onStartupFinished`）与实测数据见下方「走查与实测」

## 走查与实测

- 走查清单在 `tools/ui-review/README.md` 的「Release walkthrough checklist」；跑 mock 走查需要 `pnpm --filter forgejo-toolkit build:extension`（不带 `--production`，否则 mock 被剥掉）。
- ①–⑧ 已于 2026-09-23 在隔离 dev host 上跑完（做法、证据与 harness 限制见该 README 与 git 日志）：delete 确认双向、通知全部已读、Actions 分页、导入损坏 JSON 均实测；④ pushurl 拦截用真实 git 仓库、⑧ MCP 入参校验与截断标记用真实实例（`tools/ui-review/src/mcpCheck.mjs`，8/8）。
- 性能与打包实测（2026-09-23，全部有可复现来源）：
  - 客户端：500 条 issue 列表 = **10 次请求**（`client.test.ts` 分页 mock 断言）；仓库内搜索上限 **200 条** + truncation 标记。
  - 渲染：500 行 issue 页 = 500 个 `.item-card`、**5,536 个元素、约 200 ms**（jsdom；`RepoIssues.renderCost.test.ts`）。这三个数字现在由该测试**锁死断言**（行数 / 元素总数 / 首末条目文本），DOM 或卡片数一变测试就失败：改动渲染结构时必须同步改测试与本节。
  - 打包（生产构建）：入口 JS 432 → **335 KB**、入口 CSS 204 → **1 KB**（codicon 不再内联 base64）、`OnboardingPanel`/`PullReviewCommentPanel` 拆成 **8 / 5 KB** 独立块、`easymde` 327 KB 懒加载 ⇒ 仪表盘首屏 636 → 约 **336 KB**。
  - 激活：dev host「Show Running Extensions」实测 **`cpf23333.forgejo-toolkit` = 91 ms**（同列表最低；VS Code 1.139.0 + 生产构建）。
  - 结论：**暂不虚拟化** 500 条列表——上限已封顶在 500 且界面会提示截断（见 `shared/src/limits.ts` 的 `LIST_ITEM_LIMIT`/`isListTruncated`），虚拟化的复杂度不划算，等真实 profile 出现卡顿再议。
  - MCP 可发现性：VS Code 不会仅因扩展贡献 `mcpServerDefinitionProviders` 就为取定义而激活它（dev host 实测，见 git 日志），因此 `activationEvents` 补了 `onStartupFinished`（不开 Dashboard 也会在启动时激活，实测 **90 ms**，见 `packages/forgejo-toolkit/package.json` 的 `activationEvents`）；真实环境 Chat 的「配置工具」已确认列出 `forgejo-toolkit → Forgejo: <实例名>` 与其工具 ✔。该事件已交付，仅剩「每次开窗都激活」这一平台代价，记录在「0.0.1 之后」一节。

## 进行中

（空）

## 第八轮审查后待修（2026-09-23；第六、七轮的确认项已全部修复并验证）

- [ ] **medium** 评论/评审编辑器保存时仍未等待进行中的图片上传（第七轮只覆盖了两个编辑表单）：`views/IssueDetail.vue`、`views/PullRequestDetail.vue`、`components/CommentTimeline.vue`、`views/PullReviewCommentEditor.vue`
- [ ] **medium** 通知对账把「超出轮询 50 条一页」的视图行误标为已读（`useAppState.ts` 的 reconcile 用 `unreadIds`，而宿主只取一页）
- [ ] **medium** `clearInstancePayloads` 忘记清 `repoIssuesFetchedAt`/`repoPullRequestsFetchedAt` 标记，被丢弃的列表不会重新拉取
- [ ] **medium** 宿主 Refresh 清了 memo，但 webview 的仓库级缓存仍会命中最多 30 s
- [ ] **medium** 设置向导只测 `/user` 就放行，权限不足的 token 也能保存，随后仪表盘显示「Failed to load: Permission denied」+「No repositories」，首用者会以为实例是空的
- [ ] **medium** 仪表盘空状态只有裸标签，且在加载失败（403 等）时也显示；文案缺少下一步引导
- [ ] **medium** revert merge 不可回滚也不校验：push 失败会留下本地 revert 提交、冲突会留下 mid-revert 状态，调用方仍回 success:true
- [ ] **medium** `ConfigManager.init()` 的 token 迁移写实例数组时没有用 add/remove 那套跨窗口合并
- [ ] **low** 向导「从文件导入」失败无任何提示（错误只由 Settings 渲染）；向导可在零实例时宣告「初始设置完成」；完成页「打开仪表盘」按钮不导航；实例导出就地截断目标文件（中断会毁掉上一次导出）；删除实例不清理其 worktree 记录与缓存裸克隆
