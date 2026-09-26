# TODO

短期任务清单。已交付功能的完整记录见 `ROADMAP.md` 的「已完成」一节；已完成条目的细节由本文件的 git 日志保存（2026-09-23 清理并同步过两次，只保留未完成项与仍然需要的上下文）。

## 0.0.1 已发布（2026-09-26，剩余渠道补齐）

0.0.1 已上线：VS Code Marketplace 条目生效；私服（两个镜像）已创建 `v0.0.1` Release 并附 `.vsix`；CHANGELOG 已回填 `## [0.0.1] - 2026-09-26`；README 安装段已改为 Marketplace 主入口。剩余：

- [ ] 推送 `main`（当前领先 `codeberg` / `origin` 1 个提交）与 `v0.0.1` tag 到 codeberg（tag 目前在私服）
- [ ] 在 Codeberg 手动创建 `v0.0.1` Release 并上传 `.vsix`（不需要 runner；UI 或 API 均可）——README 的 Release 链接届时才真正落地
- [ ] Open VSX 发布（需凭据）：步骤见 `docs/release.md` 第 5 节；发布前在 README ×2 与 `docs/release.md` 移除「尚未发布」的 Open VSX 注记
- [ ] broker 模式的补充验证（2026-09-27 起适用）：扩展窗口开着时 Agents 窗口里 `whoami` 应认证成功（server 日志出现 "forwarding to the extension-host broker"），关掉所有扩展窗口后同一路径降级为匿名只读

## 0.0.1 之后

- [ ] P3 `IssueAddTime` 缺 422：**上游规格本身没有这个响应**（`packages/forgejo-api/spec/swagger.v1.json` 里 `POST /repos/{owner}/{repo}/issues/{index}/times` 只声明 `200/400/403/404`），所以重新生成补不上。`client.ts` 已注释服务端实际行为；要类型层面补齐得等上游 swagger 注解，或由我们本地手写类型（决定：暂不做）
- [ ] P3 重新生成 kubb 客户端需要能跑通的环境：本机 Windows + Node 24.14.0/25.6.1 上 `kubb generate` 稳定崩溃（exit 134，V8/libuv abort，出现过 3 次，崩溃点在它已经清空输出目录之后）。已加防护 `pnpm --filter @cpf23333-forgejo-toolkit/api generate:safe`（脏树拒绝启动 + 失败自动 `git restore`）；CI 容器是 Node 22，优先在那里跑并核对 diff
- [ ] P2 `X-Total-Count` 仍拿不到：**不是**共享请求层的问题——`packages/shared/src/request/index.ts` 的 `ResponseConfig` 一直返回 `headers`，丢掉它的是生成的 operation 包装层：每个 `packages/forgejo-api/src/generated/client/*.ts` 函数都只 `return res.data`（如 `issueListIssues.ts`）。所以列表总数与「是否还有更多」无法精确展示；要修得改生成流程让包装层透出 `headers`/`status`，或在调用处绕开包装层直接用请求客户端。通知分页已按「只有空页才算结束」处理，列表截断按「长度达到 500 即可能被截断」提示
- [ ] P5 低优先级（等上游）：`vscode-tree` 内按钮（IconActionButton）的 Enter/Space 被库自身 `keydown` 的 `preventDefault` 抑制（`@vscode-elements/elements` 2.5.1 既有行为）
- [ ] 等上游版本：Forgejo v17（约 2026-10 底）的 workflow / job rerun（`forgejo#13924`，用 ≥17.0 版本闸门，并同步移除 `KNOWN_ISSUES` 对应条目）；Actions 日志 ndjson + 服务端过滤（#12820 / #12821，低优先级）
- [ ] 规划中的功能：`forgejoToolkit.mcpEnabled` 开关；MCP Phase 2 写工具见「AI / MCP 规划」一节
- [ ] P3 打包优化：`out/mcp-server.js` 里约 **350 KB** 的代码与 `out/extension.js` 重复——`packages/forgejo-toolkit/esbuild.js`（约 7–47 行）为扩展宿主和 MCP 服务器各配一份 esbuild，共享运行时（生成客户端、`shared` 请求层、zod 等）被打进两个包。做法是让两份 bundle 共用一个 chunk（或把 MCP 入口作为第二个 entry 输出），但**必须跑一次构建才能核对体积与 `forbid-vscode` 约束**，因此暂缓（决定：等发版后再做）
- [ ] P3 打包优化：onboarding / review 评论两个面板各自加载的是整份 dashboard webview 入口（`webview/src/main.ts` 在入口里同步注册 13 个 `@vscode-elements/elements` 模块，入口 335 KB，而面板 chunk 只有 8 KB / 5 KB），所以打开评论编辑器要解析整个 dashboard 外壳。做法是按面板拆分 webview 入口，或把 dashboard 主体改成懒加载路由；同样需要构建核对，因此暂缓
- [ ] P4 「创建 PR」状态栏仍会拉取整个打开中 PR 列表（上限 500 条 ≈ 10 次请求）才能回答分支查询。正确但浪费：要真正减少请求数需要在 `client.ts` 暴露分页方法（例如 `getRepoPullRequests(owner, repo, state, { page, limit })`），再由状态栏只取第一页。当前实现会在达到 500 条上限时写一条明确的警告日志，因此计数不会悄悄出错。改动涉及共享 API 面，留到发版后
- [ ] P5 已知代价（仅记录）：`API_REQUEST_TIMEOUT_MS`（30 s）约束的是**每一页请求**，而不是整次分页操作——`client.ts` 的分页辅助 `_fetchAllPages` 每页各发一次请求、超时按页重新计时，所以一次达到 500 条上限的分页读取在慢实例上累计可能持续数分钟（约 10 页 × 30 s）。需要整体上限的调用方必须自己传 `AbortSignal`
- [ ] P4 多窗口重复轮询/探测（每个窗口各跑一份通知轮询与版本探测，首次运行向导标记也存在竞态）已作为平台代价记录在 `KNOWN_ISSUES.md`；若之后要收敛，可选方向是用 globalState 时间戳做「一个窗口主导」的租约
- [ ] 已知的平台代价（无解，仅记录）：贡献 `mcpServerDefinitionProviders` 后，VS Code 会为查询 MCP 定义而**主动激活**扩展（上游 issue microsoft/vscode#266221「MCP server 导致扩展在所有工作区、连空工作区都被激活」）。官方激活事件清单里没有 MCP 条目（`onStartupFinished` 本身是标准事件），所以既不需要也无法声明专门事件；这一条只是记录代价本身——激活事件的实际取法（已补 `onStartupFinished`）与实测数据见下方「走查与实测」

## AI / MCP 规划（2026-09-25 评审后立项）

按建议优先级排序；MCP 侧无头进程的输出文案保持英文（既有约定），webview 侧文案走 i18n 双语 JSON。

- [ ] **P1 面向 agent 上下文预算的聚合工具**：`get_pr_review_brief`（一次返回 diff 统计 + 评审状态 + 未解决评论，替代连续 4 次调用）
- [ ] **P2 PR 描述生成（`vscode.lm` 试点）**：创建 PR 表单加「生成描述」按钮，diff + commit 列表生成草稿填入 body。需验证 Copilot 订阅缺失时的降级路径；代码片段会发给模型供应商，加默认关闭的设置开关
- [ ] **P2 Issue 分诊建议**：按内容建议 labels/assignees（把现有 label 描述喂给模型选）
- [ ] **P2 AI 预评审（draft-only）**：PR diff 视图「AI 预评审」，意见只落成 pending review 草稿、逐条人工确认后才提交（与 Codeberg 对 LLM 自主维护的忌讳对齐）
- [ ] **P3 copilot-instructions 生成器**：一键为仓库写入「本仓库 = 实例 X 的 owner/repo，可用 forgejo-toolkit MCP 工具」片段，与 `get_workspace_repository` 互补（事先告知 vs 主动问）
- [ ] **P3 通知 AI 摘要**：通知列表「总结讨论」按钮，`vscode.lm` 浓缩时间线
- [ ] Phase 2 写工具的确认模型设计（先于实现）：无头 MCP 进程弹不了 VS Code 确认框，只能靠逐项设置开关 + 不标 `readOnlyHint`（交给 VS Code 工具审批）+ description 写明副作用；首批只开创建评论 / 提交 review / 重跑 workflow

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
- 新 MCP 功能走查（2026-09-25/26，全部通过）：主窗口 Copilot 会话实测——每实例各一个 server、29 个工具、3 个 prompt 模板、`get_workspace_repository` 归因正确、`get_ci_failure_summary` 对真实失败 run 返回错误上下文与日志尾部；Agents 窗口路径实测——「为 Agents 窗口复制 MCP 配置」命令的选项/警示/合并写入全过，Agent Host 新会话经 broker 认证调通 `whoami`（token 不落盘）；匿名只读提示在 server 日志中可见。**Linux headless（WSL Ubuntu 26.04 + Node 22）**：全量 typecheck + 1730 测试通过（1 个 Windows 专属用例按条件跳过），期间修复 unix socket ECONNRESET 误分类与 macOS sun_path 长度风险；macOS 无独立验证环境（Codeberg 无 macOS runner）。**私服 CI（ci.yml #11+）**：验证导出测试的 mock 泄漏依赖与 `flushUntil` tick 预算不足两处测试自身问题后全绿

## 进行中

（空）

## 第十四轮审查后的低危尾项（2026-09-24；第十三、十四轮的 HIGH/MEDIUM 已全部修复并验证）

第十四轮六个区的全仓扫描给出了 0 HIGH、约 14 条 MEDIUM，均已在同一轮修复（工作台列表回包归属改为按请求排队、依赖与反应区块的错误可见、评论排序补渲染队列、上传失败提示的生命周期、提交区凭据 URL 去 userinfo 并提供 `functionalUrl`、symlink/submodule README 如实描述、评审警告按 PR 作用域、原子写保权限位并 fsync、面板销毁后不再 postMessage、`+x` 分支不再变成强制推送、issue 起始流程从可清理注册中恢复、跨窗口克隆清理加所有权标记、FS 提供者拒绝写并本地化、git 树缓存过期清理等）。以下低危项**未修**，按严重度递减记录：

- [ ] **low** 工作台三个列表命令（`getRepositories`/`getMyIssues`/`getMyPullRequests`）**不回显请求标识**，所以「重载的回包先到、被替换服务器的回包后到」这一种顺序在 webview 侧无法区分（两者 identity/epoch 相同）。发送顺序（宿主实际产生的顺序）已被守卫。要彻底关闭需要宿主为这三个命令回显一个请求 id（`shared/webview/messages.ts` 契约 + `viewProvider` 回包），已由 `useAppState.instanceListReplyAttribution.test.ts` 把该边界显式钉住
- [ ] **low** symlink/submodule 版 README 的说明句目前是英文（`client.ts` 属 MCP/服务端 bundle，不得引入 `vscode`，与既有的 `directoryNotice`/`symlinkNotice`/`submoduleNotice` 同一先例）。要本地化需让 `getRepoDetail` 额外暴露 `readmeNotice`/`readmeTarget`，再由 `viewProvider` 用 `vscode.l10n.t` 组装（约 5 行 + 两个键）；`src/api/types.ts` 的 `readmeSize` 注释也应补充「非文件类型」这一情形
- [ ] **low** MCP 侧的六条描述/mock 精度问题：`get_pull_request` 把 `assets`/`attachmentsUnavailable` 说成顶层结果字段（实际在 `pullRequest` 下）、`get_issue`/`get_pr_timeline` 未记录附件标志、空仓库的任何 contents 路径都被映射成目录、分页列表仍用 `length >= LIST_ITEM_LIMIT` 判断截断（恰好 500 条会被说成不完整）、通知 mock 用 `<` 而真实服务端是 `<=`（文档描述的边界重复因此没被测到）、两条「保留评论命中」测试只用单行夹具因而非判别性
- [ ] **low** 若干可访问性/播报细节（webview 第 7–16 项）：通知队列在匹配前剪枝可能把慢回包写成不可归属页、徽标在仪表盘驻留期间不再重问、计数徽标依赖 30 s TTL 缓存、`ViewTabs` 的 `tablist` 没有对应 `tabpanel`、设置/向导的 Test-Save 结果未放进 live region、`openDashboard` 重挂载会留下不可达的 keep-alive 条目并可能重复播报、`RepoActions` 的等待态只在观察到状态迁移时武装
- [ ] **low** 401/403 提示的凭据指纹只覆盖 URL 内嵌凭据；SecretStorage 里的令牌轮换仍无法重新武装该提示（`ForgejoClientHost.notifyInvalidCredentials` 只拿到 URL，要修需改 `clientHost.ts`/`client.ts`）

## 第十轮审查后待修（2026-09-23 第十轮全仓扫描 + 独立复核）

- [ ] **low** 401/403 toast 的 URL 脱敏没有单元测试：该文件的 vscode mock 里 `window.showErrorMessage` 对宿主模块返回 `undefined`（同一对象在测试内直接调用却返回 promise），脱敏本身由 shared 的 `toPublicInstance` 测试与既有的 `redactInstanceUrl` 测试覆盖

## 第八轮审查后待修（2026-09-23；第六、七、八轮的确认项已全部修复并验证）

- [ ] **P3** 把 `shared/request` 的错误契约从「字符串消息」改成结构化错误：导出 `RequestError extends Error { status, statusText, headers, body }`，让生成的 wrapper 标注它，并让 `toApiError` 直接读 `status`/`body`，而不是用 `/Forgejo API error (\d+):/` 正则解析消息（现在 `ResponseErrorConfig` 只是类型占位、运行时抛普通 `Error`，宿主只能靠正则与消息里的 JSON 重新分类）。跨 shared + 宿主 + 错误测试的刻意改动，值得单独一批做
