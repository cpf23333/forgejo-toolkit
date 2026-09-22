# TODO

短期任务清单。已交付功能的完整记录见 `ROADMAP.md` 的「已完成」一节；更早的历史完成记录由本文件的 git 日志保存。

## 待开始

### 发布 0.0.1（下一个动作）

- [ ] 重建并跑完发布前走查：`pnpm --filter forgejo-toolkit build` 后按 `tools/ui-review/README.md` 的 Release walkthrough checklist 逐条过（其中 pushurl 拦截与 MCP 入参校验需要真实实例 + token，mock 环境覆盖不到）
- [ ] 打包产物核对：`pnpm --filter forgejo-toolkit package`，确认 `.vsix` 内含 `out/extension.js`、`out/mcp-server.js`、webview 资源、`l10n/` 与 `walkthrough/`（`.vscodeignore` 已排除源码与 `mcp/` 源文件）
- [ ] 发布（需你执行，构建/发布需要凭据）：VS Code Marketplace（publisher `cpf23333`）+ Open VSX，并把 `.vsix` 附到 Codeberg Release。Codeberg 那一步可用 `.forgejo/workflows/release.yml`（手动触发，`dry_run` 默认 true，先跑一次只打包；需配 `FORGEJO_TOKEN` 仓库 secret），其余步骤见 `docs/release.md`
- [ ] 发布后回填：README 安装/版本表述与 `docs/release.md` 对齐实际发布渠道；确认 `KNOWN_ISSUES` 中与版本相关的条目在发版后仍成立

### 规划中的功能

- [ ] MCP Server Phase 2 写工具（需单独批准，方案已定调）——`create_issue`、`create_comment`、`create_pull_request`、`submit_pull_review`、`merge_pull_request`、`mark_notification_read`；默认关 + 设置逐项开启 + 不标记 `readOnlyHint`（让 VS Code 逐次确认）
- [ ] MCP Server：多实例 fan-out（later refinement）——每实例一个 server 或工具加 `instance` 参数；可选 MCP prompts 预置模板（如 "review 这个 PR"），锦上添花
- [ ] MCP Server：加 `forgejoToolkit.mcpEnabled`（默认开）开关——目前只读工具面一旦有实例就无条件暴露，无法关闭
- [ ] Forgejo v17（约 2026-10 底）发布后：实现 workflow/job rerun（2026-09-17 核对上游）——上游主干已加 `POST /repos/{o}/{r}/actions/runs/{run_id}/rerun` 和 `.../jobs/{job_id}/rerun`（forgejo#13924，仅可 rerun 已完成状态的 run/job），v16.x 不含。落地时用版本闸门（≥17.0），并同步移除 KNOWN_ISSUES 里 rerun 限制条目
- [ ] Forgejo v17 发布后：Actions 日志改 ndjson + 服务端过滤（低优先级）——`GET .../jobs/{job_id}/logs` 新增 `?format=ndjson`（#12820）和 `?q=`/`?qi=` 子串过滤（#12821），可替代纯文本解析并把日志搜索下沉到服务端

### 2026-09-22 复审未修项（按优先级）

- [ ] P1 创建成功但附件上传失败时表单不清空 → 重试会产生重复 issue/PR/评论——`RepoIssues.vue` / `RepoPullRequests.vue` / `IssueDetail.vue` / `PullRequestDetail.vue` 的创建与评论流程：catch 里写了错误却没清 `isCreating`/正文/待上传附件。方向：创建成功后先关闭表单，附件上传单独 try
- [ ] P1 关闭 PR diff 编辑器后，评论面板（Comments panel）仍残留该文件的 review thread——`_onCloseDocument` 依赖 `onDidCloseTextDocument`，但虚拟文档的 close 事件未及时触发（等 20s+ 仍在）。方向：改用 `onDidChangeVisibleTextEditors`（去抖）兜底清理不可见文档的 thread
- [ ] P2 非管理员看不到保护规则：`GET /branch_protections/{name}` 是 repo-admin-only（上游 `api.go` 整组 `reqAdmin()`），403 被 `_probe` 吞掉后等同于「没有保护规则」。2026-09-22 已修掉「探测失败被当成无 push 权限而禁用合并」，剩余方向：仅在 `permissions.admin` 为真时探测，否则显式提示「保护规则未知」
- [ ] P2 静默截断：`_getRepoTree` 上限 50 页 × 100 条、`_fetchAllPages` 上限 500 条，文件搜索/列表被截断时不返回任何标记。方向：结果携带 `truncated` 标记，并按 `X-Total-Count` 推导上限
- [ ] P2 通知列表只取一页（`getNotifications` 无分页，>50 条静默丢失）
- [ ] P2 无代理支持：所有请求走全局 `fetch`，不读 `HTTP(S)_PROXY` / VS Code `http.proxy`。方向：按设置接入 undici `ProxyAgent`，或至少在文档中声明限制
- [ ] P2 PR worktree 目录名不含实例标识（`worktrees/<owner>-<repo>-pr-<n>`）：两个实例的同名仓库会共用同一路径。裸仓库缓存已按实例加后缀（2026-09-22 修复），worktree 目录尚未处理
- [ ] P2 MCP 子进程里的版本闸门是死代码（`serverVersions` 表只在扩展宿主进程填充）；工具调用也不支持取消（未把 SDK 的 signal 透传到 client）
- [ ] P3 缓存治理：`timedCache` 只在该 key 被再次读取时清理过期项（过期后不再读的条目会留到会话结束）；`mentionCache` 无上限；`resolveAttachmentImages` 的 key 未包含实例标识
- [ ] P3 提交 `pnpm-lock.yaml`（已从 `.gitignore` 移除，需人工 `git add`）——此前 lockfile 未入库，全新 clone 会解析 `^` 浮动版本，安装不可复现
- [ ] P3 `packages/forgejo-api` 的代码生成源未固定（`kubb.config.ts` 直接读 `https://codeberg.org/swagger.v1.json`）——建议 pin 到上游 tag 并记录版本；`src/generated/client|mocks` 目前无任何 value 导入，可考虑只保留 types
- [ ] P3 确认「未打开 Dashboard 时 MCP server 是否会被 VS Code 发现」——`package.json` 的 `activationEvents` 只有 view/fileSystem（+隐式 command），官方激活事件列表里没有 `onMcpServerDefinitionProvider`；若确实不会自动激活，需要补 `onStartupFinished` 或接受「首次打开 Dashboard 后才可用」
- [ ] P3 未本地化的 host 字符串：`instanceImport.ts` 的 `'Import cancelled'` / `'No valid instances found in file'`、`issueMentionProvider.ts` 的 `'Issue'` / `'Pull Request'`

### 2026-09-22 工作区改动复审新发现（四方向子代理审查）

- [ ] P2 ImportPreview 错误态把未本地化英文裸串直接渲染进 UI——`viewProvider.ts:4064` 把 `userFacingErrorMessage(error)` 放进 `error` 字段，`ImportPreview.vue:113` 原样渲染；对 `'No valid instances found in file'`（`instanceImport.ts:172`）这类裸英文 Error，中文 UI 出现英文句子。与上面 P3 未本地化项同源，但本轮改动让它从日志可见变成 UI 可见，建议随 P3 一起优先处理
- [ ] P2 `revertMergeCommit` 的 `expectedRepo` 校验仍用 fetch URL（`gitOperations.ts:637`）——`remote.<name>.pushurl` 指向**同实例另一个仓库**时，host 级 push 检查和 owner/repo 级检查都会通过，revert 会被推到错误仓库。与 2026-09-22 已修的 push token 防泄漏同源，应对 `getRemotePushUrls` 的每个 URL 做 `normalizeGitRemote` 比对
- [ ] P3 `pullReviewCommentPanel.test.ts` 的 `../../api/client` 全量工厂 mock 缺 `API_REQUEST_TIMEOUT_MS` 等导出——panel 新引入的 `resolveAttachmentImages.ts` 从该模块 import 此常量，当前测试渲染的 html 无图片、靠空集合短路恰好不触发；一旦有测试渲染含实例附件 URL 的 html，会走到 `AbortSignal.timeout(undefined)`
- [ ] P3 Actions 分页边界：`RepoActions.vue:34` 按页大小恒 30 推导下一页，服务端 `[api] MaxResponseItems` 钳到 30 以下时会重请求已加载页并重复追加（`useAppState.ts:2465` 对 page>1 无条件 append）；`actionRunTotalCount` 回退值 `?? incoming.length` 在无 total 时后续页总数缩水（`useAppState.ts:2474`）
- [ ] P3 UX 小问题：①取消删除附件的 host 确认后，编辑弹窗仍静默关闭、删除标记被丢弃且无「未删除」反馈（`IssueDetail.vue:515`、`CommentTimeline.vue:297`，PR 侧同构）；②`pullReviewCommentPanel.ts` 的 default 分支对无 `_requestId` 的 fire-and-forget 消息也记 `logger.error`，共享 composable mount 广播会刷错误日志，建议降为 debug

### 第六轮复审缓议项（2026-09-15 四方向复审已修完，以下已评估暂不动）

- [ ] P5 500 条列表全量渲染无分页/虚拟化——大仓库才感知，待性能实测后定

### 低优先级（历史遗留）

- [ ] vscode-tree 内按钮（IconActionButton）的 Enter/Space 键盘激活被库自身 keydown `preventDefault` 抑制——`@vscode-elements/elements` 2.5.1 的 pre-existing 限制（原 vscode-icon 同样如此），升级库或上游修复后复查
- [ ] onboarding 面板的 CSP 只在 HTML 重建时生效：编辑中实例 URL 已并入 `instanceUrls`，但 `http://` 实例在下一次面板重建前，markdown 预览里的实例图片仍被拦（https 实例不受影响，影响面小）。`_update()` 实际只在构造时调用，需在 `testConnection` 成功后按 origin 变化重建

### 走查方向

- 发布前走查清单见 `tools/ui-review/README.md` 的「Release walkthrough checklist」（脏 worktree 确认、四个 delete 确认、评论面板预览/提及、pushurl 拦截、通知已读、Actions 分页、导入错误、MCP 入参校验），需先 `pnpm --filter forgejo-toolkit build` 再跑 harness。
- [x] 动态端到端走查：多 remote 关联、关联仓库切换器、中文详情页、Publish 按钮新行为（创建仓库流程 + 中间态报错文案正确；推送成功路径受 insteadOf 测试环境限制未覆盖）、评论 thread 清理（见上方发现）
- [ ] `prFileSystemProvider` 大文件行为实测：contents API 对 >10 MiB 文件返回空 `content`（已确认，见 KNOWN_ISSUES），PR diff 里会显示为空，值得确认提示文案的落点
- [ ] 性能实测：激活耗时、懒加载后 bundle 实测体积（静态部分已完成并修复 P1-P4）

## 进行中

（空）
