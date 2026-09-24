# TODO

短期任务清单。已交付功能的完整记录见 `ROADMAP.md` 的「已完成」一节；已完成条目的细节由本文件的 git 日志保存（2026-09-23 清理并同步过两次，只保留未完成项与仍然需要的上下文）。

## 发布 0.0.1（代码侧已完成，等待人工步骤）

- [ ] 推送 `main`：领先 `codeberg` / `origin`，条数以 `git rev-list --count <remote>/main..main` 为准（不写死，避免过期）
- [ ] 派发 `.forgejo/workflows/release.yml`：先勾 `dry_run` 确认输入回显与产物 **8 项**检查（其中 `.vsix` 的 `extension/changelog.md` 大小写那条是本次修好的发版阻断），再取消勾选正式创建 `v0.0.1` Release 并附上 `.vsix`
- [ ] 商店发布（需凭据）：VS Code Marketplace（publisher `cpf23333`）+ Open VSX，步骤见 `docs/release.md` 的 Checklist
- [x] MCP 激活（2026-09-24，已修 + 已复测）：dev host 实测表明 VS Code 1.139 **不会**只因为扩展贡献了 `mcpServerDefinitionProviders` 就为取定义而激活它 —— Reload 后不开 Dashboard 时，`cpf23333.forgejo-toolkit` 不在「正在运行的扩展」里（`shots/running-after-reload.png`、`shots/running3.png`），当天的 `profile/logs/<最新>/mcpGateway.log` 只有 `Initialized` 与 client disconnect（没有 forgejo server），打开 Chat 的 `#` 工具选择器也没触发激活。
  - **修法**：`activationEvents` 增加 `"onStartupFinished"`（`packages/forgejo-toolkit/package.json`）。
  - **复测（同一 dev host，未打开 Dashboard，只打开命令面板）**：`cpf23333.forgejo-toolkit 0.0.1` 出现在「正在运行的扩展」，**Activation 90 ms**（`shots/running-onstartupfinished.png`；此前通过 Dashboard 激活时是 91 ms）。代价是每次开窗都激活，实测约 90 ms，可接受。
  - **端到端确认（2026-09-24，用户在真实 VS Code 里的「配置工具」截图）**：Chat 的工具列表里出现 `forgejo-toolkit` → `Forgejo: cpf23333@<host>:3004`，并列出 `get_issue` / `get_pr_timeline` / `get_pull_request` / `get_repo` / `list_issues` / `list_notifications` / `list_pull_requests` / `search`（该列表可滚动，总数以服务端实际注册为准）。这证明「清单贡献 → 扩展被激活 → 启动 `out/mcp-server.js` → 完成握手并列出工具」整条链路正常，也间接证明**实例的 token 确实存在**（否则 provider 会返回 `[]`、列表里不会有这一组）。
  - 与本次的 `onStartupFinished` 复测（不开 Dashboard 也会在启动时激活，90 ms）合起来，MCP 工具的可发现性闭环完成。若某次名单里看不到这一组，排查顺序：实例是否有 token → MCP server 是否处于待批准状态 → 扩展是否被激活。
- [ ] 发布后回填：README 安装段与 `docs/release.md` 对齐实际发布渠道；复核 `KNOWN_ISSUES` 中与版本相关的条目

## 0.0.1 之后

- [ ] P3 `IssueAddTime` 缺 422：**上游规格本身没有这个响应**（`packages/forgejo-api/spec/swagger.v1.json` 里 `POST /repos/{owner}/{repo}/issues/{index}/times` 只声明 `200/400/403/404`），所以重新生成补不上。`client.ts` 已注释服务端实际行为；要类型层面补齐得等上游 swagger 注解，或由我们本地手写类型（决定：暂不做）
- [ ] P3 重新生成 kubb 客户端需要能跑通的环境：本机 Windows + Node 24.14.0/25.6.1 上 `kubb generate` 稳定崩溃（exit 134，V8/libuv abort，出现过 3 次，崩溃点在它已经清空输出目录之后）。已加防护 `pnpm --filter @cpf23333-forgejo-toolkit/api generate:safe`（脏树拒绝启动 + 失败自动 `git restore`）；CI 容器是 Node 22，优先在那里跑并核对 diff
- [ ] P2 `X-Total-Count` 仍不可用（共享请求层不透出响应头）：通知分页已按「只有空页才算结束」处理，但列表总数与「是否还有更多」仍无法精确展示
- [ ] P5 低优先级（等上游）：`vscode-tree` 内按钮（IconActionButton）的 Enter/Space 被库自身 `keydown` 的 `preventDefault` 抑制（`@vscode-elements/elements` 2.5.1 既有行为）
- [ ] 等上游版本：Forgejo v17（约 2026-10 底）的 workflow / job rerun（`forgejo#13924`，用 ≥17.0 版本闸门，并同步移除 `KNOWN_ISSUES` 对应条目）；Actions 日志 ndjson + 服务端过滤（#12820 / #12821，低优先级）
- [ ] 规划中的功能：MCP Phase 2 写工具（默认关 + 设置逐项开启 + 不标 `readOnlyHint`）、MCP 多实例 fan-out、`forgejoToolkit.mcpEnabled` 开关
- [ ] 已知的平台代价（无解，仅记录）：贡献 `mcpServerDefinitionProviders` 后，VS Code 会为查询 MCP 定义而**主动激活**扩展（上游 issue microsoft/vscode#266221「MCP server 导致扩展在所有工作区、连空工作区都被激活」）。官方全部激活事件清单里没有 MCP 条目，所以既不需要也无法声明专门事件；这也印证了不加 `onStartupFinished` 的决定

## 走查与实测

- 走查清单在 `tools/ui-review/README.md` 的「Release walkthrough checklist」；跑 mock 走查需要 `pnpm --filter forgejo-toolkit build:extension`（不带 `--production`，否则 mock 被剥掉）。
- ①–⑧ 已于 2026-09-23 在隔离 dev host 上跑完（做法、证据与 harness 限制见该 README 与 git 日志）：delete 确认双向、通知全部已读、Actions 分页、导入损坏 JSON 均实测；④ pushurl 拦截用真实 git 仓库、⑧ MCP 入参校验与截断标记用真实实例（`tools/ui-review/src/mcpCheck.mjs`，8/8）。
- 性能与打包实测（2026-09-23，全部有可复现来源）：
  - 客户端：500 条 issue 列表 = **10 次请求**（`client.test.ts` 分页 mock 断言）；仓库内搜索上限 **200 条** + truncation 标记。
  - 渲染：500 行 issue 页 = 500 个 `.item-card`、**5,536 个元素、约 200 ms**（jsdom；`RepoIssues.renderCost.test.ts`）。
  - 打包（生产构建）：入口 JS 432 → **335 KB**、入口 CSS 204 → **1 KB**（codicon 不再内联 base64）、`OnboardingPanel`/`PullReviewCommentPanel` 拆成 **8 / 5 KB** 独立块、`easymde` 327 KB 懒加载 ⇒ 仪表盘首屏 636 → 约 **336 KB**。
  - 激活：dev host「Show Running Extensions」实测 **`cpf23333.forgejo-toolkit` = 91 ms**（同列表最低；VS Code 1.139.0 + 生产构建）。
  - 结论：**暂不虚拟化** 500 条列表——上限已封顶在 500 且界面会提示截断（见 `shared/src/limits.ts` 的 `LIST_ITEM_LIMIT`/`isListTruncated`），虚拟化的复杂度不划算，等真实 profile 出现卡顿再议。

## 进行中

（空）
