# TODO

短期任务清单：只保留未完成事项与仍然需要的上下文；已交付功能见 `FEATURES.md` 的「已完成」，本文件不设已完成一节。

## 0.0.1 之后

- [ ] **Open VSX 暂不发布（已决定）**：README ×2、FAQ ×2 与 `docs/release.md` 的措辞已统一为「未发布，用 Release 页的 `.vsix`」；将来若要发布，这四处文案与 `docs/release.md` 第 5 节必须同时改。
- [ ] **P3 `IssueAddTime` 缺 422**：**上游规格本身没有这个响应**（`packages/forgejo-api/spec/swagger.v1.json` 里 `POST /repos/{owner}/{repo}/issues/{index}/times` 只声明 `200/400/403/404`），所以重新生成补不上。`client.ts` 已注释服务端实际行为；要类型层面补齐得等上游 swagger 注解，或由我们本地手写类型（决定：暂不做）
- [ ] **P2 kubb 5 迁移（已评估：不是版本升级，是重构，暂缓）**：官方 [v4 → v5 迁移指南](https://docs.kubb.dev/docs/5.x/migration) 与我们的用法有两处硬冲突：① **`@kubb/plugin-client` 被移除**（改用 `pluginAxios`/`pluginFetch`），并且 **`importPath` 被删除**、客户端改为固定 bundle 进 `.kubb/client.ts`——而我们整套请求管线（代理、超时、重试、`RequestError`、MSW mock）都建立在「生成客户端调用 `@cpf23333-forgejo-toolkit/shared/request`」之上；② 一批静默默认值变更：`adapterOas.integerType` 由 `'number'` 变 **`'bigint'`**、`output.barrel` 由 `'named'` 变 **false**（`index.ts` 桶文件消失）、`output.format`/`lint` 默认关闭、错误语义改为 `throwOnError` 默认 true + `RequestResult`。此外 `pluginOas()` → `adapter: adapterOas({…})`、`defineConfig` 改由 `kubb/config` 导入、`input: { path }` → 单值、Node ≥ 22（本机 24、CI 22 均满足）。**做法**：先在分支上做原型，重点验证能否通过 v5 的 storage/override 机制继续注入共享请求层；若不能，需评估把 `client.ts` 迁到 v5 自带客户端（及其对错误/超时/代理语义的影响）。当前 4.39.x 精确 pin 可正常工作且生成幂等，所以没有时间压力
- [ ] **P5 低优先级（等上游）**：`vscode-tree` 内按钮（IconActionButton）的 Enter/Space 被库自身 `keydown` 的 `preventDefault` 抑制（`@vscode-elements/elements` 2.5.1 既有行为）——仓库已用捕获阶段监听绕开（`webview/src/utils/treeRowActivation.ts`，Dashboard / 全局搜索 / 通知三个视图与文件浏览器的「再显示」行已接线并有测试）；**仅剩**未接入该监听的树行里的嵌套控件仍无法用键盘激活，作为平台限制记在 `KNOWN_ISSUES`×2。
- [ ] **等上游版本**：Forgejo v17（约 2026-10 底）的 workflow / job rerun（`forgejo#13924`，用 ≥17.0 版本闸门，并同步移除 `KNOWN_ISSUES` 对应条目）；Actions 日志 ndjson + 服务端过滤（#12820 / #12821，低优先级）
- [ ] **P4 多窗口轮询租约**：设计已定稿、§12 的全部开放问题已裁决（`docs/design/multi-window-polling-lease.md`，§12 即决定记录），阶段 0/1/2 均已交付（交付记录见 `FEATURES.md` 的「已完成」）。**§9 路线 2 已落地**：共享版本缓存 `src/api/serverVersionCache.ts`，键 `forgejoToolkit.serverVersions`（与实例列表并列）、TTL 60 s、写前重读的合并写，诊断里的 `versions.followsInstanceConfig` 已为 `true`（`probedAt`/`stale` 为真实值）。**仍开放**：① 逐窗口焦点保真度仍需按平台验证（§12 末条）。**已落地（2026-09-27）**：§9 路线 1 的跨窗口半边与路线 2 的两个未决后果——同槽位单飞标记（`#inflight`，45 s TTL / 10 s 等待上限，fail-open）、提示归探测者（`#notices`，同版本只提示一次）、受闸门调用点按需补探（9 个 Actions 方法，仍无后台定时器）；唯一残留"同一瞬间抢标记的两个窗口可能各探一次"已如实记入 `KNOWN_ISSUES`×2。**已决定并落地（2026-09-28）**：`follower-takeover-accelerated` 加速接管臂**改为按它自己的陈旧阈值释放**（`LEASE_ACCELERATED_STALE_MS`），不再沿用 35 s 的过期判断——2026-09-28 的真机实测证明按旧释放规则这条臂**能发火、拿不下租约**（claim 会在下一个 2 s tick 打出，随后 `release-stale outcome=not-owner`、`wx` 得 `contended`，真正的接管要等到过期路径；完整日志形状与结构性根因见设计文档 §11.2）。实现是 `LeaseClaimPlan.staleRelease` → `releaseStale` 的"身份 + 重读年龄"两道复核。**代价（也正是要买的东西）**：心跳已静默的"活着但沉默"的现任现在可以被加速接管顶掉；**接管时刻已按改动后的代码真机复测**（2026-09-28：同一个"活着但沉默"的场景在心跳年龄 31.1 s / 32.8 s 完成接管，见设计文档 §11.2 的复测条目），旧规则下那组数字随之作废。**已关闭的一处后果**：原先探测只在激活 / 保存 / 连接测试时发生，"TTL 一过闸门长期放行"；现在受闸门保护的调用点会在评估前按需补探（仍无周期定时器）。**门槛改写**：一周影子日志这条门槛**已被设计放弃**（§11.2：本扩展没有遥测，用户侧数据不会自己回来，证据改为我们自己的发布前压测加用户报障时的主动取证）；阶段 3 因此是「发布后调参或回退」，回退路径只有一行——改默认值，或退回更长的 H/N 并关掉加速降级。**三处从未实现、且已于 2026-09-28 决定不做**：① 查询命令 `forgejoToolkit.showPollingLeader`——`forgejoToolkit.copyPollingDiagnostics` 已经把「谁在轮询、最近一次交接的原因与耗时」打印到输出通道，再开一条命令只是同一个入口的重复实现（§7.1）；② 强制接管命令 `forgejoToolkit.forcePollingLeadership`——逃逸阀是关掉 `forgejoToolkit.multiWindowLease`（关掉后每个窗口各自轮询、各自提示），而手工接管会把**人的**仲裁引入一个刻意做成文件与 pid 裁决的选举（§7.2）；③ 「轮询饥饿看门狗」——饥饿要求每个窗口都成为「活着却沉默的持有者」的确认 follower，而这种形状已由 35 s 过期与加速接管臂（在已有 K 连串时）覆盖，另加一个定时器只会多一种失效方式（§8.1.3）。三条在代码里都不存在（`package.json` 的 `contributes.commands` 与 `src/**` 均无引用；`src/lease/**` 里没有看门狗的常量、代码或用例），理由已就地写进设计文档的对应小节。§9 的首次运行向导单飞（原先同样标注为可选的扩展项）则**已交付**，见 `FEATURES.md` 的「已完成」。
- [ ] **P2** MCP Phase 2 写工具的实现：确认模型设计已交付（`docs/design/mcp-write-tools-confirmation.md`）。**阶段 0 的假设已由官方文档回答（2026-09-27）**：MCP 开发者指南明确「未标 `readOnlyHint` 的工具都会显示确认对话框（参数可改）」「只读工具不询问」，Language Model Tool 指南补充存在 "Always Allow"；因此不再需要把点击实测当硬门槛（文档未说明「总是允许」的有效范围，阶段 0 顺手实测一次仍值得，若实测与文档不符则以实测为准并回落到阶段 3 的宿主确认）。首批收窄为 `create_issue_comment` + `submit_pull_review`（rerun workflow 在当前 swagger 里没有端点，等 Forgejo v17）
- [ ] **Rolldown 构建迁移（工程工作，不是功能）**：把扩展宿主的打包从 esbuild 迁到 Rolldown。早先的评估结论是**可行但收益有限**（构建时间与产物体积的改善不足以抵掉迁移与验证成本），因此暂缓、未开工。它属于工程 / 构建工作，所以不进 `FEATURES.md` 的功能清单；本条是它在案的唯一记录，若重启就从这里接。
- [ ] **webview 测试跑 happy-dom（工程工作，不是功能）**：`happy-dom` 让这套测试快约 57%，但被安全原因否决——`happy-dom` 的 `NodeIterator` 在迭代中删掉节点后不再前进，而 DOMPurify 正是一边遍历一边删（原因与实测记录见 `packages/forgejo-toolkit/webview/vitest.config.mts`）。这是上游已知缺陷：[happy-dom#2310](https://github.com/capricorn86/happy-dom/issues/2310)（2026-08-23 开、至今 open，正文独立复现了同一机制与"单层嵌套看不出问题"这一点），修法（补 DOM 的 pre-removing steps）已有人实现，但 [PR#2429](https://github.com/capricorn86/happy-dom/pull/2429) 于 2026-09-23 **关闭且未合并**，而最新发布版 `20.14.5`（2026-09-12）早于它、不含修复。重启条件：升级到**确实包含该修复**的版本（或自行补齐 `NodeIterator` 语义、把 sanitize 换成基于 TreeWalker 的一遍），并且必须先用 `webview/src/utils/markdown.test.ts` 里那条「首个节点允许、危险节点在后」的载荷证明，未证明不算数。

## AI / MCP 规划（2026-09-25 评审后立项）

按建议优先级排序；MCP 侧无头进程的输出文案保持英文（既有约定），webview 侧文案走 i18n 双语 JSON。MCP 写操作工具（Phase 2）的计划与执行状态见上一节的 P2 条目。

- [ ] **P2 PR 描述生成（`vscode.lm` 试点）**：创建 PR 表单加「生成描述」按钮，diff + commit 列表生成草稿填入 body。需验证 Copilot 订阅缺失时的降级路径；代码片段会发给模型供应商，加默认关闭的设置开关
- [ ] **P2 Issue 分诊建议**：按内容建议 labels/assignees（把现有 label 描述喂给模型选）
- [ ] **P2 AI 预评审（draft-only）**：PR diff 视图「AI 预评审」，意见只落成 pending review 草稿、逐条人工确认后才提交（与 Codeberg 对 LLM 自主维护的忌讳对齐）
- [ ] **P3 通知 AI 摘要**：通知列表「总结讨论」按钮，`vscode.lm` 浓缩时间线

## 已知的平台代价

- 贡献 `mcpServerDefinitionProviders` 后，`onStartupFinished` 是按窗口生效的激活事件，因此**每个窗口都会在启动时激活扩展**；这一代价本身无解，只作记录（测量、上游报告与正确的焦点降级都记在 `KNOWN_ISSUES`×2 的「通知轮询、版本探测与首次运行向导……」条目）。
