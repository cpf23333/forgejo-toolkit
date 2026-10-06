# TODO

短期任务清单：只保留未完成事项与仍然需要的上下文；已交付功能见 `FEATURES.md` 的「已完成」，本文件不设已完成一节。

## 0.0.1 之后

- [ ] **等上游版本**：本条目收拢所有"只能等上游"的事项，按优先级排列。
  - [ ] **P1 Forgejo v17 的 workflow / job rerun**：`forgejo#13924`，用 ≥17.0 版本闸门，并同步移除 `KNOWN_ISSUES.md` / `KNOWN_ISSUES.zh.md` 里对应的 rerun 条目（`rerun_action_run` 的版本闸门也记在这里，见 `docs/design/mcp-write-tools-confirmation.md`）。
  - [ ] **P2 Actions 日志 ndjson + 服务端过滤**（`#12820` / `#12821`，低优先级）。
  - [ ] **P2 回复的原生关联（native reply linkage）**：REST API 没有任何方式表达"这条评论是在回哪一条"。钉住的 swagger 规格（`packages/forgejo-api/spec/swagger.v1.json`）里既没有 `reply` 也没有 `origin`，`CreatePullReviewComment` 只带 path / body / `old_position` / `new_position` / `extra_lines_count`；连 web 路由那个 `reply=<id>` 指的也是这条新评论要并进去的**评审**，而不是被回答的那条评论——评论模型上根本没有 reply-to 字段。所以真正的回复关系只能等上游，在那之前正文里那段引用归属行（`@作者 wrote in <评论链接>:`）是唯一的载体；平台的 `reply` 关联为什么不可用，见 `docs/design/pr-comment-replies.md` 的 §1.4。
  - [ ] **P3 `IssueAddTime` 缺 422（已决定暂不做，等上游）**：**上游规格本身没有这个响应**（`packages/forgejo-api/spec/swagger.v1.json` 里 `POST /repos/{owner}/{repo}/issues/{index}/times` 只声明 `200/400/403/404`），所以重新生成补不上。`packages/forgejo-toolkit/src/api/client.ts` 的 `addIssueTime` 上方已注释服务端实际会答 422；要类型层面补齐得等上游 swagger 注解，或由我们本地手写类型。
  - [ ] **P4 webview 测试环境切到 happy-dom（等上游）**：`packages/forgejo-toolkit/webview/vitest.config.mts` 的 `environment` **仍留在 `jsdom`**；要启用更快的 happy-dom，得等上游修掉它的 `Node.prototype.nodeName` 桩（返回 `''`，而 DOMPurify 3.4.16 在模块初始化时缓存了这个基类 getter，于是每个元素都被判为不允许并删除）——同诊断的 issue [`capricorn86/happy-dom#2182`](https://github.com/capricorn86/happy-dom/issues/2182) 与修复 PR [`#2183`](https://github.com/capricorn86/happy-dom/pull/2183)。另一处 `NodeIterator` 缺陷的修补（已在树内待命）与全部实测（48 条载荷差分、WPT 对比、26.4 s 对 57.0 s）都记在该配置文件的注释里，那才是记录的正文；真要切换还意味着随仓库携带**两处** happy-dom 修补。**重新评估的触发条件**：`#2183` 落地**且**届时载荷语料与 jsdom 的输出仍逐字节相同。
- [ ] **P4 多窗口轮询租约**：设计已定稿、§12 的全部开放问题已裁决（`docs/design/multi-window-polling-lease.md`，§12 即决定记录），阶段 0/1/2 与诊断均已交付（交付记录见 `FEATURES.md` 的「已完成」：设置 `forgejoToolkit.multiWindowLease`、共享版本缓存 `src/api/serverVersionCache.ts`（键 `forgejoToolkit.serverVersions`，TTL 60 s，写前重读的合并写）、窗口间租约协调与按需补探、`forgejoToolkit.copyPollingDiagnostics` 的 `versions.followsInstanceConfig=true` 与真实 `probedAt`/`stale`、非所有者窗口的读写隔离）。**仍开放**：逐窗口 / 逐平台的焦点跟随保真度，现有实测只有 **Windows 11 上同一应用的窗口激活**；欠的是一次**真实 macOS 与 Linux 桌面**上的实测——窗口激活语义、`onDidChangeWindowState` 的行为与多窗口焦点在这两个平台上都不同，而 **WSL 不能代替**，因为要问的正是真实桌面会话的窗口焦点，所以这条**等拿到这样的机器**才能动。这一段设计文档 §10.2 与 §12 末条都只列了人工实测，仓库里可用的载体是 `tools/ui-review/` 的共享 profile 双窗口模式（`dual launch|verify|logs`）；要验的是焦点跟随在多个平台上的表现（含同一平台上的**跨应用**窗口；`KNOWN_ISSUES`×2 的窗口协调条目已如实记到 Windows 11 同一应用这一步），加上 §10.2 的"真实睡眠 / 唤醒下的计时器节流"，以及"用户可感知的少一次提示"这条只能靠长时间运行积累的证据。除此之外本条目没有别的未做项。
- [ ] **P3 Webview 右键菜单的 VS Code 原生项（本次只做了抑制）**：维护者裁决"在仓库行上右键只弹出剪切 / 复制 / 粘贴，在那里没有意义"，所以现行做法是**临时抑制**平台那张默认编辑菜单，只留两处例外（可编辑字段、非空文本选区）。抑制的判据、两条例外各成立到哪一步、一次覆盖的五个面，以及 2026-10-06 在隔离 dev host 上对这条边界的实测，都在 `docs/architecture/README.md` 的「Webview UI」一节；面向用户的能力在 `FEATURES.md` 的「未完成」一节。**那些条目今后是新增，不是把抑制撤掉**：抑制掉的这张是**错的**菜单（三项对内容块都不成立），不是缺了东西的菜单，所以正确的做法是逐条声明 VS Code 原生项——`package.json` 的 `contributes.menus` 在 `webview/context` 段里每条给一个 `command` 与一个 `when`，`when` 里用 `webviewId` 限定到本扩展的 webview，再由被右键元素上的 `data-vscode-context`（JSON，从文档根往被点元素累积；它带的任意字段都会成为 `when` 可用的上下文，文档自己的例子是 `webviewSection`）把"光标下是哪一个条目"传出去，条目因此只出现在它真正适用的地方。**两件接口要一起处理**：① 现在的谓词不为带 `data-vscode-context` 的元素放行，所以加条目时抑制必须让位——或者把谓词收窄，或者改用 VS Code 为这件事提供的 `preventDefaultContextMenuItems`（`data-vscode-context` 的特殊键，只隐藏它自己加的那几条剪切 / 复制 / 粘贴，见 [Webview API 的 Context menus 一节](https://code.visualstudio.com/api/extension-guides/webview#context-menus)）；② 抑制已经尊重的两条例外（可编辑字段、非空选区）是新增条目**不得破坏**的东西。以下这份清单就是该文件说的 deferred inventory：
  - 仓库行（`Dashboard.vue` 的 tree item）：打开仓库、复制仓库地址、刷新。
  - PR 行（`RepoPullRequests.vue` 与仪表盘的 PR 列表）：打开 PR、复制编号或 URL、在浏览器里打开。
  - Issue 行（`RepoIssues.vue` 与仪表盘的 issue 列表）：与 PR 行同形——打开、复制编号或 URL、在浏览器里打开。
  - 通知行（`Notifications.vue`）：打开、标为已读。
  - 已保存实例行（设置页的实例列表）：编辑、复制地址、移除。
  - AI 端点行（设置页）：测试连接、编辑、复制地址。
  - AI 预评审面板的建议评论（`AiPreReviewPanel.vue`）：复制正文、在 diff 里打开该行。
  - 日志与代码文本（`ActionRunDetail.vue` 的任务日志、diff 正文）：复制。

## AI / MCP 规划（2026-09-25 评审后立项）

按建议优先级排序；MCP 侧无头进程的输出文案保持英文（既有约定），webview 侧文案走 i18n 双语 JSON。MCP 写操作工具（Phase 2）的计划与执行状态见 `docs/design/mcp-write-tools-confirmation.md`（交付记录见 `FEATURES.md` 的「已完成」「MCP Server」一节）。下面各条说的"接缝"都是同一个模型访问接缝，它的形状与两条传输写在 `docs/design/ai-model-transport.md`。

- [ ] **P2 PR 描述生成的行级 diff（唯一剩余的一项）**：功能本身已交付（2026-10-06，用户可见行为见 `FEATURES.md`，设计记录 `docs/design/ai-pr-description.md`，两份 `CHANGELOG`）。它现在按**比较端点能给的材料**起草：commit 列表（主题/正文/作者/时间）与变更文件表（路径 + 状态），以及可选的文件正文。**没做的是行级 diff**：`GET /repos/{owner}/{repo}/compare/{basehead}` 只返回 `CommitAffectedFiles`（`filename` + `status`，`docs/api-verification-checklist.md` 的 `repoCompareDiff` 条目），`additions`/`deletions` 只在 `/pulls/{index}/files` 上，而创建表单里的 PR 还没有 index，所以现在**任何范围都不发 hunk**。要做就得先裁决这一条：两个分支上各取一次文件正文、自己合成一份 diff，还是**以平台自己的输出为准**（那要另找端点或新开上游诉求）——前者送去的 diff 与平台自己显示的不一定相同，而给模型一份错的 diff 比少送内容更坏。在那之前不改同意文案里的任何承诺。
- [ ] **P2 Issue 分诊建议**：按内容建议 labels/assignees（把现有 label 描述喂给模型选）。**接缝同上**：走 `selectedModelFor(feature)`，不自己取模型
- [ ] **P2 AI 预评审（draft-only）剩余决定**：功能已交付；设计里刻意留着的三条变体不再记在这里——它们连同各自的决定与理由记在 `FEATURES.md` 的「已完成」「PR Review」一节（那里是它们唯一的记录处），只在出现实际诉求时才重新提起。本条目保留为指针；裁决正文仍是 `docs/design/ai-prereview.md` 的 §13。
- [ ] **P2 AI 预评审的下一档质量（两件各自独立的大功能，不是本次改动的收尾）**：相关文件检索与 agentic 读取这两个方向不再记在这里——它们记在 `FEATURES.md` 的「未完成」一节，各自需要独立的设计与批准。本条目保留为指针；工具调用与 agent 循环这道接缝的现状见 `docs/design/ai-model-transport.md`。
- [ ] **P3 通知 AI 摘要**：通知列表「总结讨论」按钮，`vscode.lm` 浓缩时间线。**接缝同上**：走 `selectedModelFor(feature)`，不自己取模型
