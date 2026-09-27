# TODO

短期任务清单。已交付功能的完整记录见 `ROADMAP.md` 的「已完成」一节；已完成条目的细节由本文件的 git 日志保存（2026-09-23 清理并同步过两次，只保留未完成项与仍然需要的上下文）。

## 0.0.1 已发布（2026-09-26）

0.0.1 已上线：VS Code Marketplace 条目生效；Codeberg 上 `0.0.1` Release 已创建并附 `forgejo-toolkit-0.0.1.vsix`（tag `0.0.1`，`main` 与 `codeberg` 及私服镜像均已同步）；CHANGELOG 已回填 `## [0.0.1] - 2026-09-26`；README 安装段已改为 Marketplace 主入口。**Open VSX 暂不发布**（已决定）：README ×2、FAQ ×2 与 `docs/release.md` 的措辞已统一为「未发布，用 Release 页的 `.vsix`」，将来若要发布，这四处文案与 `docs/release.md` 第 5 节必须同时改。剩余：

- [ ] broker 模式：**三项残余中的两项已于 2026-09-27 验证通过，只剩一项**。已验证——（③）**崩溃后残留注册**：硬杀 dev host 后管道消失、`mcp-broker.json` 留下且 mtime 不变，按 `mcp.json` 真实方式启动 shim 时 **1 ms 内**出现 `Extension-host broker unavailable (… ENOENT …); falling back to local auto-matching`，整轮 1.9 s、退出码 0、无握手挂起、匿名只读完好，且**无需手工清理**（下次激活重新绑定并改写注册）；（②）**同 profile 双窗口**：先到窗口持有 broker，后到窗口静默让位且不写注册，shim 仍经持有者认证 4/4；**持有窗口关闭后让位窗口会自动接管（2026-09-27 实现）**：让位窗口每 5 s 读一次注册文件并检查其中记录的 pid 是否存活，持有者正常关闭（`deactivate()` 已删文件）或被强杀（文件残留、pid 已死）都会触发自己重新绑定，成功后走原路径重写注册并打印 `MCP broker listening at …`，无文件锁、无选举（`listen` 即仲裁，输的一方继续观察）；`cleanupMcpBroker()`（`deactivate()` 与关闭 `forgejoToolkit.mcpEnabled` 都会调用）清除该定时器（已 `unref`，不会拖住窗口），EACCES 等非 EADDRINUSE 失败不启动观察。行为已写入 `KNOWN_ISSUES.md`/`.zh.md`（「同一时间只有一个窗口能持有 MCP broker」），单测覆盖全部边界（含双窗口竞态：恰好一个绑定、另一个继续观察）。**2026-09-27 真实双窗口实测通过（5/5）**：杀持有窗口后让位窗口 **1,400 ms** 内自动接管（重复一次交接为 **124 ms**），注册改写为接管者的活 pid，接管后新起的 shim **无需重载、无需切换设置**即 4/4 认证；持有者健在时 20 s（4 个轮询周期）注册文件与 mtime 零变化、看门狗零日志；被杀时**已在转发的会话**在 31 ms 后以一行 info 结束、退出码 0（**不会变成匿名**），下一次启动即走新持有者。**仍未验证**：真实 VS Code 自带 MCP 客户端经用户/工作区 `mcp.json` 拉起 shim（能驱动 workbench，但驱动不了那个客户端）。同轮另修两条**只有真实启动才暴露**的缺陷：`91b7650` 把 shim 写成驱动器路径使该路径在 Windows 完全起不来（改用 `pathToFileURL` + 真正解析 specifier 的测试），以及 `mcpEnabled` 的子上下文给只读 `subscriptions` 赋值导致**扩展完全无法激活**（改用 `Object.defineProperty` + 真实 getter 形状的回归测试）

## 0.0.1 之后

- [ ] P3 `IssueAddTime` 缺 422：**上游规格本身没有这个响应**（`packages/forgejo-api/spec/swagger.v1.json` 里 `POST /repos/{owner}/{repo}/issues/{index}/times` 只声明 `200/400/403/404`），所以重新生成补不上。`client.ts` 已注释服务端实际行为；要类型层面补齐得等上游 swagger 注解，或由我们本地手写类型（决定：暂不做）
- [ ] **P2 kubb 5 迁移（已评估：不是版本升级，是重构，暂缓）**：官方 [v4 → v5 迁移指南](https://docs.kubb.dev/docs/5.x/migration) 与我们的用法有两处硬冲突：① **`@kubb/plugin-client` 被移除**（改用 `pluginAxios`/`pluginFetch`），并且 **`importPath` 被删除**、客户端改为固定 bundle 进 `.kubb/client.ts`——而我们整套请求管线（代理、超时、重试、`RequestError`、MSW mock）都建立在「生成客户端调用 `@cpf23333-forgejo-toolkit/shared/request`」之上；② 一批静默默认值变更：`adapterOas.integerType` 由 `'number'` 变 **`'bigint'`**、`output.barrel` 由 `'named'` 变 **false**（`index.ts` 桶文件消失）、`output.format`/`lint` 默认关闭、错误语义改为 `throwOnError` 默认 true + `RequestResult`。此外 `pluginOas()` → `adapter: adapterOas({…})`、`defineConfig` 改由 `kubb/config` 导入、`input: { path }` → 单值、Node ≥ 22（本机 24、CI 22 均满足）。**做法**：先在分支上做原型，重点验证能否通过 v5 的 storage/override 机制继续注入共享请求层；若不能，需评估把 `client.ts` 迁到 v5 自带客户端（及其对错误/超时/代理语义的影响）。当前 4.39.x 精确 pin 可正常工作且生成幂等，所以没有时间压力
- [x] ~~重新生成 kubb 客户端需要能跑通的环境~~ **已解决（2026-09-27）**：早先的 exit 134 / 四个插件全失败**不是**权限或 Node 版本问题，而是 **harness 注入的环境变量**（`DSH_*`、`VIPSHOME`、以及 PATH 里指向 `DSH Desktop` 的条目）让 kubb 的配置加载器读到含非法字符的路径，报 `null byte is not allowed in input in "…\DSH Desktop.exe"`。清理这些变量后本机生成成功；并且已验证 **`generate` + 格式化 + 全工作区类型检查** 幂等（0 差异）。三步已集成进脚本：`generate` 追加 `oxfmt src/generated`，`generate:safe` 追加 `pnpm -w run check`（类型检查失败时保留产物供评审，不静默恢复）
- [ ] P5 低优先级（等上游）：`vscode-tree` 内按钮（IconActionButton）的 Enter/Space 被库自身 `keydown` 的 `preventDefault` 抑制（`@vscode-elements/elements` 2.5.1 既有行为）
- [ ] 等上游版本：Forgejo v17（约 2026-10 底）的 workflow / job rerun（`forgejo#13924`，用 ≥17.0 版本闸门，并同步移除 `KNOWN_ISSUES` 对应条目）；Actions 日志 ndjson + 服务端过滤（#12820 / #12821，低优先级）
- [ ] **P4** 多窗口轮询租约：设计已交付（`docs/design/multi-window-polling-lease.md`，否决 globalState 时间戳方案，改用 `globalStorage` 下 `fs.open(path,'wx')` 原子抢占 + 10 s 心跳 / 35 s 过期，任何不确定都退化为全速轮询）。实现前需先决定：设置默认值（文中建议先默认关闭跑影子模式）、是否禁止 globalState 参与选主、单窗口是否跳过租约、是否给 `tools/ui-review` 加共享 profile 双窗口模式。**注**：broker 的窗口间自动交接（2026-09-27 交付）已用同一套「pid + 轮询 + listen 仲裁」思路解决了它的近亲问题，可作为实现时的参照
- [ ] **P2** MCP Phase 2 写工具的实现：确认模型设计已交付（`docs/design/mcp-write-tools-confirmation.md`）。**阶段 0 必须先实测**：不标 `readOnlyHint` 时 VS Code 到底弹不弹工具审批、能否被「总是允许」永久放行——若不弹，文中的阶段 1/2 必须停。首批收窄为 `create_issue_comment` + `submit_pull_review`（rerun workflow 在当前 swagger 里没有端点，等 Forgejo v17）
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

## 进行中

（空）
