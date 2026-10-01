# AI 预评审（draft-only）

- 状态：**设计已定稿；阶段 0–4 已交付**（2026-09-29 写作，2026-09-29 实现）。§10 的四个阶段
  在同一次改动里落地，§13 的全部八个问题也已由维护者裁决并改写进下面的正文；本文只记录
  **决定了什么、为什么、否掉了什么**，仍未做的部分（要不要「只评当前文件」的开关等）记在
  `TODO.md` 的「AI 预评审（draft-only）剩余决定」条目里（设计文档只指向跟踪条目，不持有待办项的唯一副本）。
  与既有两份记录不同，本文写作时**没有**任何「已交付」段落，读到时请按"计划"而非"现状"理解；
  状态与交付记录见 `docs/design/README.md` 的索引行与 `FEATURES.md` 的 **已完成** 一节。
- 交付记录（2026-09-29）：宿主侧实现 `src/aiPreReview.ts`（命令、`vscode.lm` 调用、确认清单、
  草稿写入）、`src/aiPreReviewBrief.ts`（简报组装、提示词、锚点校验与丢弃）、
  `src/aiPreReviewSettings.ts`（两个窗口级开关，默认关闭）；命令
  `forgejoToolkit.aiPreReviewPullRequest` 挂 `editor/context` 与 `editor/title`；设置
  `forgejoToolkit.aiPreReview` 与 `forgejoToolkit.aiPreReviewIncludeDiff`。
- 交付后的修正（2026-09-29，UI 验证发现的四个缺陷，全部落在本文的裁决之内）：① 模型改为
  **按输入预算挑**，不再取 `selectChatModels()` 的第一个，指令提示词同时压缩（§7.2）——
  这是四个里唯一让功能完全跑不起来的；② `l10n` 两个 bundle 里同一处键多写了一个转义
  （`model\'s`），中文界面因此回退英文，已修并补上「bundle 的键必须在源码里原样出现」的测试
  （§9.4）；③ 运行包进一条**可取消的进度通知**，取消即走 §6.4 的取消路径（§6.2）；
  ④ 六个设置项在 `package.nls.json` / `package.nls.zh-cn.json` 里补上名称，命令标题一并纳入
  测试（§9.4；VS Code 目前仍不渲染贡献的 `title`，见 `KNOWN_ISSUES.md`）。
- 关联：`TODO.md` 的「AI / MCP 规划」一节（本功能与「PR 描述生成」是同一批 AI 功能）；
  写侧约束的先例是 [`mcp-write-tools-confirmation.md`](./mcp-write-tools-confirmation.md)
  （该文 §3.6 把 Codeberg 条款翻译成了写工具的机制）；宿主侧 AI 调用的方向由
  [`../architecture/mcp-server.md`](../architecture/mcp-server.md) 的「Security model」一节
  末段写明（"UI-facing AI features … should instead use `vscode.lm` on the host"）
- 适用范围：把模型给的意见**落成待提交评审草稿**的这条路径。不含 MCP 工具面（那条路是
  `submit_pull_review`，已在写工具设计里定稿）、不含自动提交、不含自动 approve
- 基线代码：写作时为 HEAD `5da224b`。工作树里可能有其他 agent 的在途改动，**行号会漂移**，
  所以每条断言都给**可搜索的符号名 / 标识符**；以符号名为准，行号只用于加速定位。
  核对清单见 §12

---

## 1. 问题

PR diff 视图里，人工评审的路径已经完整：行号右键 → `forgejoToolkit.addPullReviewComment` →
webview 编辑器（`pullReviewCommentPanel`）→ 写进服务端的**待提交评审**（pending review）→
用户自己按「提交评审」并选结论（评论 / 批准 / 要求修改）。

要加的是这条路的第一步的自动化：**让模型先读一遍 diff 并给出行级意见**，替人省掉"从头读一遍
大 diff"的成本。这一步有三种截然不同的做法，选哪一种决定了整份设计：

| 做法                                                 | 副作用落在哪                          | 问题                                                                      |
| ---------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| 模型直接调 `submit_pull_review`（走 MCP 写工具）     | 立即产生一条**公开**评审              | 与本项目对 Codeberg 的承诺冲突（见 §3.1），且模型的意见未经人读就公开发布 |
| 模型的意见生成一段总结文字，用户自己复制到编辑器里   | 无副作用                              | 没有行级锚点，"哪一行有问题"要靠人再找一遍，省不掉主要成本                |
| 模型的意见落成**待提交评审的草稿评论**，逐条人工确认 | 只有评审者自己可见的 draft（见 §4.2） | 需要新增一条"生成 → 校验 → 落草稿"的链路，以及提交前的逐条确认            |

**本设计选第三种。** 它的关键性质是：**提交这个动作仍然完全由既有的人工流程承担**——
扩展不新增任何"提交评审"的入口，模型的产物必须先变成一条 draft，才可能进入既有提交路径。

---

## 2. 决策（摘要）

1. **draft-only：模型永远不能提交。** 生成结果一律落成**待提交评审的草稿评论**；
   本功能不调用 `submitPullReview`，也不调用 `createPullReviewWithComment`（那是"不建草稿、
   直接提交"的单条评论路径）。提交只走既有的「提交评审」按钮与结论选择（§4.2、§5）。
2. **逐条人工确认：没有"一键接受全部"。** 模型给的每条意见都要在草稿进入待提交评审之前
   由人单独看过并确认；未确认的意见一个字都不写进实例。默认建议"全部不勾选"，
   人只勾他认可的那几条（§5）。
3. **默认关闭 + 显式开启。** 新设置 `forgejoToolkit.aiPreReview`（布尔，**默认 `false`**）：
   关闭时命令直接拒绝，且**不向模型供应商发出任何内容**（§7）。
4. **送给模型的是"预评审简报"，不是整个 diff。** 复用 `get_pr_review_brief` 的取向与预算
   （只给形状、只给被截断的正文），默认只发变更文件清单 + 每个文件增删行数 + 已有评审意见的
   元数据；~~**是否把 diff 正文本身发给供应商，是留给维护者的决定**~~ **维护者已裁决：默认不送，
   要送得打开第二个窗口级开关 `forgejoToolkit.aiPreReviewIncludeDiff`**（§7.1、§13.1）。
5. **一次只跑一个运行，且可取消。** 同一拉取请求同时只有一个运行；取消或失败时，
   已确认落下的草稿评论**保留**（它们已经是既有人工路径的产物），未确认的意见全部丢弃，
   并明确告知用户发生了什么（§6）。
6. **模型输出必须过锚点校验，过不了就丢，绝不猜。** 输出是 JSON、带 schema 校验；
   只有一行/多行、head/base 两侧、且行号确实落在该文件该侧 diff 里的意见才转成草稿，
   其余**丢弃并计数**（不挪到最近的行、不改侧、不截断字数以外的修补）（§8）。
7. **宿主侧调用 `vscode.lm`，webview 不碰模型。** 这条由
   [`../architecture/mcp-server.md`](../architecture/mcp-server.md) 的「Security model」一节
   末段已经定下，本文沿用（§9）。
8. **明确不做**：自动提交评审、未经确认就创建任何评论、开关关闭时发送任何内容、
   自动 approve / request changes、把本功能做成 MCP 工具、对模型输出做"看起来对就接受"的
   宽松解析。

---

## 3. 为什么是 draft-only

### 3.1 与 Codeberg 约束的关系

`AGENTS.md` 的「Codeberg hosting and resource usage」一节记录：Codeberg 的服务条款不欢迎
"看起来由 LLM agent 自主维护"的项目，要求保留人类维护信号；`CONTRIBUTING.md` 开头那句
"LLMs and other automated tools may be used as coding assistants, but all changes must be
reviewed and committed by human maintainers" 是同一件事的对外表述。

写工具的设计（[`mcp-write-tools-confirmation.md`](./mcp-write-tools-confirmation.md) §3.6）
已经把这条约束翻译成了机制：默认关闭 + 逐次确认 + 明确不做自动 approve/merge。本功能是
**同一个约束在评审场景下的第二次落地**，而且风险更高一层：写工具至少还有 VS Code 的逐次
审批框挡着，而"AI 预评审"如果设计成自动提交，用户的仓库里就会出现**没有经过任何人类阅读**的
公开评审记录——这正是条款要防的形状。

所以本设计不是"顺手加一层确认"，而是把**"模型的产出必须经过人"**做成本功能的地基：
模型的产物只能进入一个**只有评审者自己能看见**的中间态（§4.2），离开这个中间态的唯一出口
是既有的人工提交按钮。

### 3.2 否掉的方案

- **~~模型直接调 MCP 写工具提交评审~~**：否决。这等于把模型接进一个已发布、已有逐次审批的
  写路径，让"AI 预评审"变成"AI 评审"。即使用户在 VS Code 里点了"允许"，那也只是批准了一次
  工具调用，不是逐条读过每条意见。
- **~~生成一段 Markdown 总结填进评审正文~~**：否决。没有行级锚点，用户仍要自己在 diff 里找
  位置；而且它会把"模型的一段话"变成人评审理由的一部分，混淆了"谁说了什么"。
- **~~先把意见写到本地文件 / 剪贴板，让人贴进去~~**：否决。多了一步搬运，而草稿态本来就存在
  （§4.2），没有理由自造一个。

---

## 4. 现状的机制（本设计必须落进去的地方）

这一节是**事实核对**，不是建议。写作时逐条按符号名核过，清单见 §12。

### 4.1 起步点：PR diff 视图

- 打开一行级的 PR diff 走 `src/webview/viewProvider.ts` 的 `openPullRequestDiff`：
  它用 `_buildDiffUri` 构造两个 `forgejo-pr` scheme 的虚拟文档（base 侧与 head 侧），
  再执行 `vscode.diff`。
- 控制器 `src/comments/pullReviewCommentController.ts` 在活动编辑器变化时把上下文键
  `forgejoToolkit.inPullRequestDiff`（常量 `CONTEXT_IN_PR_DIFF`）设为
  "当前文档的 scheme 是不是 `forgejo-pr`"。
- `packages/forgejo-toolkit/package.json` 的 `contributes.menus` 里，
  `editor/context` 与 `editor/lineNumber/context` 都用这个键把关
  `forgejoToolkit.addPullReviewComment`。**新的"AI 预评审"动作应当挂同一个键**，
  这样它只在这条 diff 视图里出现，不需要新的上下文键。

### 4.2 待提交评审存在哪里（**本设计最关键的事实**）

**草稿不在本地，在服务端。** Forgejo 的模型是"评审者可以有一个 PENDING 状态的评审"，
行级评论以 `POST /repos/{owner}/{repo}/pulls/{index}/reviews/{id}/comments` 挂到它下面，
提交时才变成公开评审。仓库里的对应实现：

- 起始：`PullReviewCommentPanel._handleSubmitPullReviewComment`
  （`src/comments/pullReviewCommentPanel.ts`）。当 `mode === 'review'` 且宿主上下文里
  还没有 `pendingReviewId` 时，它调 `ForgejoClient.createPendingPullReview`
  （`src/api/client.ts`），并把返回的 `review.id` 写回**宿主自己的**上下文
  `target.context.pendingReviewId`。
- 追加：同一函数在 `pendingReviewId` 已经是数字时改调 `client.addPullReviewComment(...)`。
- 查找既有草稿：`PullReviewCommentController.addComment`
  （`src/comments/pullReviewCommentController.ts`）在 `data.reviews` 里找
  `r.review.state === 'PENDING' && r.review.user?.login === instance.username`，
  把命中的 id 作为 `pendingReviewId` 传给面板。**这条查找逻辑就是"继续评审"的全部机制**，
  没有本地草稿存储。
- 提交：`PullReviewCommentPanel._handleSubmitPullReview` 调
  `client.submitPullReview(owner, repo, index, reviewId, event, body)`；
  `event` 只接受 `APPROVED` / `REQUEST_CHANGES`，其余一律归为 `COMMENT`。
- 取消：`_handleDeletePullReview` 调 `client.deletePullReview(...)`，宿主侧先弹原生模态框
  （文案 "Cancel this pending review? All draft comments will be discarded."）。
- 信任边界：`_captureTarget` 的注释写明 **`pendingReviewId` 只来自宿主上下文，从不来自
  webview 消息**；webview 报上来的值只当一致性信号记一条日志。本设计必须沿用这条边界——
  预评审的落草稿动作全在宿主里，webview 不参与。

由此得到三条对设计的硬约束：

1. **草稿评论是服务端对象**，不是本地队列。所谓"逐条人工确认"，指的是
   **在写这条评论之前**确认——一旦写下去，它就已经是一条服务端上的 PENDING 评论了。
   所以确认步骤必须发生在写请求之前，而不是"先写草稿再让人删"。
2. **待提交评审创建时必须带正文**：`createPendingPullReview` 的注释写着
   "Pending reviews require a non-empty body even when comments are attached"，
   代码里填的是占位符 `'.'`。这意味着"先开一个空草稿、再慢慢加"这条路在当前客户端
   封装下不成立；预评审的第一条确认评论会顺带创建这个草稿（占位正文稍后由人改）。
   **这条占位正文的存在要在 UI 文案里承认**，否则用户提交时会看到一条莫名其妙的 `.`。
3. **一个人在同一拉取请求上只有一个 PENDING 评审**（Forgejo 的规则，
   `pullReviewCommentController.ts` 里"start a second one"的注释说明了这一点）。
   所以预评审**必须复用**当前的 `pendingReviewId`，不能自己开一个平行的草稿；
   这直接决定了 §6.3 的那道取舍。

### 4.3 锚点怎么表达（`path` / `position` / `original_position` / `extra_lines_count`）

- Forgejo 的行号是**1-based 的 file line number，不是 diff position**。
  `src/comments/reviewCommentPosition.ts` 的 `resolveReviewCommentLine` 说明了读侧映射：
  `position` = head（新）文件行号，`original_position` = base（旧）文件行号；
  左侧评论 `position` 为 0、右侧评论 `original_position` 为 0。
- 写侧由 `PullReviewCommentContext` 表达：`isBase` 决定填 `comment.old_position` 还是
  `comment.new_position`（`pullReviewCommentPanel.ts` 的 `_handleSubmitPullReviewComment`），
  `extraLinesCount` 填 `extra_lines_count`（多行评论：锚点在第一行，向后延伸）。
- **行号必须落在 diff 内**：`pullReviewCommentController.addComment` 用
  `parsePullDiff`（`src/utils/parseDiff.ts`）拿到该文件的 `baseLines` / `headLines`
  （`Map<0-based 行号, 'added' | 'deleted' | 'context'>`），并断言
  `sideLines.get(line)` 存在（多行时还要 `line + extraLinesCount` 存在），否则报
  "Comments can only be added to lines within the pull request diff"。
  **这正是 §8 校验器要复用的判定**：模型给的行号如果不在这张表里，就是无效锚点。

### 4.4 现在缺的那一段

缺的恰好是"**意见从哪来**"这一段：今天所有评论正文都由人在 webview 里敲。
除此之外的每一环（草稿创建、追加、提交、取消、刷新、错误提示）都已存在，
本功能**不修改**它们，只新增一个"在确认之后调用 `createPendingPullReview` /
`addPullReviewComment` 的调用方"。

---

## 5. 草稿态与逐条确认的 UX 决策

**问题**：模型的意见是批量来的，而"确认"是逐条发生的。中间需要一个可复核的清单。

**决策**：

1. 运行结束后，把模型输出经过 §8 校验留下的候选意见**一次性展示**在一个宿主侧的多选清单里
   （`vscode.window.showQuickPick` 的 `canPickMany` 形态，或等价的可多选 UI），
   每项包含 `path:line`、一侧（新/旧）、以及评论正文的前若干字符。
2. **默认不勾选任何一条。** 勾选是"我读过并认可这条"的表达；预勾选会把"确认"变成"默认同意"，
   与 §3.1 的约束直接冲突。
3. 确认后逐条写草稿：第一条走 `createPendingPullReview`（或复用既有 `pendingReviewId` 时走
   `addPullReviewComment`），其余走 `addPullReviewComment`。
4. 清单里被放弃的意见**完全不产生任何请求**；运行结束后告知"生成 N 条、采纳 M 条、丢弃 K 条
   （K 里再分：锚点无效 / 用户未勾选）"。
5. **不做"一键全部接受"**，也不做"把模型的原文当作评审正文"。理由同上：本功能存在的意义是
   让人**读**一遍，而不是让人**点**一下。

---

## 6. 运行怎么触发、边界在哪

### 6.1 触发

- 一个宿主命令，建议命名 `forgejoToolkit.aiPreReviewPullRequest`（与既有命令的命名风格一致：
  `forgejoToolkit.addPullReviewComment` / `forgejoToolkit.createPrFromCurrentBranch`），
  挂在 `editor/context` 与 `editor/title`，`when` 用既有的 `forgejoToolkit.inPullRequestDiff`。
- 命令从**活动 diff 文档的 URI** 解析出目标：`parseForgejoPrUri` 给出
  `instanceId` / `owner` / `repo` / `index` / `path` / `isBase` / `ref`。
  与 `addPullReviewComment` 的命令处理一样，**按 URI 找编辑器，回退到活动编辑器**，
  而不是盲信 `activeTextEditor`（diff 编辑器是两个）。
- **作用域决策：一次运行覆盖整个拉取请求，而不是单个文件。** 行级评审的价值有一半在
  "这个改动与那个改动是一件事"，只看一个文件会漏掉它；而且 §7 的简报本来就是按 PR 组织的。
  代价是输入更大，由 §7.2 的预算兜住。**留给维护者的变体**见 §11.2（是否要一个"只评这个文件"
  的开关）。

### 6.2 一次只跑一个

- 每个窗口维护一份"正在运行的预评审"（键 = `instanceId:owner/repo#index`），
  同一目标上的第二次触发**直接拒绝并提示已在运行**，与既有的
  `publishToForgejoInFlight` / `createPrFromCurrentBranchInFlight` 的单飞写法一致
  （`src/commands/index.ts` 里那两个模块级布尔量）。
- 运行中要能取消：`vscode.LanguageModelChat.sendRequest` 接受 `CancellationToken`，
  取消即停止消费流；窗口关闭 / 扩展 `dispose` 也视为取消。
- 取消的入口是一条 `withProgress` 的**通知式进度**（`cancellable: true`，通知是唯一会显示
  取消按钮的位置），包住"读取 PR + 调模型"这一段。进度结束（或取消）之后才弹 §5 的确认清单，
  所以从进度条上取消的运行连清单都到不了，更不会写任何东西；取消后只显示 §6.4 的那一句话。
- 不做队列、不做后台继续：预评审是"用户点了才跑、跑完就结束"的一次性动作。

### 6.3 已有待提交评审时怎么办

因为一个人在同一 PR 上只能有一个 PENDING 评审（§4.2 第 3 条），且宿主上下文里的
`pendingReviewId` 是**当前面板上下文**的属性而不是全局状态，所以必须明确一种行为。
**本设计的取舍**：

- 预评审**不自己开草稿**，它走的是与人工路径同一个"找既有 PENDING 评审"的判定
  （`state === 'PENDING' && user.login === instance.username`）；
- 如果已经存在一个待提交评审，预评审**把新评论追加进去**（走 `addPullReviewComment`）。
  这符合 Forgejo 的语义（只有一个草稿），也让"开始评审 → 继续评审"的心智模型保持成立；
- **代价要写进提示**：追加会把 AI 意见混进一份可能是人手写的草稿里，谁写的哪条在实例上
  分辨不出来（PENDING 评论没有"由 AI 生成"的标记位）。因此运行前的确认对话必须**点明**
  "将追加到既有待提交评审 #N"，让用户可以先自己去提交或取消那份草稿。
- **留给维护者的变体**见 §11.3：要不要在这种情况下**直接拒绝**，要求用户先处理掉既有草稿。

### 6.4 取消、失败、部分失败

| 情形                        | 已确认落下的草稿评论 | 未确认的意见 | 用户看到什么                                                                  |
| --------------------------- | -------------------- | ------------ | ----------------------------------------------------------------------------- |
| 用户在确认清单上点取消      | 无（还没写）         | 全部丢弃     | 一条信息：已取消，未创建任何评论                                              |
| 模型调用被取消 / 超时       | 无                   | 全部丢弃     | 一条信息：已取消；不留下半份草稿                                              |
| 模型调用报错（见 §9.3）     | 无                   | 全部丢弃     | 一条错误：原因（无模型 / 无权限 / 被限流 / 其他），以及"这不影响你的评审"     |
| 输出解析或 schema 校验失败  | 无                   | 全部丢弃     | 一条错误：模型输出无法解析，没有创建任何评论                                  |
| 确认后写第 M 条失败（HTTP） | 前 M-1 条**保留**    | 其余丢弃     | 一条错误：写明前 M-1 条已作为草稿存在，并给出失败原因；**不自动回滚已成功的** |
| 全部成功                    | 全部保留             | —            | 一条信息：N 条已加入待提交评审，请在「提交评审」时逐条复核                    |

**为什么不回滚已成功的草稿**：删除草稿评论是 `deletePullReviewComment`，它同样是一次
写请求，且删除是**不可逆**的——为了"看起来干净"而删掉用户可能已经看过并认可的内容，
比留下几条待提交评论更糟。草稿态本身没有公开副作用，留着是可接受的方向。
**注意**：这条与"Codeberg 约束"不冲突，因为 PENDING 评论不是公开记录（见 §4.2）。

### 6.5 数量与预算

- **候选意见上限 20 条/次**（在提示词里明确要求，并在校验阶段硬性截断），
  与既有工具面的预算口径一致（`get_pr_review_brief` 的 `PR_REVIEW_MAX_COMMENTS = 50` 是
  "给 agent 看的未解决评论"上限，本功能是"一次让**人**过目的清单"，20 是人的复核上限）。
- 每条评论正文长度上限按既有 `get_pr_review_brief` 的 `PR_REVIEW_MAX_COMMENT_LENGTH`
  （1024 字符）截断并注明，而不是任由模型写长篇。
- 一次运行只发**一次**模型请求（单轮，不追加对话、不给模型工具）。不做多轮追问：
  多轮会把"这是什么"的自主性交给模型，也会让 token 成本不可预测。**留给维护者的变体**见
  §11.4。

---

## 7. 送给模型供应商什么（开关默认关闭）

### 7.1 内容清单

**决策：默认只送"预评审简报"，不送 diff 正文。** 具体字段：

| 送                                                    | 不送                                       |
| ----------------------------------------------------- | ------------------------------------------ |
| 实例的**主机名之外的**仓库标识 `owner/repo`（无 URL） | 实例的 URL / 主机名（对应 §12 的脱敏先例） |
| 拉取请求标题、编号、base/head 分支名                  | 拉取请求正文全文（可能含内部链接与附件）   |
| 每个变更文件的**路径**、增删行数、状态                | **文件内容 / diff 正文**（默认不送，见下） |
| 已有评审意见的**元数据**（路径、行号、作者、状态）    | 已有评论的**正文全文**（可能含内部讨论）   |
| 提示词模板本身                                        | 参与者的邮箱、token、任何本地路径          |

**为什么默认不送 diff 正文**：这不是"省 token"，是隐私判断——diff 正文就是代码本身，
它一旦离开本机，就不受本项目的任何策略约束了。而"是否愿意把代码片段发给模型供应商"
是**用户对供应商**的关系，不是本项目能替他决定的（`TODO.md` 里 PR 描述生成那条也写着
"代码片段会发给模型供应商，加默认关闭的设置开关"，同一种判断）。

**留给维护者的一条**（§11.1）：三个选项——(a) 默认只送简报，diff 正文要第二个开关；
(b) 一个开关同时打开"送简报"与"送 diff 正文"；(c) 默认就送 diff 正文（不推荐）。
~~本文**推荐 (a)**~~ **维护者已裁决（2026-09-29）：取 (a)，第二个开关为窗口级**
（`forgejoToolkit.aiPreReviewIncludeDiff`，默认 `false`）。理由是它让"我要用这个功能"与
"我同意把代码发给供应商"成为两个可以分开回答的问题，而且 (a) 在供应商不可用/用户体验上
并不更差——只送简报也能给出"这个文件太大、请人工看"这类有价值的意见，只是不建议具体行级评论。

### 7.2 预算与截断

- 简报的组装复用 `get_pr_review_brief` 的**同一套预算常量与截断口径**
  （`PR_REVIEW_BRIEF_BUDGET`、`PR_REVIEW_DIFF_BUDGET`、`PR_REVIEW_COMMENT_BUDGET`、
  `PR_REVIEW_MAX_DIFF_FILES`、`PR_REVIEW_MAX_COMMENTS`，都在 `mcp/tools.ts`），
  并在送之前用 `LanguageModelChat.countTokens` 对 `maxInputTokens` 做一次真实核对：
  **超预算时按文件粒度丢弃并计数**，绝不静默截断到模型看到半份 diff 还以为是全部。
- 送出去的简报里要显式带上"哪些部分被截断了"，与 `get_pr_review_brief` 的 `truncatedBy`
  同一取向：模型需要知道自己看到的是不是全部。
- **模型按预算挑，不取列表第一个。** `selectChatModels()` 的返回顺序与输入预算无关，而指令
  提示词是每次运行都要付的固定成本；取第一个的实现因此在维护者的机器上"一分钟都没跑起来"
  （第一个模型的 `maxInputTokens` 小于那份固定提示词）。实现分两步：
  `affordableAiPreReviewModels()` 用**每个候选自己的** `countTokens` 量一遍指令提示词，按
  `maxInputTokens` 从大到小剔掉装不下的（量不出 token 的也剔掉，不猜）；`selectAiPreReviewModel()`
  再取第一个**能装下整个请求**的候选，若一个都装不下，就用预算最大的那个候选走上面的文件粒度
  丢弃。指令提示词本身也按"每条规则都还要在"的前提压缩过（892 → 781 字符），并有一条测试锁住
  上限，免得字句再长回去。不用 `vendor` / `family` 选择器：那等于点名一个提供者，与 §9.3 的
  "不把用户送去某个具体提供者"冲突。
- **装不下时必须报出数字，不许只说"放不下"。** 连指令都放不下（没有任何候选可用）时，提示写清
  VS Code 一共提供了几个模型、其中最大的 `maxInputTokens` 是多少，以及用户可以做什么（在模型
  选择器里换一个输入预算更大的模型，或安装并登录一个上限更高的提供者）；请求放不下时同样带上
  "需要多少 / 可用多少 / 一共几个模型 / 最大预算多少"，并点名可以关掉
  `forgejoToolkit.aiPreReviewIncludeDiff` 让请求变小。两条路径都仍然**什么都没发、什么都没建**，
  且日志里各留一行带数字的记录。注意：指令放不下时**不能**把 diff 正文开关当成解法推荐（它只让
  请求变小，不让固定指令变小），但要在提示里**点名说清它帮不上忙**——否则用户会先白试一次。

### 7.3 开关语义

- 设置键 `forgejoToolkit.aiPreReview`（布尔，默认 `false`），文案要写清三件事：
  ① 开启后会把拉取请求的元数据（以及第 (a)/(b) 选项决定的 diff 正文）发给**模型供应商**；
  ② 生成的意见只是草稿，仍要逐条确认；③ 关闭时本功能完全不出现在菜单里或不产生任何请求。
- 这是**窗口级**设置，与 `forgejoToolkit.mcpWriteTools.*` / `forgejoToolkit.mcpWriteAuditToFile`
  同一层命名与同一读取方式（§9.4 的 `mcpWriteSettings.ts` 是先例：读不到就当作关闭）。

---

## 8. 模型输出如何变成合法锚点（校验与丢弃）

**原则：绝不猜。** 解析失败的项**丢弃**，不做以下任何"修补"：挪到最近的有效行、把 head 改成
base、按文件名做模糊匹配、把多行区间截成单行、从自由文本里正则捞行号。

### 8.1 输出契约

要求模型返回**严格 JSON**（不返回 Markdown 围栏、不返回散文），形状是：

```
{ "comments": [ { "path": string, "line": number, "side": "head" | "base",
                  "extraLines": number, "body": string } ] }
```

- 先做 `JSON.parse`；失败即整次运行失败（§6.4 第 4 行），不尝试"从代码块里抠 JSON"。
- 再做逐字段校验（与 `mcp/tools.ts` 里 `pathSegmentSchema` 的取向一致：类型、范围、
  枚举全部显式检查，不信任模型给的类型）。

### 8.2 逐条校验（任何一条不过就丢这一条，并计数）

| 检查            | 判据                                                                                        | 不通过时               |
| --------------- | ------------------------------------------------------------------------------------------- | ---------------------- |
| `path` 是字符串 | 非空、不含 `..` 段、必须以 `/` 分隔且与简报里的某个文件**精确相等**（大小写敏感，不做模糊） | 丢弃                   |
| `side` 是枚举   | 只能是 `head` / `base`                                                                      | 丢弃                   |
| `line` 是整数   | `1 ≤ line`，且落在该文件该侧的**实际行数**内                                                | 丢弃                   |
| 行在 diff 内    | `parsePullDiff` 的 `sideLines.get(line - 1)` 存在（§4.3）                                   | 丢弃                   |
| `extraLines`    | 整数、`≥ 0`；`> 0` 时 `line + extraLines - 1` 也必须在该侧 diff 内                          | 丢弃（**不**截成单行） |
| `body` 非空     | `trim()` 后非空                                                                             | 丢弃                   |
| 条数            | 超过 20 条的部分直接丢弃（§6.5）                                                            | 丢弃并计数             |
| 去重            | 同一 `(path, side, line, extraLines)` 只保留第一条                                          | 丢弃并计数             |

### 8.3 校验的产物

一个纯函数（例如 `validatePreReviewComments(brief, raw)`），输入是简报里的文件表（或
`parsePullDiff` 的结果）与模型原始输出，输出是 `{ accepted, dropped: { reason, count } }`。
**它不是 vscode 相关的**，所以可以在测试里直接喂各种畸形输出——这是本功能最该被测试锁死的
一块（§9.5、§10 阶段 3）。

### 8.4 正文的处理

- 校验通过的 `body` 进入 webview/草稿之前，只做**保留原样**的处理（不注入 Markdown 结构，
  不加 @提及，不解析图片链接）；模型输出对实例来说是**不可信输入**，与 webview 消息同级。
- 正文里的 `@` / `#` 提及**不做特殊处理**：Forgejo 服务端自己会解析，本扩展不替它决定
  "这条评论要不要通知谁"。

---

## 9. `vscode.lm` 的事实与降级路径

### 9.1 引擎底线上的可用面（已核对类型定义）

- `packages/forgejo-toolkit/package.json` 的 `engines.vscode` 是 `^1.102.0`，
  依赖里 pin 的 `@types/vscode` 也是 `1.102.0`。**在这个版本的类型定义里，
  `vscode.lm` 已经在**：`index.d.ts` 有 `LanguageModelChatMessage`、
  `LanguageModelChat`、`LanguageModelChatResponse`、`LanguageModelError`、
  `LanguageModelChatRequestOptions`，以及 `selectChatModels`。
- `selectChatModels(selector?)` 返回 `Thenable<LanguageModelChat[]>`，**可以是空数组**；
  类型注释明确要求"extensions must handle these cases, esp. when no chat model exists,
  gracefully"。选择器可选 `vendor` / `family` / `version` / `id`。
- `LanguageModelChat` 上本功能要用的三个成员：`sendRequest(messages, options?, token?)`
  → `Thenable<LanguageModelChatResponse>`；`countTokens(text|message, token?)`；
  以及 `maxInputTokens`（送之前的预算核对用它）。
- `LanguageModelChatResponse` 有 `stream: AsyncIterable<…>` 与 `text: AsyncIterable<string>`；
  **是流式的**。取消方式在类型的注释里写明：cancel 用于发起请求的 token，或者直接跳出
  `for await`。本功能只关心最终文本，所以按 `text` 累加，并在取消时停止累加。
- `LanguageModelChatRequestOptions.justification` 是给用户的说明文案——**首次调用模型会弹
  一次同意框**（`sendRequest` 的注释："must _only_ called in response to a user action"）。
  本功能由命令触发，天然满足"user action"；`justification` 要写清"把变更文件清单与元数据
  发给模型以生成评审草稿"。
- **不用的**：`lm.registerTool`（本功能不给模型工具）、`lm.invokeTool`、MCP sampling
  （[`../architecture/mcp-server.md`](../architecture/mcp-server.md) 的「Security model」一节
  已写明服务端从不请求 sampling，本功能也不改这条）。

### 9.2 缺 API（VS Code 分支 / 老版本）

仓库已有先例：`src/mcpServerProvider.ts` 的 `registerMcpServerProvider` 这样读可选 API——
`const register = vscode.lm?.registerMcpServerDefinitionProvider;` 然后
`typeof register === 'function'` 才用，否则记一条 info 日志并跳过（对应测试在
`src/__tests__/mcpServerProvider.test.ts` 的 "skips registration on an editor without the
MCP definition API instead of failing activation"）。

**本设计沿用同一条**：`vscode.lm?.selectChatModels` 不可用 → 命令**不存在**（menu 的 `when`
里加一个"有模型 API"的上下文键）或点了之后给一条明确错误，**绝不抛异常、绝不静默**。
扩展激活路径不受影响。

### 9.3 有 API 但没有可用模型（未装 Copilot / 未登录 / 无订阅 / 被策略禁用）

三种情况在实现上走同一条：`selectChatModels(...)` 返回空数组（无模型），或
`sendRequest` 拒绝（`LanguageModelError` 的 `NoPermissions` / `Blocked` / `NotFound`，
或带 `cause` 的其他错误）。**决策：三种都归到"本功能不可用"，给一条人能读懂的提示，
并且已经产生的任何东西都不写。**

- 空数组 → 提示写清"没有可用的聊天模型：请在 VS Code 中安装并登录 Copilot，或在设置里
  关掉本功能"。**不推荐**把用户送去某个具体扩展页——不同 VS Code 分支的提供者不同，
  提示只描述"需要有一个 chat model 提供者"。
- `NoPermissions`（用户拒绝了同意框）→ 提示"未授权使用聊天模型"，**不重复弹同意框**
  （`sendRequest` 的注释说它只在用户动作里调；重试由用户再点一次命令完成）。
- `Blocked` / `NotFound` / 其他 → 记 `logger.error` 一行（便于诊断），给用户一条通用错误。
- **有模型、但没有任何一个能装下固定指令** → 与上面三条并列的第四种"本功能不可用"，提示按 §7.2
  写清"提供了几个模型 / 最大 `maxInputTokens` 是多少 / 可以做什么"，并且**在发第一个 HTTP 请求
  之前**就返回：这一条不取决于 PR 内容，取决于模型本身。
- **绝不降级到"用启发式规则当评审"**：没有模型就是没这个功能，不是换个方式蒙。

### 9.4 设置读取与测试面的既有形态

- 设置读取的先例是 `src/mcpWriteSettings.ts`：读不到 / 类型不对一律按"关闭"处理
  （"only an explicit `true` may enable"）。本功能的开关按同一写法。
- 宿主侧用户可见文案一律 `vscode.l10n.t(...)`，译文在
  `packages/forgejo-toolkit/l10n/bundle.l10n.json` 与 `bundle.l10n.zh-cn.json`；
  manifest 文案（设置项**名称与描述**、命令标题）在 `package.nls.json` 与 `package.nls.zh-cn.json`。
  两对文件都必须**同一次改动里补齐**。
- bundle 有一个容易静默出错的形态：键不是"随便一个字符串"，它必须与源码里传给 `l10n.t` 的
  那个字面量**逐字符相同**（含 `{}` 占位符与转义），否则查找落空、界面直接显示英文源串且
  不报任何错。交付时 `bundle.l10n*.json` 里恰好有一个键把撇号写成了 `\'`（`model\'s` 对
  `model's`），中文界面于是回退英文。现在有两道检查：`l10n.t` 的字面量键必须在 bundle 里存在，
  以及**bundle 的每个键必须在 `src/**/*.ts` 里原样出现**（后者与引号风格无关，是这次缺陷的
  直接回归测试）。
- 设置项的**名称**要写成 `"title": "%config.<key>.title%"`（`package.nls*.json` 里成对补齐），
  描述写 `description`；命令标题写 `command.<id>.title`。注意 VS Code 目前**不渲染**贡献的
  `title`：设置项标题仍由设置 ID 推导（"Forgejo Toolkit: Ai Pre Review"），见
  `KNOWN_ISSUES.md` 的「A contributed setting's name cannot be translated」——声明的意义是让
  `package.nls*.json` 这一对保持完整、并在 VS Code 支持的那天立刻生效。

### 9.5 测试怎么 mock `vscode.lm`

- 现有测试把整个 `vscode` 模块 mock 掉（`src/__tests__/extension-setup.ts` 的
  `vi.mock('vscode', () => ({ … }))`，跑在 `vitest.extension.config.mts` 的 node 环境里）。
  **这个 mock 目前没有 `lm` 字段**——所以"`vscode.lm` 不存在"这条降级路径**天然就是默认
  测试环境**，`mcpServerProvider.test.ts` 里那条测试正是显式把它设成 `undefined` 来锁住行为。
- 因此本功能的测试要分两半：
  1. **纯函数那一半**（§8.3 的校验器、§7.2 的简报组装与截断）：不需要 `vscode.lm`，
     直接喂输入断言输出。
  2. **调用那一半**：在测试里给 `vscode` 的 mock 挂一个手写的 `lm` 对象
     （`selectChatModels` 返回 `[]` / 返回一个假的 `LanguageModelChat`；
     假模型实现 `sendRequest` 返回一个 async iterable，`countTokens` 返回固定值），
     从而覆盖：空数组、拒绝（各 `LanguageModelError` 代码）、正常文本、流中途取消、
     以及"命令在开关关闭时**一次也没碰 `lm`**"。
- MSW 已经模拟了评审全流程（`src/test/mocks/handlers.ts`：创建 PENDING 评审、只接受
  pending 的评论追加、提交后清掉 pending）。**落草稿这一半应当用同一个 MSW 服务器**断言
  实际发出的请求数与请求体，而不是只断言函数被调用——这与写工具测试的口径一致
  （"用 MSW 断言请求数为 0，而不是只看返回文本"）。

---

## 10. 分阶段落地计划与风险

每一阶段独立可回滚；阶段之间不并行发布。

### 阶段 0 — 只加设置与骨架（没有任何模型调用）

- 加 `forgejoToolkit.aiPreReview`（默认 `false`）+ 双语文案（`package.nls*.json`）；
  加一个纯函数读取器（照 `mcpWriteSettings.ts` 的写法，读不到即关闭）。
- 加命令注册与菜单项，`when` 上既有的 `forgejoToolkit.inPullRequestDiff`；
  开关关闭时命令**只弹一条提示说去哪开**，不做任何网络请求（测试用 MSW 锁零请求）。
- 测试：设置项类型/默认值确实写进 `package.json`，两处 `package.nls*.json` 都有非空文案
  （照 `src/__tests__/leasePollingGuards.test.ts` 里那组"光实现不算数、必须已 contribute"
  的断言写法）。

### 阶段 1 — 简报组装（不调模型）

- 把"送什么"落成一个纯函数：输入是已经取到的 PR / 变更文件 / 评审与评论数据，
  输出是送模型的文本 + 一份**结构化的文件表**（供阶段 3 的校验器用）。
- 复用 `get_pr_review_brief` 的预算常量与截断口径；截断必须显式标注。
- 测试：脱敏（URL / 主机名不出现）、预算边界、`truncatedBy` 口径、空 PR 的行为。

### 阶段 2 — 调模型（只显示，不写任何东西）

- 接 `vscode.lm`：`selectChatModels` → `countTokens` 核对 → `sendRequest` → 累加 `text`。
- 覆盖 §9.2 / §9.3 的全部降级分支；取消路径（CancellationToken + 跳出流）也要测。
- **本阶段的验收是"能拿到一段文本"**，文本还不进实例；这样模型可用性、成本、输出质量
  都能先量一遍，而不牵扯写权限。

### 阶段 3 — 校验与确认清单（仍然不写）

- 落 §8.3 的校验器 + §5 的多选确认清单；确认之后仍然**不写**，只打印"将创建 N 条"。
- 这是本功能最该被穷举测试的一块：畸形 JSON、越界行号、base/head 混用、`extraLines`
  越界、重复锚点、超 20 条、空正文、路径含 `..`、路径不在简报里。

### 阶段 4 — 真正落草稿（写请求）

- 接 `createPendingPullReview`（或既有 `pendingReviewId` 时 `addPullReviewComment`），
  按 §6.4 的表格处理失败与部分失败。
- 测试：第一条创建草稿、后续追加、复用既有草稿、第 M 条失败时前 M-1 条保留、
  取消时零请求、**开关关闭时零请求、零模型调用**。
- 本阶段交付时同步：`TODO.md` 去掉本条目、`FEATURES.md` 记入用户可见行为、
  两份 `CHANGELOG` 记入实现、相关 README/FAQ 补一句（哪些文件要动由维护者定，见 §11）。

---

## 11. 风险

### 11.1 风险与处置

| 风险                            | 影响                                       | 处置                                                                                                      |
| ------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 用户以为是"AI 已经评审过了"     | 草稿被无脑提交，等于自主维护               | 默认不勾选；提交入口不变；文案反复写"草稿、逐条确认"（§5）                                                |
| 送出去的简报里有不该外发的内容  | 隐私事故                                   | 默认只送元数据不送 diff 正文；脱敏 URL/主机名；开关默认关闭（§7）                                         |
| 模型输出畸形、锚点乱指          | 评论文不对行，或直接被服务端拒绝           | §8 的全部校验；过不了就丢，绝不猜                                                                         |
| 追加到人手写的待提交评审        | AI 意见与人意见混在一起，无法分辨          | 运行前提示"将追加到 #N"；变体见 §11.3；PENDING 不是公开记录，风险有界（§6.3）                             |
| 部分失败留下半份草稿            | 用户以为没发生                             | §6.4 明确写出前 M-1 条保留 + 失败原因；不回滚                                                             |
| 无模型 / 无权限时的提示太笼统   | 用户以为扩展坏了                           | §9.3 分三种给提示，并指出该去装/登录什么，以及设置键在哪                                                  |
| 大 PR 超预算                    | 模型看到半份 diff 却以为完整，给出错误结论 | 按文件粒度丢弃并显式标注截断；`countTokens` 先核对（§7.2）                                                |
| 用户把"预评审"当成 MCP 工具去用 | 混淆两条写路径                             | 本功能**不是** MCP 工具，不注册进 `mcp/tools.ts`；工具面的写路径仍是 `submit_pull_review`（§11.3 的范围） |
| 模型给出"批准/要求修改"的结论   | 变成自动化决策                             | 本功能只产出**行级评论**，不产出评审结论；结论永远由人在「提交评审」里选（§2.1）                          |

---

## 12. 事实核对清单

**引用一律以符号名与标题为准**（行号会随在途改动漂移）。写作时为 HEAD `5da224b`。

| 断言                                                                                                                 | 位置（符号 / 标题）                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PR diff 打开与 `forgejo-pr` URI 的构造                                                                               | `packages/forgejo-toolkit/src/webview/viewProvider.ts` 的 `openPullRequestDiff` / `_buildDiffUri`                                                                                          |
| diff 视图的上下文键与菜单把关                                                                                        | `src/comments/pullReviewCommentController.ts` 的 `CONTEXT_IN_PR_DIFF`；`package.json` 的 `contributes.menus` 的 `editor/context` / `editor/lineNumber/context`                             |
| 单飞标记的既有写法                                                                                                   | `src/commands/index.ts` 的 `publishToForgejoInFlight` / `createPrFromCurrentBranchInFlight`                                                                                                |
| 命令按 URI 找编辑器、回退活动编辑器                                                                                  | `src/commands/index.ts` 里 `COMMAND_ADD_COMMENT` 的处理体（同文件的 `sameDocumentUri` / `toLineNumber`）                                                                                   |
| 草稿评论的创建 / 追加 / 提交 / 取消                                                                                  | `src/comments/pullReviewCommentPanel.ts` 的 `_handleSubmitPullReviewComment` / `_handleSubmitPullReview` / `_handleDeletePullReview`                                                       |
| "继续评审"如何找到既有 PENDING 评审                                                                                  | `src/comments/pullReviewCommentController.ts` 的 `addComment`（`state === 'PENDING' && user.login === instance.username`）                                                                 |
| `pendingReviewId` 只来自宿主上下文                                                                                   | 同上文件的 `_captureTarget`（注释说明 webview 上报值只当一致性信号）                                                                                                                       |
| 待提交评审必须有非空正文（占位 `.`）                                                                                 | `src/api/client.ts` 的 `createPendingPullReview`                                                                                                                                           |
| 提交 / 追加 / 删除草稿的客户端方法                                                                                   | 同上文件的 `submitPullReview` / `addPullReviewComment` / `deletePullReview` / `deletePullReviewComment`                                                                                    |
| `event` 的三种取值与 `APPROVED` 拼写                                                                                 | `src/comments/pullReviewCommentPanel.ts` 的 `_handleSubmitPullReview`；`shared/webview/messages.ts` 的 `PullReviewSubmitEvent`                                                             |
| 行号是 1-based file line，`position`/`original_position` 的侧                                                        | `src/comments/reviewCommentPosition.ts` 的 `resolveReviewCommentLine`                                                                                                                      |
| 写侧 `old_position` / `new_position` / `extra_lines_count`                                                           | `src/comments/pullReviewCommentPanel.ts` 的 `_handleSubmitPullReviewComment`                                                                                                               |
| diff 行号表与"必须落在 diff 内"的判定                                                                                | `src/utils/parseDiff.ts` 的 `parsePullDiff`；`src/comments/pullReviewCommentController.ts` 的 `addComment`                                                                                 |
| 简报的预算与截断口径（复用对象）                                                                                     | `mcp/tools.ts` 的 `PR_REVIEW_BRIEF_BUDGET` / `PR_REVIEW_DIFF_BUDGET` / `PR_REVIEW_COMMENT_BUDGET` / `PR_REVIEW_MAX_DIFF_FILES` / `PR_REVIEW_MAX_COMMENTS` / `PR_REVIEW_MAX_COMMENT_LENGTH` |
| 工具结果的两道长度上限                                                                                               | 同上文件的 `MAX_TOOL_TEXT_LENGTH` / `MAX_TOOL_RESULT_LENGTH`                                                                                                                               |
| 路径段校验的既有写法                                                                                                 | 同上文件的 `pathSegmentSchema` / `isSafePathSegment`                                                                                                                                       |
| 可选 `vscode.lm` API 的降级写法                                                                                      | `src/mcpServerProvider.ts` 的 `registerMcpServerProvider`（`vscode.lm?.registerMcpServerDefinitionProvider` + `typeof … === 'function'`）                                                  |
| 该降级路径的测试                                                                                                     | `src/__tests__/mcpServerProvider.test.ts` 的 "skips registration on an editor without the MCP definition API instead of failing activation"                                                |
| `vscode` 的整模块 mock（当前没有 `lm` 字段）                                                                         | `src/__tests__/extension-setup.ts`（`vi.mock('vscode', …)`）、`vitest.extension.config.mts`                                                                                                |
| 设置读取"读不到即关闭"的先例                                                                                         | `src/mcpWriteSettings.ts` 的 `enabledMcpWriteTools` / `isMcpWriteAuditToFileEnabled`                                                                                                       |
| 设置项 / manifest 文案的双语要求                                                                                     | `package.json` 的 `contributes.configuration`；`package.nls.json` 与 `package.nls.zh-cn.json`                                                                                              |
| 宿主文案的 l10n 两文件                                                                                               | `packages/forgejo-toolkit/l10n/bundle.l10n.json` 与 `bundle.l10n.zh-cn.json`                                                                                                               |
| i18n 平价测试（键、占位符、可达性）                                                                                  | `src/webview/__tests__/i18nParity.test.ts`                                                                                                                                                 |
| "设置项必须已 contribute"的断言写法                                                                                  | `src/__tests__/leasePollingGuards.test.ts`                                                                                                                                                 |
| 评审全流程的 MSW mock（pending 语义）                                                                                | `src/test/mocks/handlers.ts`（`pendingReview` 的创建 / 追加 / 提交 / 删除）                                                                                                                |
| `vscode.lm` 的类型面（`selectChatModels` / `sendRequest` / `countTokens` / `maxInputTokens` / `LanguageModelError`） | `@types/vscode` 1.102.0 的 `index.d.ts`（`LanguageModelChat` / `LanguageModelChatMessage` / `LanguageModelChatResponse` / `namespace lm`）                                                 |
| 引擎底线                                                                                                             | `packages/forgejo-toolkit/package.json` 的 `engines.vscode`                                                                                                                                |
| 宿主侧用 `vscode.lm` 而不是 MCP sampling 的方向                                                                      | [`../architecture/mcp-server.md`](../architecture/mcp-server.md) 的「Security model」一节末段                                                                                              |
| Codeberg 约束与"人类维护信号"                                                                                        | `AGENTS.md` 的「Codeberg hosting and resource usage」一节、`CONTRIBUTING.md` 开头                                                                                                          |
| 写侧先例（默认关闭 + 逐次确认 + 不做自动 approve）                                                                   | [`mcp-write-tools-confirmation.md`](./mcp-write-tools-confirmation.md)（其 §3.6 即该先例）                                                                                                 |
| "代码会发给模型供应商、加默认关闭开关"的既有判断                                                                     | `TODO.md` 的「PR 描述生成」条目                                                                                                                                                            |

---

## 13. 留给维护者的决定

**这一节的问题只有维护者能回答；本节之外的内容是我按仓库既有取向定下的决定**（写在各节里，
并在 §2 汇总）。每条都给了我的建议与理由，供裁决时参考。**维护者已于 2026-09-29 逐条裁决**，
结论就地写在每条里；实现与交付记录见本文开头的「交付记录」与 `docs/design/README.md` 的索引行。

1. **送给模型供应商的内容边界**（§7.1）。三个选项：
   (a) 默认只送"简报"（文件路径、增删行数、已有意见的元数据），diff 正文要第二个开关；
   (b) 一个开关同时打开简报与 diff 正文；(c) 默认就送 diff 正文。
   ~~**建议 (a)**~~ **裁决：取 (a)，第二个开关为窗口级**（`forgejoToolkit.aiPreReviewIncludeDiff`，
   默认 `false`）——本项目现有设置全是窗口级，不开按实例的先例。理由见 §7.1。
2. **运行作用域**（§6.1）：一次运行覆盖**整个拉取请求**，还是允许"只评当前打开的这个文件"？
   **裁决：首版只做整个 PR**（行级评审的价值一半在跨文件）；"只评这个文件"不作承诺，
   有实际诉求时再议。
3. **已有待提交评审时的行为**（§6.3）：**追加**进既有草稿，还是**拒绝**并要求用户先提交或
   取消既有草稿？**裁决：追加**（符合 Forgejo 只有一个草稿的语义，也不打断用户流程）。
   代价照旧记在 §6.3：AI 意见与人手写意见在服务端无法区分，运行前的提示必须点明
   "将追加到既有待提交评审 #N"。
4. **是否允许第二轮**（§6.5）：模型给出意见后，用户能不能就某条意见追问/要求重写？
   **裁决：不做**：多轮会把"这是什么"的自主性交给模型，也让成本不可预测；首版只做
   "跑一次、过清单、逐条确认或丢弃"。
5. **输入是否包含 PR / issue 的讨论正文**（§7.1 表中"不送"的那一列）：
   **裁决：不送**，只送已有评论的元数据（路径、行号、作者、评审状态）——本轮不为此另开开关。
6. **命令的命名与入口位置**（§6.1）：**裁决：取 `forgejoToolkit.aiPreReviewPullRequest`**，
   同时挂 `editor/context` 与 `editor/title`，`when` 用既有的 `forgejoToolkit.inPullRequestDiff`。
   命名一旦发布就是对外契约，本轮定稿。
7. **本次改动是否要附带一个 changeset**：**裁决：设计记录本身不补**（写作时它不改任何用户可见
   行为，也已随记录一起落地）；**这次实现是用户可见的，因此带自己的 changeset**。
8. **文档同步要动哪些文件**（阶段 4 交付时）：**裁决**：`FEATURES.md`（一条能力）、
   `TODO.md`（本条目移出、只留未做的部分）、两份 `CHANGELOG`（字节一致）、本记录与
   `docs/design/README.md` 的状态列。README / FAQ 本轮不动。
