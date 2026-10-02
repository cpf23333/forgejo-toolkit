# TODO

短期任务清单：只保留未完成事项与仍然需要的上下文；已交付功能见 `FEATURES.md` 的「已完成」，本文件不设已完成一节。

## 0.0.1 之后

- [ ] **计划上架 Open VSX（当前未上架）**：README ×2、FAQ ×2 与 `docs/release.md` 现在的文案是「未发布，用 Release 页的 `.vsix`」；上架时 `README.md`、`README.zh.md`、`FAQ.md`、`FAQ.zh.md` 这四处与 `docs/release.md` 第 5 节必须同时改。
- [ ] **P3 `IssueAddTime` 缺 422（已决定暂不做，等上游）**：**上游规格本身没有这个响应**（`packages/forgejo-api/spec/swagger.v1.json` 里 `POST /repos/{owner}/{repo}/issues/{index}/times` 只声明 `200/400/403/404`），所以重新生成补不上。`client.ts` 的 `addIssueTime` 上方已注释服务端实际会答 422；要类型层面补齐得等上游 swagger 注解，或由我们本地手写类型。
- [ ] **P2 kubb 5 迁移（已评估：不是版本升级，是重构，暂缓）**：官方 [v4 → v5 迁移指南](https://docs.kubb.dev/docs/5.x/migration) 与我们的用法有两处硬冲突：① **`@kubb/plugin-client` 被移除**（改用 `pluginAxios`/`pluginFetch`），并且 **`importPath` 被删除**、客户端改为固定 bundle 进 `.kubb/client.ts`——而我们整套请求管线（代理、超时、重试、`RequestError`、MSW mock）都建立在「生成客户端调用 `@cpf23333-forgejo-toolkit/shared/request`」之上；② 一批静默默认值变更：`adapterOas.integerType` 由 `'number'` 变 **`'bigint'`**、`output.barrel` 由 `'named'` 变 **false**（`index.ts` 桶文件消失）、`output.format`/`lint` 默认关闭、错误语义改为 `throwOnError` 默认 true + `RequestResult`。此外 `pluginOas()` → `adapter: adapterOas({…})`、`defineConfig` 改由 `kubb/config` 导入、`input: { path }` → 单值、Node ≥ 22（本机 24、CI 22 均满足）。**做法**：先在分支上做原型，重点验证能否通过 v5 的 storage/override 机制继续注入共享请求层；若不能，需评估把 `client.ts` 迁到 v5 自带客户端（及其对错误/超时/代理语义的影响）。当前 4.39.x 精确 pin 可正常工作且生成幂等，所以没有时间压力
- [ ] **等上游版本**：Forgejo v17（约 2026-10 底）的 workflow / job rerun（`forgejo#13924`，用 ≥17.0 版本闸门，并同步移除 `KNOWN_ISSUES` 对应条目）；Actions 日志 ndjson + 服务端过滤（#12820 / #12821，低优先级）
- [ ] **P4 多窗口轮询租约**：设计已定稿、§12 的全部开放问题已裁决（`docs/design/multi-window-polling-lease.md`，§12 即决定记录），阶段 0/1/2 与诊断均已交付（交付记录见 `FEATURES.md` 的「已完成」：设置 `forgejoToolkit.multiWindowLease`、共享版本缓存 `src/api/serverVersionCache.ts`（键 `forgejoToolkit.serverVersions`，TTL 60 s，写前重读的合并写）、窗口间租约协调与按需补探、`forgejoToolkit.copyPollingDiagnostics` 的 `versions.followsInstanceConfig=true` 与真实 `probedAt`/`stale`、非所有者窗口的读写隔离）。**仍开放**：逐窗口 / 逐平台的焦点跟随保真度，现有实测只有 **Windows 11 上同一应用的窗口激活**；欠的是一次**真实 macOS 与 Linux 桌面**上的实测——窗口激活语义、`onDidChangeWindowState` 的行为与多窗口焦点在这两个平台上都不同，而 **WSL 不能代替**，因为要问的正是真实桌面会话的窗口焦点，所以这条**等拿到这样的机器**才能动。这一段设计文档 §10.2 与 §12 末条都只列了人工实测，仓库里可用的载体是 `tools/ui-review/` 的共享 profile 双窗口模式（`dual launch|verify|logs`）；要验的是焦点跟随在多个平台上的表现（含同一平台上的**跨应用**窗口；`KNOWN_ISSUES`×2 的窗口协调条目已如实记到 Windows 11 同一应用这一步），加上 §10.2 的"真实睡眠 / 唤醒下的计时器节流"，以及"用户可感知的少一次提示"这条只能靠长时间运行积累的证据。除此之外本条目没有别的未做项。
- [ ] **Rolldown 构建迁移（工程工作，不是功能）**：把扩展宿主的打包从 esbuild 迁到 Rolldown。早先的评估结论是**可行但收益有限**（构建时间与产物体积的改善不足以抵掉迁移与验证成本），因此暂缓、未开工。它属于工程 / 构建工作，所以不进 `FEATURES.md` 的功能清单；本条是它在案的唯一记录，若重启就从这里接。
- [ ] **webview 测试跑 happy-dom（工程工作，不是功能）**：`happy-dom` 让这套测试快约 57%，但被安全原因否决——`happy-dom` 的 `NodeIterator` 在迭代中删掉节点后不再前进，而 DOMPurify 正是一边遍历一边删（原因与实测记录见 `packages/forgejo-toolkit/webview/vitest.config.mts`）。这是上游已知缺陷：[happy-dom#2310](https://github.com/capricorn86/happy-dom/issues/2310)（2026-08-23 开、至今 open，正文独立复现了同一机制与"单层嵌套看不出问题"这一点），修法（补 DOM 的 pre-removing steps）已有人实现，但 [PR#2429](https://github.com/capricorn86/happy-dom/pull/2429) 于 2026-09-23 **关闭且未合并**，而最新发布版 `20.14.5`（2026-09-12）早于它、不含修复。重启条件：升级到**确实包含该修复**的版本（或自行补齐 `NodeIterator` 语义、把 sanitize 换成基于 TreeWalker 的一遍），并且必须先用 `webview/src/utils/markdown.test.ts` 里那条「首个节点允许、危险节点在后」的载荷证明，未证明不算数。

## AI / MCP 规划（2026-09-25 评审后立项）

按建议优先级排序；MCP 侧无头进程的输出文案保持英文（既有约定），webview 侧文案走 i18n 双语 JSON。MCP 写操作工具（Phase 2）的计划与执行状态见 `docs/design/mcp-write-tools-confirmation.md`（交付记录见 `FEATURES.md` 的「已完成」「MCP Server」一节）。

- [ ] **P2 PR 描述生成（`vscode.lm` 试点）**：创建 PR 表单加「生成描述」按钮，diff + commit 列表生成草稿填入 body。需验证 Copilot 订阅缺失时的降级路径；代码片段会发给模型供应商，加默认关闭的设置开关
- [ ] **P2 Issue 分诊建议**：按内容建议 labels/assignees（把现有 label 描述喂给模型选）
- [ ] **P2 AI 预评审（draft-only）剩余决定**：实现已交付（2026-09-29，交付记录见 `FEATURES.md` 的 PR Review 一节与 `docs/design/README.md` 的状态列；设计记录 `docs/design/ai-prereview.md` 的 §13 已就地写成裁决）。**仍未做的只有设计里刻意留着的三条变体**，都等实际诉求再议：① §13.2 的「只评当前打开的这个文件」开关（现在一次运行覆盖整个 PR）；② §13.3 的「已存在待提交评审时改为拒绝」——现行行为是**追加**，代价是 AI 意见与人手写意见在服务端无法区分；③ §13.4 的「对单条意见追问/要求重写」的第二轮（现在只做"跑一次、过清单、逐条确认或丢弃"）。三条都**不是**缺陷，也都不影响已交付行为。
- [ ] **P2 AI 预评审的下一档质量（两件各自独立的大功能，不是本次改动的收尾）**：现在的最高一档是 `changed-files`（整份 diff + 变更文件在 PR head 的完整正文），但它仍然只让模型看**该 PR 自己改动过的**文件，所以「这个函数在别处怎么用、这里的约定是什么、这次改动破坏了哪个测试」这类问题它答不了。下一档有两个方向，各自都需要单独的设计与批准：① **相关文件检索**（CodeRabbit 式「上下文工程」）：按 import 图 / importer 图、同名测试文件、同目录兄弟文件在服务端挑选少量相关文件，并如实说明取了哪些、为什么取——每一份都是新的出网内容，所以必须做成「按范围逐项同意」，而不是偷偷把 `changed-files` 的边界扩大；② **agentic 读取**（Greptile v3 式）：让模型通过我们提供的工具**按需拉取**它要看的文件，这需要工具面（`vscode.lm` 的 tool calling 或 MCP 工具）、多轮循环、明确的调用上限与可预测的费用，以及一个比「一个模态框问一次」大得多的同意模型（每一轮都在往外发内容，所以每次取文件都得是可解释、可拒绝的）。两件都不是本次改动的欠缺，因此本次不实现；等实际诉求出现再立项。
- [ ] **P3 通知 AI 摘要**：通知列表「总结讨论」按钮，`vscode.lm` 浓缩时间线

## 文档 / 编辑工作

- [ ] **中文正文的引号体例（编辑工作，不是功能）**：`docs/design/**` 的决策记录里，中文行文该统一用 ASCII 双引号 `"…"` 还是 `「…」`（后者现在多用在设置项 / 命令 / 按钮名这类标识上）。实测《AI 预评审（draft-only）》（`docs/design/ai-prereview.md`）一份记录里，用 `"…"` 的有 220 行、用 `「…」` 的有 22 行。**规则必须先定下来再动手**：体例一旦选定，替换是一次跨记录的编辑动作，中途改规则等于把已改过的行再改一遍。定稿后的替换范围是 `docs/design/**` 的**全部**记录（含该记录拆分出的 `ai-prereview-investigations.md`），不是只改这一份。

## 已知的平台代价

- 贡献 `mcpServerDefinitionProviders` 后，`onStartupFinished` 是按窗口生效的激活事件，因此**每个窗口都会在启动时激活扩展**；这一代价本身无解，只作记录（测量、上游报告与正确的焦点降级都记在 `KNOWN_ISSUES`×2 的「通知轮询、版本探测与首次运行向导……」条目）。
