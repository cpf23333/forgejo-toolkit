# TODO

短期任务清单。已交付功能的完整记录见 `ROADMAP.md` 的「已完成」一节；已完成条目的细节由本文件的 git 日志保存（2026-09-23 清理过一次，只保留未完成项与仍然需要的上下文）。

## 发布 0.0.1（代码侧已完成，等待人工步骤）

- [ ] 推送 `main`：本地领先 `codeberg` / `origin` 各 13 个提交
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

- [ ] P2 `_fetchAllPages` 截断标记：issue / PR / commit / 评论 / 分支 / 标签 / Release / 仓库等 18 个调用点的 500 条上限没有任何提示（仓库内文件搜索已改为 `{ files, truncated }`）。需要逐消息契约改 client → host → webview → MCP；`X-Total-Count` 仍不可用（请求层不透出响应头）。当前限制与规避方法见 `KNOWN_ISSUES`
- [ ] P2 代理支持：请求走全局 `fetch`，不读 `HTTP(S)_PROXY` / VS Code `http.proxy`。方向：按设置接入 undici `ProxyAgent`——需要新增依赖，且代理行为无法在 CI 覆盖；当前限制见 `KNOWN_ISSUES`
- [ ] P2 MCP 工具调用取消：未把 SDK 的 `extra.signal` 透传到 client，需要给请求链加 `AbortSignal` 透传并按工具取舍
- [ ] P3 `packages/forgejo-api` 规格源固定：`kubb.config.ts` 仍直接读上游 swagger（生成器包已钉到 `4.39.2`），建议 pin 到上游 tag 并记录版本；`src/generated/client|mocks` 目前无 value 导入，可考虑只保留 types
- [ ] P3 通知分页的边界：服务端把 `[api] MaxResponseItems` 调到 50 以下时，短页会被提前判定为结束（总数只在响应头里，生成的 client 不透出）
- [ ] P3 确认「未打开 Dashboard 时 MCP server 是否会被 VS Code 发现」：文档结论是贡献该扩展点的扩展会被自动激活（故暂不加 `onStartupFinished`，避免每次开窗都激活）。发版走查时用全新窗口确认 Chat 的工具选择器能看到 forgejo 工具，看不到再补
- [ ] 走查补充：`prFileSystemProvider` 对 >10 MiB 文件在 PR diff 里的文案落点（contents API 返回空 `content`，见 `KNOWN_ISSUES`）；性能实测（激活耗时、懒加载后体积）
- [ ] 缓议 P5：500 条列表全量渲染、无虚拟化，待性能实测后决定
- [ ] 低优先级（等上游）：`vscode-tree` 内按钮（IconActionButton）的 Enter/Space 被库自身 `keydown` 的 `preventDefault` 抑制（`@vscode-elements/elements` 2.5.1 既有行为）
- [ ] 低优先级：onboarding 面板的 CSP 只在 HTML 重建时生效——`http://` 实例的 markdown 图片在下一次面板重建前仍被拦（https 实例不受影响），需在 `testConnection` 成功后按 origin 变化重建
- [ ] 规划中的功能：MCP Phase 2 写工具（默认关 + 设置逐项开启 + 不标 `readOnlyHint`）、MCP 多实例 fan-out、`forgejoToolkit.mcpEnabled` 开关
- [ ] 等上游版本：Forgejo v17（约 2026-10 底）的 workflow / job rerun（`forgejo#13924`，用 ≥17.0 版本闸门，并同步移除 `KNOWN_ISSUES` 对应条目）；Actions 日志 ndjson + 服务端过滤（#12820 / #12821，低优先级）

## 走查

- 清单在 `tools/ui-review/README.md` 的「Release walkthrough checklist」；跑 mock 走查要用 `pnpm --filter forgejo-toolkit build:extension`（不带 `--production`，否则 mock 被剥掉）。
- ①–⑧ 已于 2026-09-23 在隔离 dev host 上跑完（做法、证据与 harness 限制见该 README 与 git 日志）：delete 确认双向、通知全部已读、Actions 分页、导入损坏 JSON 均实测；④ pushurl 拦截用真实 git 仓库、⑧ MCP 入参校验与截断标记用真实实例（`tools/ui-review/src/mcpCheck.mjs`，8/8）。
- 仍需在真实环境补做：`prFileSystemProvider` 大文件文案、性能实测（见上）。

## 进行中

（空）
