# TODO

短期任务清单。已交付功能的完整记录见 `ROADMAP.md` 的「已完成」一节；已完成条目的细节由本文件的 git 日志保存（2026-09-23 清理并同步过两次，只保留未完成项与仍然需要的上下文）。

## 0.0.1 已发布（2026-09-26）

0.0.1 已上线：VS Code Marketplace 条目生效；Codeberg 上 `0.0.1` Release 已创建并附 `forgejo-toolkit-0.0.1.vsix`（tag `0.0.1`，`main` 与 `codeberg` 及私服镜像均已同步）；CHANGELOG 已回填 `## [0.0.1] - 2026-09-26`；README 安装段已改为 Marketplace 主入口。**Open VSX 暂不发布**（已决定）：README ×2、FAQ ×2 与 `docs/release.md` 的措辞已统一为「未发布，用 Release 页的 `.vsix`」，将来若要发布，这四处文案与 `docs/release.md` 第 5 节必须同时改。

- **broker 模式（已完成，仅留记录）**：三项残余已于 2026-09-27 全部验证通过——残留注册下 1 ms 降级并自愈（`falling back to local auto-matching`）、同 profile 双窗口在持有者被硬杀后 **1,400 ms** 自动接管（重复一次 **124 ms**）、VS Code 自带 MCP 客户端在真实 Agents 窗口经 `mcp.json` 启动 shim 并 `Discovered 29 tools`。细节见 `ROADMAP.md`「已完成」与 `KNOWN_ISSUES` 的 broker 条目。**本机提醒**：那个真实 profile 跑的是**早于 shim 修复**的构建（工具面 29 个），下次激活可能把已修好的 shim 写回旧写法；安装含 `pathToFileURL` 修复的构建即自愈。

## 0.0.1 之后

- [ ] P3 `IssueAddTime` 缺 422：**上游规格本身没有这个响应**（`packages/forgejo-api/spec/swagger.v1.json` 里 `POST /repos/{owner}/{repo}/issues/{index}/times` 只声明 `200/400/403/404`），所以重新生成补不上。`client.ts` 已注释服务端实际行为；要类型层面补齐得等上游 swagger 注解，或由我们本地手写类型（决定：暂不做）
- [ ] **P2 kubb 5 迁移（已评估：不是版本升级，是重构，暂缓）**：官方 [v4 → v5 迁移指南](https://docs.kubb.dev/docs/5.x/migration) 与我们的用法有两处硬冲突：① **`@kubb/plugin-client` 被移除**（改用 `pluginAxios`/`pluginFetch`），并且 **`importPath` 被删除**、客户端改为固定 bundle 进 `.kubb/client.ts`——而我们整套请求管线（代理、超时、重试、`RequestError`、MSW mock）都建立在「生成客户端调用 `@cpf23333-forgejo-toolkit/shared/request`」之上；② 一批静默默认值变更：`adapterOas.integerType` 由 `'number'` 变 **`'bigint'`**、`output.barrel` 由 `'named'` 变 **false**（`index.ts` 桶文件消失）、`output.format`/`lint` 默认关闭、错误语义改为 `throwOnError` 默认 true + `RequestResult`。此外 `pluginOas()` → `adapter: adapterOas({…})`、`defineConfig` 改由 `kubb/config` 导入、`input: { path }` → 单值、Node ≥ 22（本机 24、CI 22 均满足）。**做法**：先在分支上做原型，重点验证能否通过 v5 的 storage/override 机制继续注入共享请求层；若不能，需评估把 `client.ts` 迁到 v5 自带客户端（及其对错误/超时/代理语义的影响）。当前 4.39.x 精确 pin 可正常工作且生成幂等，所以没有时间压力
- [ ] P5 低优先级（等上游）：`vscode-tree` 内按钮（IconActionButton）的 Enter/Space 被库自身 `keydown` 的 `preventDefault` 抑制（`@vscode-elements/elements` 2.5.1 既有行为）
- [ ] 等上游版本：Forgejo v17（约 2026-10 底）的 workflow / job rerun（`forgejo#13924`，用 ≥17.0 版本闸门，并同步移除 `KNOWN_ISSUES` 对应条目）；Actions 日志 ndjson + 服务端过滤（#12820 / #12821，低优先级）
- [ ] **P4** 多窗口轮询租约：设计已交付且**全部开放问题已裁决**（`docs/design/multi-window-polling-lease.md`，§12 即决定记录）：默认值 `true`、焦点跟随领导权、选主只走 `wx` 文件（禁 `globalState`）、不做单窗口优化、不做状态栏但降级给一次性提示、「复制诊断信息」字段清单已定稿、版本探测缓存与实例配置同处。**阶段 0 已落地**（`src/lease/` + 88 个用例，未接线）；**阶段 1（影子接线）已交付**（`leaseSupervisor.ts` 接入 `extension.ts` 仅 start/dispose、轮询与提示路径零改动、+41 用例含结构性反向守卫；真机双窗口：一个 leader 每 10 s 心跳、另一个 follower、每行 `polling=unchanged`，杀掉持有者后幸存窗口 **11–13 s** 接管——比原以为要等的 35 s 过期快，因为 pid 探测短路了它）；**harness 双窗口模式已真机验证**（该文 §10.2）。**阶段 1 的真机 soak 已抓出并修掉两处缺陷**：① 加速接管的「陈旧阈值 5 s」**低于心跳周期（10 s）**，健康持有者常态被判陈旧 → 改为 **30 s = 3 × 心跳**，且加速路径**必须同时受 N 约束**（否则 K 绕过防乒乓）；② **让位守卫写反**（"自己不聚焦→保持 / 自己聚焦→让位"），在两个窗口都自报 focused 的形态下造成**每 ~17 s 换手一次**（90 s 内 12 claims / 10 yields）→ 改为「只有自己不聚焦时才让位」，并记录平台事实：同实例两窗口可能同时报 `focused=true` 且不发生 `focus-lost`，故**逐窗口焦点保真度需按平台验证**，不可信时正确降级就是**完全不换手**。**阶段 2（默认开启的正式接线）已交付**：设置 `forgejoToolkit.multiWindowLease`（默认 `true`，§2.1 双语描述逐字落地）、**只有持有者轮询与提示**（`computeMayPoll` 失败即放行：未启动/降级/非 follower/决策未定一律轮询，仅"确认健康的 follower"抑制；poller 纯增量 +69 行，0 删除）、**一次性降级提示**（两个按钮：复制诊断 / 关闭设置）、**`forgejoToolkit.copyPollingDiagnostics`**（schemaVersion 1、七组字段、硬脱敏：无 token/授权头/SecretStorage 值，也不放"token 是否存在"布尔）、`KNOWN_ISSUES`×2 条目改写为「通知轮询在窗口间协调，但版本探测与首次运行向导仍是每窗口一次」、两份 `CHANGELOG` 逐字节一致地写明**默认行为变化**。**已知休眠分支（2026-09-27，实施者逐 tick 追查并以数字断言记录在 `leasePollingGate.test.ts`）**：`follower-takeover-accelerated` 这条加速臂**在出厂常量下不可达**——它要生效只能落在「心跳已陈旧、但尚未过期」的窗口里，而该窗口的宽度 = `LEASE_EXPIRY_MS − LEASE_ACCELERATED_STALE_MS = 35 s − 30 s = 5 s`；一个已聚焦的 follower 却需要先等去抖 `H = 12.5 s` 才能发出第一个请求，再需要 `K = 3` 次未获响应（2 s 一次 tick，约 6 s）才会升级，合计 18.5 s > 5 s，租约记录总是先过期。因此实际生效的接管路径只有「文件消失」与「过期」两条，该分支是一段**保持正确、留待将来重调参数时启用**的代码（不变量 `5 s < 12.5 s + 6 s` 已被测试钉住：参数一旦重调到让它可触发，那条断言会失败并要求补一个真正跑通该路径的用例）。**本次不改常量**：H/N/K 与心跳周期都是待实测标定的参数，结论是「这条臂当前不承担兜底职责」，而不是「要把它调活」。**剩余**：① 一周影子日志用于定 H/N/K 与心跳重试/降级阈值（陈旧阈值已定 30 s）；② **§9 路线 2 的共享版本缓存尚未实现**（诊断里的 `followsInstanceConfig` 因此如实报 `false`，等它落地才为 `true`）；③ 逐窗口焦点保真度按平台验证（§12）。**注**：broker 的自动交接（已交付）是同一套「pid + 轮询 + 仲裁」思路的先行实现，可作参照。
- [ ] **P2** MCP Phase 2 写工具的实现：确认模型设计已交付（`docs/design/mcp-write-tools-confirmation.md`）。**阶段 0 的假设已由官方文档回答（2026-09-27）**：MCP 开发者指南明确「未标 `readOnlyHint` 的工具都会显示确认对话框（参数可改）」「只读工具不询问」，Language Model Tool 指南补充存在 "Always Allow"；因此不再需要把点击实测当硬门槛（文档未说明「总是允许」的有效范围，阶段 0 顺手实测一次仍值得，若实测与文档不符则以实测为准并回落到阶段 3 的宿主确认）。首批收窄为 `create_issue_comment` + `submit_pull_review`（rerun workflow 在当前 swagger 里没有端点，等 Forgejo v17）
- [ ] P5 已知代价（仅记录）：`API_REQUEST_TIMEOUT_MS`（30 s）约束的是**每一页请求**，而不是整次分页操作——`client.ts` 的分页辅助 `_fetchAllPages` 每页各发一次请求、超时按页重新计时，所以一次达到 500 条上限的分页读取在慢实例上累计可能持续数分钟（约 10 页 × 30 s）。需要整体上限的调用方必须自己传 `AbortSignal`
- [ ] 已知的平台代价（无解，仅记录）：贡献 `mcpServerDefinitionProviders` 后，VS Code 会为查询 MCP 定义而**主动激活**扩展（上游 issue microsoft/vscode#266221「MCP server 导致扩展在所有工作区、连空工作区都被激活」）。官方激活事件清单里没有 MCP 条目（`onStartupFinished` 本身是标准事件），所以既不需要也无法声明专门事件；这一条只是记录代价本身——激活事件的实际取法（已补 `onStartupFinished`）与实测数据见下方「走查与实测」

## AI / MCP 规划（2026-09-25 评审后立项）

按建议优先级排序；MCP 侧无头进程的输出文案保持英文（既有约定），webview 侧文案走 i18n 双语 JSON。

- [ ] **P2 PR 描述生成（`vscode.lm` 试点）**：创建 PR 表单加「生成描述」按钮，diff + commit 列表生成草稿填入 body。需验证 Copilot 订阅缺失时的降级路径；代码片段会发给模型供应商，加默认关闭的设置开关
- [ ] **P2 Issue 分诊建议**：按内容建议 labels/assignees（把现有 label 描述喂给模型选）
- [ ] **P2 AI 预评审（draft-only）**：PR diff 视图「AI 预评审」，意见只落成 pending review 草稿、逐条人工确认后才提交（与 Codeberg 对 LLM 自主维护的忌讳对齐）
- [ ] **P3 通知 AI 摘要**：通知列表「总结讨论」按钮，`vscode.lm` 浓缩时间线

## 走查与实测

- 走查清单在 `tools/ui-review/README.md` 的「Release walkthrough checklist」；跑 mock 走查需要 `pnpm --filter forgejo-toolkit build:extension`（不带 `--production`，否则 mock 被剥掉）。
- ①–⑧ 已于 2026-09-23 在隔离 dev host 上跑完（做法、证据与 harness 限制见该 README 与 git 日志）：delete 确认双向、通知全部已读、Actions 分页、导入损坏 JSON 均实测；④ pushurl 拦截用真实 git 仓库、⑧ MCP 入参校验与截断标记用真实实例（`tools/ui-review/src/mcpCheck.mjs`，8/8）。
- 性能与打包实测（2026-09-23，全部有可复现来源）：
  - 客户端：500 条 issue 列表 = **10 次请求**（`client.test.ts` 分页 mock 断言）；仓库内搜索上限 **200 条** + truncation 标记。
  - 渲染：500 行 issue 页 = 500 个 `.item-card`、**5,536 个元素、约 200 ms**（jsdom；`RepoIssues.renderCost.test.ts`）。这三个数字现在由该测试**锁死断言**（行数 / 元素总数 / 首末条目文本），DOM 或卡片数一变测试就失败：改动渲染结构时必须同步改测试与本节。
  - 打包（生产构建）：入口 JS 432 → **335 KB**、入口 CSS 204 → **1 KB**（codicon 不再内联 base64）、`OnboardingPanel`/`PullReviewCommentPanel` 拆成 **8 / 5 KB** 独立块、`easymde` 327 KB 懒加载 ⇒ 仪表盘首屏 636 → 约 **336 KB**。
  - 打包（ESM 去重，2026-09-27）：extension 与 mcp-server 改单份 esbuild ESM `splitting` 构建后，宿主侧产物 extension.mjs 230 KB + mcp-server.mjs 11 KB + 共享 chunk 1.33 MB ≈ **1.56 MB**（改前 extension.js 1.58 MB + mcp-server.js 1.36 MB ≈ 2.94 MB，去重 **47%**）；mcp 入口的 forbid-vscode 约束改由 metafile 遍历断言（onEnd 插件，watch 与生产构建都生效）。
  - 激活：dev host「Show Running Extensions」实测 **`cpf23333.forgejo-toolkit` = 91 ms**（同列表最低；VS Code 1.139.0 + 生产构建）。
  - 打包（入口按面拆分，2026-09-27）：dashboard / onboarding / 评论编辑器各自一份 HTML 与入口后，面板不再下载 dashboard 外壳——onboarding 474,079 → **398,830 B（−15.9%）**、评论面板 458,135 → **326,163 B（−28.8%）**、dashboard 343,758 → **335,855 B**；`webview/vite.config.ts` 增加构建期图断言（面板触达 `App.vue`/router/vue-router 或未使用的 `@vscode-elements` 模块即构建失败，已实测会触发）。
  - 打包（消息目录按语言拆分，2026-09-27）：先量后改——中英两份目录实测 **49,574 B、占三面共用 vendor chunk 的 31.3%**（同 loader/minifier 下压缩测量），于是 `en` 保持静态作为基语言与回退、`zh` 改为字面量动态导入的独立 chunk（**20,815 B / gzip 8,191 B，三个面都不预加载**）。vendor chunk 158,289 → **118,495 B** 且不再含中文文本；逐面：dashboard 339,778 → **321,398 B（−5.4%）**、评论面板 331,145 → **311,974 B（−5.8%）**、onboarding 403,890 → **336,729 B**（其中约 24 KB 属本次，其余是同一次构建里无关的 chunk 变化）。构建期断言新增「应惰性的目录不得变回静态」（已负向实测会失败），16 个测试钉住加载语义：宿主推送的语言先加载目录再发布、被取代的请求被丢弃、加载期间继续显示旧语言（绝不渲染原始 key）、加载失败保留旧语言、缓存命中不重复取。
  - 结论：**暂不虚拟化** 500 条列表——上限已封顶在 500 且界面会提示截断（见 `shared/src/limits.ts` 的 `LIST_ITEM_LIMIT`/`isListTruncated`），虚拟化的复杂度不划算，等真实 profile 出现卡顿再议。
  - MCP 可发现性：VS Code 不会仅因扩展贡献 `mcpServerDefinitionProviders` 就为取定义而激活它（dev host 实测，见 git 日志），因此 `activationEvents` 补了 `onStartupFinished`（不开 Dashboard 也会在启动时激活，实测 **90 ms**，见 `packages/forgejo-toolkit/package.json` 的 `activationEvents`）；真实环境 Chat 的「配置工具」已确认列出 `forgejo-toolkit → Forgejo: <实例名>` 与其工具 ✔。该事件已交付，仅剩「每次开窗都激活」这一平台代价，记录在「0.0.1 之后」一节。
- 新 MCP 功能走查（2026-09-25/26，全部通过）：主窗口 Copilot 会话实测——每实例各一个 server、29 个工具、3 个 prompt 模板、`get_workspace_repository` 归因正确、`get_ci_failure_summary` 对真实失败 run 返回错误上下文与日志尾部；Agents 窗口路径实测——「为 Agents 窗口复制 MCP 配置」命令的选项/警示/合并写入全过，Agent Host 新会话经 broker 认证调通 `whoami`（token 不落盘；2026-09-27 以 `node <shim>`、无实例环境变量的方式复测通过——即 `mcp.json` 真实指定的调用方式，但**不是** VS Code 自带 MCP 客户端本身）；匿名只读提示在 server 日志中可见。**Linux headless（WSL Ubuntu 26.04 + Node 22）**：全量 typecheck + 1730 测试通过（1 个 Windows 专属用例按条件跳过），期间修复 unix socket ECONNRESET 误分类与 macOS sun_path 长度风险；macOS 无独立验证环境（Codeberg 无 macOS runner）。**私服 CI（ci.yml #11+）**：验证导出测试的 mock 泄漏依赖与 `flushUntil` tick 预算不足两处测试自身问题后全绿
