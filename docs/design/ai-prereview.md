# AI 预评审（draft-only）

- 状态：**设计已定稿；已交付**。本文是**现行契约**：只写今天成立的决定与理由，以及决定当时否掉了
  什么。按日期排列的交付、排查与验收原文——包括被推翻的取舍与被取代的文字（删除线保留）——在
  [`ai-prereview-investigations.md`](./ai-prereview-investigations.md)；下面凡写「记录」处都指该文件。

- 适用范围：把模型给的意见**落成待提交评审草稿**的这条路径。不含 MCP 工具面（那条路是
  `submit_pull_review`，已在写工具设计里定稿）、不含自动提交、不含自动 approve、不产出评审结论。

- 关联：`TODO.md` 的「AI / MCP 规划」一节（本功能与「PR 描述生成」是同一批 AI 功能）；
  写侧约束的先例是 [`mcp-write-tools-confirmation.md`](./mcp-write-tools-confirmation.md)
  （该文 §3.6 把 Codeberg 条款翻译成了写工具的机制）；宿主侧 AI 调用的方向由
  [`../architecture/mcp-server.md`](../architecture/mcp-server.md) 的「Security model」一节
  末段写明（"UI-facing AI features … should instead use `vscode.lm` on the host"）。

- 基线代码：写作时为 HEAD `5da224b`，此后的每次修正都落在本记录的对应小节里。工作树里可能有其他
  agent 的在途改动，**行号会漂移**，所以每条断言都给**可搜索的符号名 / 标识符**；以符号名为准，
  行号只用于加速定位。核对清单见 §12。

## 现状摘要

- **入口与作用域**：Pull Request 详情页头部的按钮「AI pre-review (whole PR)」，以及已打开的 PR diff
  编辑器标题栏上的命令 `forgejoToolkit.aiPreReviewPullRequest`；**某一个文件的右键菜单入口已删除**
  （入口与实际作用域曾经不匹配）。一次运行永远是**整个 Pull Request**。

- **模型由用户选择**：`forgejoToolkit.aiPreReviewModel` 是那个选择的唯一来源（运行时列表、命令
  `forgejoToolkit.aiPreReviewChooseModel`、扩展设置页里那一行都能写它）。扩展不挑、不换、不轮换、
  没有窗口记忆；取值不命中或装不下固定指令时**报数字并拒绝**。

- **送什么由用户选择**：`forgejoToolkit.aiPreReviewPromptScope` 有五个取值 `ask` / `metadata-only` /
  `changed-lines-only` / `full-diff` / `changed-files`（推荐）；默认 `ask` 表示"还没选"，第一次运行
  弹**一次**模态框，回答之前不发也不写，答案写进设置（清回 `ask` 才会再问）。

- **确认在专门的面板里**（不再用多选 QuickPick）：每张卡片给出**完整正文**与锚点，外加"在 diff 里
  打开这一行"的链接；头部写明 PR、回答的模型与提供者、本次范围、通过校验的条数与按原因分组的丢弃
  数。**默认零勾选**，扩展也不提供接受全部入口（那个平台全选控件属于 QuickPick，本面板不用它）。

- **正文可在落草稿之前编辑**：输入框预填模型原文并可一键恢复；锚点从不来自 webview，宿主在创建前
  **逐条重校验**回传的 `{ index, body }`，任何一条不过就**整批拒绝**并点名那张卡片。

- **正文用用户当前的语言**（`forgejoToolkit.locale` 优先，否则跟随 VS Code 显示语言，意外取值读作
  英文）；JSON 键、`head`/`base`、路径与数字一律保持原样。

- **只落 PENDING 草稿，绝不提交**：复用既有的"找既有待提交评审"判定，有就追加；提交仍然只走既有的
  「提交评审」按钮，本功能不新增提交入口，也不产出评审结论。

- **答案从响应流的候选通道里取**：`stream` 只消费一次，文本 part 优先、推理 part 次之，`text` 投影
  只在两股候选都没带文本时兜底；两股绝不拼接、绝不修补，由 JSON 契约仲裁。

- **诊断只在 `forgejoToolkit.debug` 打开时存在**：dump 文件与只问选定模型的探测命令。契约失败时，
  无论 debug 与否，输出通道都写一行带**有界摘录**（≤200 字符）的失败行；成功时一个字都不写。

- **开关仍然默认关闭**（`forgejoToolkit.aiPreReview`）：关闭时菜单里不出现，直接调用也拒绝，且绝不
  向模型供应商发出任何内容。

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
扩展不新增任何「提交评审」的入口，模型的产物必须先变成一条 draft，才可能进入既有提交路径。

---

## 2. 决策（摘要）

1. **draft-only：模型永远不能提交。** 生成结果一律落成**待提交评审的草稿评论**；
   本功能不调用 `submitPullReview`，也不调用 `createPullReviewWithComment`（那是"不建草稿、
   直接提交"的单条评论路径）。提交只走既有的「提交评审」按钮与结论选择（§4.2、§5）。
2. **逐条人工确认：~~没有"一键接受全部"~~ 扩展不预选、也不自己提供"接受全部"入口。**
   **2026-10-01 验收修正：这句话此前被读成"屏幕上不存在一键全选"，那是错的**——VS Code 自己的多选
   quick pick 渲染一个 accessible name 为「切换所有复选框」的控件，扩展既不能移除也不能改名，准确口径
   见记录开头那条验收记录。（**注：确认这一步后来换成了扩展自己的面板，那个平台控件随之不再出现，
   见 §5**；上面那句是当时的口径。）模型给的每条意见都要在草稿进入待提交评审之前
   由人单独看过并确认；未确认的意见一个字都不写进实例。默认建议"全部不勾选"，
   人只勾他认可的那几条（§5）。
3. **默认关闭 + 显式开启。** 新设置 `forgejoToolkit.aiPreReview`（布尔，**默认 `false`**）：
   关闭时命令直接拒绝，且**不向模型供应商发出任何内容**（§7）。
4. **送给模型的是"预评审简报"，不是整个 diff。** 复用 `get_pr_review_brief` 的取向与预算
   （只给形状、只给被截断的正文），`metadata-only` 只发变更文件清单 + 每个文件增删行数 + 已有
   评审意见的元数据；~~**是否把 diff 正文本身发给供应商，是留给维护者的决定**~~ ~~**维护者已裁决：默认不送，
   要送得打开第二个窗口级开关 `forgejoToolkit.aiPreReviewIncludeDiff`**（§7.1、§13.1）~~
   **2026-10-02 起，送什么由 `forgejoToolkit.aiPreReviewPromptScope` 决定**：五个取值、默认 `ask`
   （第一次运行只问一次），那个旧布尔已从 manifest 移除、扩展也不再读它——见记录开头 2026-10-02
   那条修正（旧布尔开关的遗留桥被删除）。
5. **一次只跑一个运行，且可取消。** 同一拉取请求同时只有一个运行；取消或失败时，
   已确认落下的草稿评论**保留**（它们已经是既有人工路径的产物），未确认的意见全部丢弃，
   并明确告知用户发生了什么（§6）。
6. **模型输出必须过锚点校验，过不了就丢，绝不猜。** 输出是 JSON、带 schema 校验；
   只有一行/多行、head/base 两侧、且行号确实落在该文件该侧 diff 里的意见才转成草稿，
   其余**丢弃并计数**（不挪到最近的行、不改侧、不截断字数以外的修补）（§8）。
7. **宿主侧调用 `vscode.lm`，webview 不碰模型。** 这条由
   [`../architecture/mcp-server.md`](../architecture/mcp-server.md) 的「Security model」一节
   末段已经定下，本设计沿用（§9）。
8. **模型由用户选择，扩展不挑也不换（2026-10-01 维护者裁决）。** 设置
   `forgejoToolkit.aiPreReviewModel` 是那个选择的唯一来源：空着时运行弹一次 QuickPick 列出**每一个**
   被提供的模型并把你选的那个**写进设置**（普通全局配置更新，设置界面可见可改），非空时每次运行都用它；
   命令 `forgejoToolkit.aiPreReviewChooseModel` 用于以后改；**没有**自动选择、**没有**跨模型轮换、
   **没有**窗口记忆。留下的只有校验，且只报数字、绝不替换（§7.2）。
9. **明确不做**：自动提交评审、未经确认就创建任何评论、开关关闭时发送任何内容、
   自动 approve / request changes、把本功能做成 MCP 工具、对模型输出做"看起来对就接受"的
   宽松解析、**替用户挑模型或在模型之间轮换**。

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
审批框挡着，而「AI 预评审」如果设计成自动提交，用户的仓库里就会出现**没有经过任何人类阅读**的
公开评审记录——这正是条款要防的形状。

所以本设计不是"顺手加一层确认"，而是把**"模型的产出必须经过人"**做成本功能的地基：
模型的产物只能进入一个**只有评审者自己能看见**的中间态（§4.2），离开这个中间态的唯一出口
是既有的人工提交按钮。

### 3.2 否掉的方案

- **~~模型直接调 MCP 写工具提交评审~~**：否决。这等于把模型接进一个已发布、已有逐次审批的
  写路径，让「AI 预评审」变成"AI 评审"。即使用户在 VS Code 里点了"允许"，那也只是批准了一次
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
  `forgejoToolkit.addPullReviewComment`。~~**新的「AI 预评审」动作应当挂同一个键**，
  这样它只在这条 diff 视图里出现，不需要新的上下文键。~~
  （**2026-10-02 修正**：这条只对 `editor/title` 成立——见记录开头「入口从某一个文件的右键菜单移到
  Pull Request 详情页」那条。拿行级意见去改一整份 diff 的动作不该挂在**某一个文件**的菜单里，
  所以 `editor/context` 那条贡献已被删除，只剩 `editor/title`（`when` 仍是
  `forgejoToolkit.inPullRequestDiff && config.forgejoToolkit.aiPreReview`）；`editor/lineNumber/context`
  与 `addPullReviewComment` 不受影响。）

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
  `sideLines.get(line)` 存在（多行时还要 `line + extraLinesCount` 存在）：锚点行不在表里时报
  "Comments can only be added to lines within the pull request diff"，而锚点在表里、只有多行区间的末行
  越界时改为点名那一行（"The selection reaches line {0}, which is outside the pull request diff"），
  免得用户看着光标下的改动行读不懂那句笼统的拒绝。
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

1. 运行结束后，把通过 §8 锚点校验的候选意见**一次性展示在确认面板里**——一个编辑器标签页中的
   webview 面板（`src/aiPreReviewPanel.ts` 的 `AiPreReviewPanel`，文档是 `webview/aiPreReview.html`）。
   每张卡片给出**完整正文**（换行保留、可选中复制）与它的锚点（`path:line` 或区间，加
   `(head|base)`）、一个复选框，以及一个「在 diff 里打开这一行」的链接；头部写明 PR 身份、回答的
   **模型及其 vendor**（隐私那句话留在屏幕上）、**本次运行实际使用的提示词范围**、通过锚点校验的
   条数与**按原因分组**的丢弃数。
2. **默认不勾选任何一条。** 勾选是"我读过并认可这条"的表达；预勾选会把"确认"变成"默认同意"，
   与 §3.1 的约束直接冲突。
3. 确认后逐条写草稿：第一条走 `createPendingPullReview`（或复用既有 `pendingReviewId` 时走
   `addPullReviewComment`），其余走 `addPullReviewComment`。
4. 清单里被放弃的意见**完全不产生任何请求**；运行结束后告知"生成 N 条、采纳 M 条、丢弃 K 条
   （K 里再分：锚点无效 / 用户未勾选）"。
5. **不提供任何"接受全部"入口**：默认一条都不勾选，在用户自己勾之前什么都不会被创建（创建按钮在
   零勾选时禁用并显示 `Create 0 draft comment(s)`）。VS Code 多选 QuickPick 自带的那个全选控件
   随 QuickPick 一起退场——本面板不使用它，所以"扩展不预选、也不添加接受全部入口"这句在这里是
   完整口径。
6. **正文可以在落草稿之前编辑**：每张卡片的多行输入框预填模型原文，与原文逐字节不同时标 `Edited`
   并提供一个「恢复模型原文」的动作；长度上限就是既有的 `PR_REVIEW_MAX_COMMENT_LENGTH`（到达上限时
   明说、超过则禁用创建，扩展不替用户截断）。锚点、路径、侧与 sha **从不来自 webview**。
7. **宿主逐条重校验**：面板回传的是 `{ index, body }[]`；宿主只读这两个字段，`index` 必须是它确实
   提供过的卡片（同一张卡被点两次也算失败），`body` 必须是非空白、不超上限的字符串——**任何一条
   不过就整批判定失败**，什么都不写并点名那张卡片。整批拒绝的理由是：按钮上写着的条数正是用户
   盯着的东西，少写一条而不说，就是这个功能要消灭的那种意外。

---

## 6. 运行怎么触发、边界在哪

### 6.1 触发

- 一个宿主命令，建议命名 `forgejoToolkit.aiPreReviewPullRequest`（与既有命令的命名风格一致：
  `forgejoToolkit.addPullReviewComment` / `forgejoToolkit.createPrFromCurrentBranch`），
  挂在 `editor/title`，`when` 用既有的 `forgejoToolkit.inPullRequestDiff`。
  （**2026-10-02 修正**：`editor/context` 那条后来被删除，见记录开头「入口从某一个文件的右键菜单移到
  Pull Request 详情页」那条；这是**第二个**入口——PR 详情页上的按钮把该 PR 的坐标
  `{ instanceId, owner, repo, index }` 发给宿主，宿主校验后调用**同一个** `runAiPreReview`。）
- 命令从**活动 diff 文档的 URI** 解析出目标：`parseForgejoPrUri` 给出
  `instanceId` / `owner` / `repo` / `index` / `path` / `isBase` / `ref`。
  与 `addPullReviewComment` 的命令处理一样，**按 URI 找编辑器，回退到活动编辑器**，
  而不是盲信 `activeTextEditor`（diff 编辑器是两个）。
  （**2026-10-02 补**：解析出来的这组坐标就是运行真正需要的东西，所以 `runAiPreReview` 的参数类型
  收窄成 `PullRequestTarget`——`instanceId` / `owner` / `repo` / `index` 四个字段——详情页的按钮
  走的是同一个函数，只是坐标来自 webview 消息而不是 URI。）
- **作用域决策：一次运行覆盖整个拉取请求，而不是单个文件。** 行级评审的价值有一半在
  "这个改动与那个改动是一件事"，只看一个文件会漏掉它；而且 §7 的简报本来就是按 PR 组织的。
  代价是输入更大，由 §7.2 的预算兜住。**留给维护者的变体**见 §13.2（是否要一个"只评这个文件"
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
- **留给维护者的变体**见 §13.3：要不要在这种情况下**直接拒绝**，要求用户先处理掉既有草稿。

### 6.4 取消、失败、部分失败

| 情形                                         | 已确认落下的草稿评论 | 未确认的意见 | 用户看到什么                                                                                                                                                                                           |
| -------------------------------------------- | -------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 用户在确认清单上点取消                       | 无（还没写）         | 全部丢弃     | 一条信息：已取消，未创建任何评论                                                                                                                                                                       |
| 模型调用被取消 / 超时                        | 无                   | 全部丢弃     | 一条信息：已取消；不留下半份草稿                                                                                                                                                                       |
| 模型调用报错（见 §9.3）                      | 无                   | 全部丢弃     | 一条错误：原因（无模型 / 无权限 / 被限流 / 其他），以及"这不影响你的评审"                                                                                                                              |
| 输出不是约定的 JSON（空 / 非 JSON / 形状错） | 无                   | 全部丢弃     | 见下：只对**用户选定的那一个**模型重问一次（上限 2 次调用）；两次都失败时一条错误，点名该模型、问了几次、每次失败的方式（空回答 / 不是 JSON / 形状错在哪个字段），没有创建任何评论，并指向换模型的命令 |
| 输出是合法 JSON、但锚点全被丢弃              | 无                   | 全部丢弃     | 一条信息：生成 N 条、可用 0 条及其原因（§5.4），**不重试**——这是内容结果，不是形状问题                                                                                                                 |
| 确认后写第 M 条失败（HTTP）                  | 前 M-1 条**保留**    | 其余丢弃     | 一条错误：写明前 M-1 条已作为草稿存在，并给出失败原因；**不自动回滚已成功的**                                                                                                                          |
| 全部成功                                     | 全部保留             | —            | 一条信息：N 条已加入待提交评审，请在「提交评审」时逐条复核                                                                                                                                             |

**为什么不回滚已成功的草稿**：删除草稿评论是 `deletePullReviewComment`，它同样是一次
写请求，且删除是**不可逆**的——为了"看起来干净"而删掉用户可能已经看过并认可的内容，
比留下几条待提交评论更糟。草稿态本身没有公开副作用，留着是可接受的方向。
**注意**：这条与"Codeberg 约束"不冲突，因为 PENDING 评论不是公开记录（见 §4.2）。

**输出不合契约时的重试（2026-10-01 补；同日第五次排查改为"先问同一个模型"；同日维护者裁决后只剩
这一个模型）**：第二次 UI 验证里 4/4 次运行都止于"回答无法解析"，而机器上有多个聊天模型可用——扩展
本可以自己问，却只留给用户一句"再试一次"。所以这一行改成一个**有界**的重试：

- **只对契约失败重试**：回答是空、回答不是 JSON、JSON 形状不对（顶层不是对象 / `comments` 不是
  数组）。**不重试**的情况各有理由——模型调用报错是提供者状态而不是回答形状（§9.3 已分类）；
  用户取消就是取消；合法 JSON 但锚点全被丢弃是内容结果，应当让人看见原因而不是再花一次调用的
  额度去赌（§8 的"绝不猜"同样不适用于"换个模型猜"）。
- **只问用户选定的那一个模型，问完就停。** ~~先问同一个模型第二次，再换下一个候选。~~
  第五次排查的证据（写在记录开头的交付记录里）是：失败**按次**发生而不是按模型——同一个模型有时能答、
  有时只回 5–10 字符的碎片，而提供者与我们发的内容无关（12 个模型 × 3 种形态 = 36 次调用，只有 6 次
  有返回且全是 `{}`；三种形态各自既有成功也有失败）。所以"同一个模型再问一次"才是证据支持的那根杠杆。
  **但"再换下一个候选"已被维护者的裁决删除**：那一步是扩展替用户在模型之间做选择，正是被否决的东西；
  证据支持的是"同一个调用可能下一次就好了"，不是"扩展可以自己换人"。两次是能区分"不稳定"与"答不了"
  的最小次数：一次重试把命中一次好样本的概率翻倍，再多就是拿用户的额度去赌一个已经失败两次的模型。
- **一个上限，就是"同一模型最多 2 次"。** ~~两个上限，各自命名，相乘。~~
  `AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL = 2` 是**唯一**的上限，一次运行的模型调用上限因此是 **2 次**
  （~~`AI_PRE_REVIEW_MAX_MODELS_PER_RUN = 3` 与 `AI_PRE_REVIEW_MAX_MODEL_CALLS = 3 × 2 = 6` 两个常量
  已删除~~）。请求装不下指令的模型根本不会被问（它连校验都过不了，见 §7.2），所以"因预算被跳过的候选
  不消耗计数"这句话现在没有对象了。**声明这个上限的地方有两处**：用户消息里那句"the same question
  {1} time(s) — its bound is {2} attempt(s) per run, and no other model was called"，以及本记录。
- **每次失败都留名，并说明实际花了多少次调用。** 模型身份（`vendor` / `family` / `id`）、失败种类、
  以及"这是这个模型的第几次询问（`attempt 2 of 2 for the chosen model`）"各一行 `logger.error`；
  ~~回答本身只在 debug 级留一条**有界形状描述**（见 §7.2）。~~ **2026-10-01 修正：失败行里也带一条
  回答的**有界摘录**（最多 200 字符、转义成一行），成功时仍一个字都不写；理由与完整口径见记录开头那条
  修正与 §7.2。** 两次都失败时，用户消息先报**实际发出的
  调用数**，再把每次失败在哪儿写出，而不是一句"无法解析"——用户在为这些调用付费。
- **成功的重试照常继续，并说清是第几次。** 第 2 次询问给出合规 JSON 时，这次运行走的就是 §5 的确认
  清单与 §6.4 的落草稿路径，日志里补一行
  `1 earlier answer(s) did not return the contracted JSON; <模型> did, on attempt 2 of 2 for the chosen
model (2 call(s) spent this run)`——**这一行就是"重试救回了一个不稳定的提供者"的证据**，下一轮真机
  验证读的就是它。
- **"什么都没发、什么都没建"不变**：契约失败本身就没有产生任何请求或评论，重试只是在**同一个运行**里
  对**同一个**模型再问一次。唯一变化的成本是最坏情况下的调用数（2 次），它被上面那个常量固定住并逐字
  写进用户消息。

### 6.5 数量与预算

- **候选意见上限 20 条/次**（在提示词里明确要求，并在校验阶段硬性截断），
  与既有工具面的预算口径一致（`get_pr_review_brief` 的 `PR_REVIEW_MAX_COMMENTS = 50` 是
  "给 agent 看的未解决评论"上限，本功能是"一次让**人**过目的清单"，20 是人的复核上限）。
- 每条评论正文长度上限按既有 `get_pr_review_brief` 的 `PR_REVIEW_MAX_COMMENT_LENGTH`
  （1024 字符）截断并注明，而不是任由模型写长篇。
- **"一次运行只发一次模型请求"改为"对**用户选定的那一个**模型、同一条提示词，最多再发一次"。**
  单轮、不追加对话、不给模型工具这三条不变：重试（§6.4）是把**同一条**提示词再发一遍，不是与模型来回，
  也**不是**换一个模型再发（换模型已被维护者裁决否决，见 §7.2）。不做多轮追问的理由照旧——多轮会把
  "这是什么"的自主性交给模型，也会让 token 成本不可预测；重试的**请求数**由
  `AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL = 2` 固定住，所以一次运行最多 2 次模型调用。
  **留给维护者的变体**见 §13.4。

---

## 7. 送给模型供应商什么（开关默认关闭）

### 7.1 内容清单

**决策：`metadata-only` 是简报本身（文件表 + 已有意见的元数据），它是每个范围的底线；要不要连代码
一起送、送多少，由 `forgejoToolkit.aiPreReviewPromptScope` 决定——默认 `ask`，意思是第一次运行先问
（§7.2、§7.3）。** 具体字段：

| 送                                                    | 不送                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| 实例的**主机名之外的**仓库标识 `owner/repo`（无 URL） | 实例的 URL / 主机名（对应 §12 的脱敏先例）                       |
| 拉取请求标题、编号、base/head 分支名                  | 拉取请求正文全文（可能含内部链接与附件）                         |
| 每个变更文件的**路径**、增删行数、状态                | **文件内容 / diff 正文**（送不送、送多少由提示词范围决定，见下） |
| 已有评审意见的**元数据**（路径、行号、作者、状态）    | 已有评论的**正文全文**（可能含内部讨论）                         |
| 提示词模板本身                                        | 参与者的邮箱、token、任何本地路径                                |

**五个取值各自发出什么字节**（`forgejoToolkit.aiPreReviewPromptScope`）：`ask` = 还没选，读到它时
什么都不发（先弹一次模态框，见 §7.3，弹之前不请求、不发送、不写入）；`metadata-only` = 简报本身，
没有 `[diff]`、也没有 `[changed-file-contents]`；`changed-lines-only` = 简报 + `[diff]`，每个文件只
保留 `diff --git` / `index` / `---` / `+++` / `@@` 这些头与 `+`/`-` 行，**丢掉以空格开头的上下文行**
（hunk 头必须留着：它是提示词里唯一说明某个 `+`/`-` 行是文件第几行的东西，丢了这个范围就没法给出
合法的文件行号），并在 `[diff]` 下写明这是节选；`full-diff` = 简报 + 原样的整份 diff，与旧布尔打开
时完全一致（`PR_REVIEW_DIFF_BUDGET`、`PR_REVIEW_MAX_DIFF_FILES`，超出时从末尾丢整个文件）；
`changed-files`（推荐）= `full-diff` 的全部**加上** `[changed-file-contents]`：按简报顺序、以 PR 的
head sha 为 `ref` 逐个读取**该 PR 改动过的**文件正文（`getFileContentResult`，只取 `kind === 'file'`），
受 `AI_PRE_REVIEW_MAX_CONTENT_FILES`（20）与 `AI_PRE_REVIEW_FILE_CONTENT_BUDGET`（=
`PR_REVIEW_DIFF_BUDGET`）约束，超出时**从末尾丢整个文件**并在提示词里写明 `truncatedBy`；唯一例外是
"单个文件就超过整个预算"，这时把它截断保留（否则这个范围会静默退化成 `changed-lines-only`）并说明
只显示了开头。四种范围都**仍然抓取 diff**（锚点校验靠它的行表），都**不发访问令牌、不发 URL / 主机名、
不发已有评论的正文**，`changed-files` 也**只读该 PR 变更过的文件**；head 在别的仓库（fork）或服务端
没给 head sha 时**一个文件正文都不发**并写明原因——读默认分支会发出与本次评审无关的代码。

**为什么代码出不出本机要单独问一次**：这不是"省 token"，是隐私判断——diff 正文就是代码本身，
它一旦离开本机，就不受本项目的任何策略约束了。而"是否愿意把代码片段发给模型供应商"
是**用户对供应商**的关系，不是本项目能替他决定的（`TODO.md` 里 PR 描述生成那条也写着
"代码片段会发给模型供应商，加默认关闭的设置开关"，同一种判断）。

**旧布尔开关的取舍（记录在案）。** 曾经在"默认只送简报"与"代码要第二个开关"之间选过 (a)，那个
布尔（`forgejoToolkit.aiPreReviewIncludeDiff`）已被提示词范围取代并从 manifest 删除，扩展也不再
读它；三个选项与当时的裁决理由留在记录里。今天的边界是：**送什么由
`forgejoToolkit.aiPreReviewPromptScope` 决定**（五个取值各自发出什么见上，还没选时先问一次见
§7.3），上表是每个范围共同的底线。

### 7.2 预算与截断

- 简报的组装复用 `get_pr_review_brief` 的**同一套预算常量与截断口径**
  （`PR_REVIEW_BRIEF_BUDGET`、`PR_REVIEW_DIFF_BUDGET`、`PR_REVIEW_COMMENT_BUDGET`、
  `PR_REVIEW_MAX_DIFF_FILES`、`PR_REVIEW_MAX_COMMENTS`，都在 `mcp/tools.ts`），
  并在送之前用 `LanguageModelChat.countTokens` 对 `maxInputTokens` 做一次真实核对：
  **超预算时按文件粒度丢弃并计数**，绝不静默截断到模型看到半份 diff 还以为是全部。
- 送出去的简报里要显式带上"哪些部分被截断了"，与 `get_pr_review_brief` 的 `truncatedBy`
  同一取向：模型需要知道自己看到的是不是全部。
- **模型不由扩展挑选（今天的边界与来历）。** 曾经按每种形态的输入预算去挑候选，那段实现与理由
  留在记录里。
  这段历史仍然有用，它解释了**为什么会有校验这件事**：指令提示词是每次运行都要付的固定成本，第一个
  被提供的模型完全可能装不下它。**留下的只有校验，且绝不替换**：选定模型后
  `validateChosenAiPreReviewModel()` 用**该模型自己的** `countTokens` 量一遍固定指令提示词，
  `>= maxInputTokens` 就按两个数字拒绝（点名模型：需要多少 / 可用多少），分词器抛错则单独报"量不出来"；
  两条路径都**不换模型**。指令提示词本身按"每条规则都还要在"的前提压缩过（892 → 781 字符），并有
  一条测试锁住上限。不用 `vendor` / `family` 去挑提供者：那等于替用户点名一个提供者（§9.3）。
- **没有"先问谁"这回事**：运行只有一个模型。曾经的三条候选排序信号——"用户最近选用的模型"（该读数
  不存在）、点名 `vendor` / `family`（等于替用户点名提供者）、本扩展自己的"本窗口曾答对"记忆
  （是观察，不是用户的指令）——逐条核对的原文与理由都在记录里。
- **契约失败的重试与诊断（2026-10-01 补；同日第五次排查把"换人"改成"先问同一个模型"；同日维护者裁决
  删掉跨模型的那一半）。** 重试的边界与理由写在 §6.4，这里是它的几处实现口径：
  ① 上限只剩一个常量：`AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL = 2`
  （~~`AI_PRE_REVIEW_MAX_MODELS_PER_RUN = 3` 与乘积 `AI_PRE_REVIEW_MAX_MODEL_CALLS = 6` 已删除~~），
  它同时就是一次运行的模型调用上限。2026-10-01 的第二次 UI 验证里 4/4 次运行都止于"回答无法解析"；
  第五次排查证明这些失败是**按次**的，所以"同一个模型再问一次"才是证据支持的那根杠杆（§6.4），
  而"再换一个模型"被维护者否决。
  ② 失败要能诊断，而三类失败**各给一条消息与一行日志**：**空回答**、**不是 JSON**（散文、截断的
  JSON、闭合不了的围栏）、**形状不对**（顶层不是对象 / `comments` 缺失或不是数组——消息点名是
  哪一个字段；用 `JSON.parse` 自己的报错信息不行，V8 会在消息里引用被解析文本的开头，那等于把
  回答片段带进用户可见的日志）。日志里写清被问模型的 `vendor` / `family` / `id`（`name` 一并给，
  两个提供者可能各有一个叫"GPT-4o"的模型）与**这是这个模型的第几次询问**，~~回答本身只留一条
  **debug 级**、**有界**的形状描述：
  长度、是否以 `{` 开头、首行前 60 字符（`describeAiPreReviewAnswerShape()`）。debug 级沿用既有的
  `forgejoToolkit.debug` 开关（`src/logger.ts` 的 `Logger.debug`），不新开日志开关；**不写回答
  全文、不写简报、不写 diff**——回答是可能引用仓库代码的模型输出，而输出通道是用户可见的。~~
  ——这条"回答只留在 debug 里"已被 2026-10-01 的修正取代（见记录开头那条修正）：**契约失败的行现在
  始终带一条回答的有界摘录**（最多 200 字符、`JSON.stringify` 转义成一行；成功时一个字都不写），
  因为只说"不是 JSON"无法判断是模型退化、被截断还是提示词不对。debug 级那条有界形状描述**照旧保留**，
  **简报、diff 与提示词仍然一个字都不进输出通道**，超过摘录上限的部分仍然只在 debug 的 dump 里；
  **debug 打开时另有回答的碎片清单与小结**（2026-10-01 第八次修正，见记录开头那条——一行一个碎片，
  一行写碎片总数、字符总数与拼接结果的有界开头，所以"成功时一个字都不写"只在 debug 关闭时逐字成立）。
  ③ **花掉的调用数要报出来**：两次都失败的消息先写"the same question {1} time(s) — its bound is
  {2} attempt(s) per run, and no other model was called"，再写每次失败在哪儿；成功路径的日志写
  "在第几次询问上给了合规 JSON、这次运行一共花了几次调用"。用户为这些调用付费，所以数字进用户可见
  的消息；~~而**回答内容不进去**（有界形状描述只在 debug 级与 dump 里）。~~ **2026-10-01 修正后：
  每次失败的尝试还带一条有界摘录（≤200 字符、转义成一行），完整回答仍然只在 debug 的 dump 里。**
- **装不下时必须报出数字，不许只说"放不下"。** 装不下**固定指令提示词**时，提示点名选定的模型并
  写清"需要多少 / 可用多少"，再说清**没有替换成别的模型**，并指向换模型的命令；请求装不下时同样
  带上"需要多少 / 可用多少"与模型身份，并点名可以把 `forgejoToolkit.aiPreReviewPromptScope` 调小
  （例如 `metadata-only`）让请求变小。两条路径都仍然**什么都没发、什么都没建**，
  且日志里各留一行带数字的记录。注意：指令放不下时**不能**把"调小提示词范围"当成解法推荐（它只让
  请求变小，不让固定指令变小），但要在提示里**点名说清它帮不上忙**——否则用户会先白试一次。
  ~~连指令都放不下时写清"VS Code 提供了几个模型、其中最大的 `maxInputTokens` 是多少"~~
  ——"最大的预算是多少"是替用户做选择的暗示，已去掉；取而代之的是**列出每一个被提供模型及其
  `maxInputTokens`**（只在"配置的值没命中任何模型"那条拒绝里），以及换模型的命令。
- **请求形态（2026-10-01 第三次排查补）：指令与请求放进同一条 `User` 消息。** 曾经发两条 `User`
  消息（先指令、后简报），那也是官方 Language Model API 指南示例的写法；改成一条的依据是 API 的两条
  事实（§9.1）：**没有 system 角色可用**，而 provider 收到的是 `role` + content parts
  （`LanguageModelChatRequestMessage`）并自行转换角色——指南给出的转换示例把**每一条** `User` 都映射成
  同一个 `user`，于是两条 `User` 消息在供应商那边就是两轮连续的 user turn，而契约文本正好落在"可以被一次
  转换丢掉的那一条"里。合成一条之后不存在"更早的一条消息"可丢：模型要么同时看到规则与这份 Pull
  Request，要么什么都没看到、回答照旧响亮地失败。副作用是预算口径变干净了：`countTokens` 量的是
  **真正发出的那段文本**（`aiPreReviewPromptText`），而不是两次 `countTokens` 相加的近似值，所以
  "需要多少 / 可用多少"报的就是模型真正收到的那个数。规则本身、提示词的两半、回程的逐条校验都不变，
  按文件粒度丢弃时仍然只重写请求那一半。
- **调试诊断（2026-10-01 第三次排查补，实现见 §9.6）：dump 与探测都只在 `forgejoToolkit.debug` 打开时
  存在。** 这是上文"~~**不写回答全文**~~"的**唯一**例外，例外本身被三个方向限定住：
  ① 去向是文件（`context.logUri` 下的 `ai-pre-review-diagnostics.log`），不是用户可见的输出通道；
  ② 默认关闭——debug 关闭时 sink 连文件路径都没有，连"写错地方"都不可能；③ 探测命令另外还要求
  `forgejoToolkit.aiPreReview` 打开，因为那个开关承诺的是"关闭时不向模型供应商发出任何内容"，诊断
  命令也不能例外。~~默认路径的承诺因此逐字保留：输出通道里永远没有回答正文，只有长度、是否以 `{` 开头
  与首行前 60 字符。~~ **2026-10-01 修正：这条"输出通道里永远没有回答正文"不再逐字成立**——契约失败时
  失败行带一条有界摘录（≤200 字符、转义成一行；成功时一个字都不写），见记录开头那条修正；
  **2026-10-01 第八次修正：debug 打开时输出通道还多一行一个碎片与一行小结**（同样是回答正文，同样
  只在 debug 下；debug 关闭时仍然一行都没有，见记录开头那条）；除这些之外，输出通道里的回答信息仍然
  只有长度、是否以 `{` 开头与首行前 60 字符，**简报、diff 与提示词在任何模式下都到不了输出通道**，
  完整回答与碎片清单在 debug 打开时同时进 dump，这份 dump 的开关、文件名与只增不改的格式都不变。
- **"问哪个模型"由用户决定，而这个选择就是设置（2026-10-01 第四次排查补；同日维护者裁决后不再有
  "自动选择仍是默认"）。** 第三次排查的证据是：维护者机器上 `selectChatModels()` 提供的模型对真实
  请求全部回 5–10 字符的退化回答；第五次排查进一步证明失败是**按次**的。扩展手上能让运行"换个模型问"
  的信号只有本节上半段列出的三类，其中"用户最近选用的模型"这类**读数根本不存在**（§9.1 的逐条核对），
  按预算挑"最大的那个"正好就是这台机器上失败的那个，而"本窗口曾答对"是本扩展自己的观察、不是用户的
  指令。维护者的裁决把结论推到底：**自动选择——按预算挑、按历史排序、跨模型轮换、窗口记忆，全部删除**；
  扩展只做三件事：列出、让用户选、然后一直用那一个。
  - **一个选择的唯一来源，一个存储。** 设置 `forgejoToolkit.aiPreReviewModel`（窗口级、字符串、
    默认空）**就是**那个选择，没有第二个地方记它：空着时运行弹一次 QuickPick，把答案**写进设置**
    （`writeAiPreReviewModelSetting()`，普通 `ConfigurationTarget.Global` 更新，所以设置界面里可见、
    可手改），本次运行立即用它；非空时每次运行都用它、不弹窗。~~运行时的 QuickPick 答案按窗口记住、
    不落盘~~ ——这条"窗口记忆"（`chosenReviewModelKeys`）已删除：它能在设置之外持有另一个答案，
    于是两处可能不一致。
  - **取值用 API 自己的词汇，不用我们的。** 接受 `vendor/family` 与 `vendor/id` 两种形态
    （`LanguageModelChatSelector` 的字段就是这四个：`vendor` / `family` / `version` / `id`），并接受
    一个可选的 `@version` 后缀，因为那是 API 支持的第四个字段，拒绝它等于让用户无法表达一个合法选择。
    解析**只**放宽大小写与首尾空格；多于一个斜杠、缺一半、`@` 后为空、或干脆不是一个选择器，全部
    按"没命中"处理。选择器的主体同时是 `family` 与 `id`（两者都是不透明字符串，语法上分不出来），
    匹配时按**或**处理：命中的是哪个字段都算命中，而要求两个字段同时相等会让"family 与 id 不同的
    模型"永远匹配不上。**写回设置时取 `vendor/id` 优先**（`formatAiPreReviewModelSettingValue()`）：
    两个模型可能共享一个 family，写 family 会让下一次运行匹配到另一个——那就是静默替换。
  - **~~解析出的选择器既传给 API，也用于过滤。~~ 选择器不再传给 API。**
    ~~`selectChatModels(selector)` 是 API 自己的收窄方式……~~ 列表调用现在**不带参数**：选择器只
    用于在**完整**的提供列表里找出配置命中的那一个（`findOfferedAiPreReviewModel()`），因为拒绝消息
    要列出全部被提供模型、选择列表也要列出全部。~~命中的模型与"用户选过的模型"都只是排到最前~~
    ——排序本身没了：运行只有一个模型。
  - **不命中就拒绝，绝不静默忽略。** 配置了取值但解析不了、或解析出来没有命中任何被提供的模型时，
    运行**在读取任何东西之前**拒绝（§9.3 的第四种"本功能不可用"的兄弟），提示里同时给出
    **配置的原值**、**每个被提供模型的 `vendor/family`（必要时 `id`）及其 `maxInputTokens`**，
    以及**换模型的命令**——改对一个设置需要知道能填什么，而扩展是唯一知道这件事的地方。静默退回
    自动选择是这里**最坏**的行为：用户点名了一个提供者，代码却把简报发给了另一个。
  - **隐私是这条决定的一半。** 简报发到哪个提供者由模型决定（§7.1），所以"哪个模型"就是"哪些内容
    出不出本机"的一部分；QuickPick 的每一项因此都写明"简报会发给 X 提供者"，而不是只给一个模型名。
    提示文案也照这个口径改成"这次选择会写进设置，之后每次运行都用它"。
  - **取消 = 运行取消，什么都不写。** ~~只有多于一个候选时才问~~ ——现在**只要设置为空就问**，哪怕
    编辑器只提供一个模型：一个模型不是用户做过的选择。取消选择（按 Esc）则运行取消：零模型调用、
    零网络请求、什么都没创建、设置一个字都不写（`reportModelChoiceDismissed()`）。
  - **~~一次统一的机会，而不是两次。~~** 预算守卫曾在 QuickPick **之前**跑、只对"装得下指令"的
    候选提问。~~现在反过来~~：选择列表列出**每一个**被提供模型（按预算预筛本身就是替用户筛），
    选定之后才做指令提示词的校验，装不下就按两个数字拒绝并请用户另选一个
    （`validateChosenAiPreReviewModel()`）——把"能不能装下"的答案放在用户选择之后，是因为**只有
    用户的选择才能决定问谁**，而拒绝一个选择并把数字说清楚，比替用户过滤掉它更诚实。

### 7.3 开关语义

- 设置键 `forgejoToolkit.aiPreReview`（布尔，默认 `false`），文案要写清三件事：
  ① 开启后会把拉取请求的元数据（以及 `forgejoToolkit.aiPreReviewPromptScope` 决定的那部分
  diff / 文件正文）发给**模型供应商**；
  ② 生成的意见只是草稿，仍要逐条确认；③ 关闭时本功能完全不出现在菜单里或不产生任何请求
  （③ 的前半句由 2026-10-01 的修正落实：两个菜单项的 `when` 现在同时要求
  `config.forgejoToolkit.aiPreReview`，见记录开头那条修正；后半句的运行时拒绝不变）。
- 这是**窗口级**设置，与 `forgejoToolkit.mcpWriteTools.*` / `forgejoToolkit.mcpWriteAuditToFile`
  同一层命名与同一读取方式（§9.4 的 `mcpWriteSettings.ts` 是先例：读不到就当作关闭）。
- **提示词范围未定时先问一次（模态框，fail-closed）。** 设置键
  `forgejoToolkit.aiPreReviewPromptScope`（字符串，`enum` + `enumDescriptions`，双语 nls 都有，
  默认 `ask`）读到 `ask` 时，运行在模型已经确定（因此能点名**提供者的 vendor**，与模型列表同一个
  事实）之后、在**任何 HTTP 请求与任何模型调用之前**弹一个
  `vscode.window.showInformationMessage(..., { modal: true }, ...)`，写明内容会发给谁、每个答案分别
  会发出什么（`metadata-only` 明说"模型读不到任何一行变更代码、只能对文件层面的事发表意见"），以及
  "回答之前不请求、不发送、不写入"。按钮是：**发送变更文件的完整内容（推荐）** / **只发送变更的行** /
  **只发送元数据** / **取消——什么都不发送**；关闭控件与 Esc 等价于取消，取消即整次运行取消——零
  HTTP 请求、零模型调用、零写入，设置保持 `ask`，并给出一句说明。被选中的范围以普通的全局配置更新
  （`ConfigurationTarget.Global`）写进设置，所以它看得见、能改、可审计；写失败只影响"答案记在哪里"，
  不影响本次运行用什么范围。**只有已选定**的范围会被写入——把 `ask` 写回去等于把答案变回问题，于是
  "只问一次"是**设置**层面的事实：只有用户把它清回 `ask` 时才会再问。
- **旧布尔的残留取值不算选择**：`forgejoToolkit.aiPreReviewIncludeDiff` 的 manifest 键已删除，扩展
  也不再读它；`settings.json` 里留着它只会被 VS Code 标为未知设置（功能从未发布过，没有迁移要搬运）。

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
- **用户在落草稿之前可以改正文**：面板回传的 `body` 由宿主逐条重校验（非空白、不超过
  `PR_REVIEW_MAX_COMMENT_LENGTH`，且 `index` 必须是提供过的卡片），任何一条不过就整批拒绝；
  锚点、路径与侧仍然只来自宿主自己的候选（§5）。
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
  `for await`。本功能只关心最终文本，所以**答案从 `stream` 的候选通道里取**（文本 part 优先、
  推理 part 次之），`text` 只在两股候选都没有文本时兜底，取消时停止消费——解析规则见 §7.2 与 §9.6。
- `LanguageModelChatRequestOptions.justification` 是给用户的说明文案——**首次调用模型会弹
  一次同意框**（`sendRequest` 的注释："must _only_ called in response to a user action"）。
  本功能由命令触发，天然满足"user action"；`justification` 要写清"把变更文件清单与元数据
  发给模型以生成评审草稿"。
- **这个版本里"没有"的三件事**（2026-10-01 逐条核对 `@types/vscode` 1.102.0 的 `index.d.ts`）：
  ① **没有"用户最近选用/当前选中的模型"这种读数**。`ChatRequest.model` 的注释是"This is the
  model that is currently selected in the UI"，但 `ChatRequest` 只出现在 `ChatRequestHandler`
  的参数里，宿主命令拿不到；`LanguageModelAccessInformation` 只暴露 `onDidChange` 与
  `canSendRequest(chat)`（后者答的是"同意框给过没有"）；`LanguageModelChatSelector` 的四个字段
  全是**选择器**（`vendor` / `family` / `version` / `id`），不是"当前选中"的读数。②
  `selectChatModels()` **不承诺返回顺序**（注释只有"When omitted all chat models are
  returned"）——所以本扩展既不知道用户在用哪个模型，也不能把返回顺序当成偏好。**§7.2 的排序
  （本扩展自己的历史）也因此被否决**：没有读数就只能问用户，问来的答案写进设置。
  ③ **没有 system 角色**：`LanguageModelChatMessageRole` 只声明 `User = 1` 与 `Assistant = 2`
  （注释原文"This is either the user or the assistant"），`LanguageModelChatMessage` 只有
  `User` / `Assistant` 两个静态工厂，构造函数虽然接受 `role`，可传的值也只有那两个；官方指南
  「Language Model API」的 "Build the language model prompt" 一节至今写着 "**Note**: Currently,
  the Language Model API doesn't support the use of system messages."，而 provider 侧收到的
  `LanguageModelChatRequestMessage.role` 是同一个枚举。所以"把指令放进 system 消息"这条路在当前
  API 里**不存在**，指令只能作为 `User` 消息的一部分送出——§7.2 因此把两半合成一条（该指南自己的
  例子正是两条 `User`，我们有意与之不同，理由是同一节里那份 provider 转换示例）。
- **这条"没有读数"的结论是"必须问用户"的直接依据（2026-10-01 第四次排查补；同日维护者裁决后
  收紧了结论）。** 上面 ① 说明本功能**无法**知道用户在自己的聊天选择器里选的是哪个模型，② 说明它
  连返回顺序都不能当作偏好；所以本功能不替用户在提供者之间挑，而是把选择交出去，并且**只留一个
  存储**：设置 `forgejoToolkit.aiPreReviewModel`（值是 `LanguageModelChatSelector` 的四字段词汇里
  可表达的 `vendor/family` 或 `vendor/id`，可带 `@version`），由运行时 QuickPick 写入。
  ~~临时的那个是运行时 QuickPick 加一条窗口级记忆~~ ——窗口记忆已删除（它能在设置之外持有第二个
  答案）。**选择器也不再传给 `selectChatModels`**：调用不带参数，取回完整的提供列表，选择器只在
  这份列表里做匹配（拒绝消息与选择列表都要列全）；~~选择器本身反而可以传给
  `selectChatModels(selector)`~~ 这条曾经的便利不再需要，因为不再有"把命中的排到最前"这种排序。
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
- **有模型、但选定的那一个装不下固定指令** → 与上面三条并列的第四种"本功能不可用"，提示按 §7.2
  点名该模型并写清"需要多少 / 可用多少"，说清**没有替换成别的模型**，并指向换模型的命令，
  且**在发第一个 HTTP 请求之前**就返回：这一条不取决于 PR 内容，取决于模型本身。
  （~~"没有任何一个"~~ ——按预算预筛候选已删除：装不装得下由用户选完之后再判，判不过就报数字。）
- **绝不降级到"用启发式规则当评审"**：没有模型就是没这个功能，不是换个方式蒙。

### 9.4 设置读取与测试面的既有形态

- 设置读取的先例是 `src/mcpWriteSettings.ts`：读不到 / 类型不对一律按「关闭」处理
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
- 重试与诊断那部分（2026-10-01 补）要求测试面补两件事：① 假模型带**可区分的 `vendor` / `family` /
  `id`**，因为写进设置的取值是 `vendor/id`、而"只有被选中的那一个模型被调用"这条要靠身份断言；
  ~~② §7.2 的窗口记忆是模块级状态，所以 `beforeEach` 要调 `resetAiPreReviewModelMemory()`~~ ——
  窗口记忆已删除（没有任何模块级模型状态，也就没有跨用例的排序泄漏）；② MSW 的夹具状态
  （`resetMockState()`）仍要在 `beforeEach` 里清掉——本套件有用例会真的落草稿，而 §7 的简报会带上
  "已有评审意见的元数据"，不清理就会让后一个用例的提示词长度取决于前一个用例是否写过草稿（这条在一次
  真实的排查里咬过一次）。断言本身分两类：用户消息/日志字符串用 `logger` 三个等级的 spy 读（spy 仍然
  调用真实实现，所以 debug 还是走 `forgejoToolkit.debug` 那道门），"不发任何请求"仍然只看 MSW。
  设置的写入由 mock 的 `getConfiguration().update` 记录并**回写**到夹具设置里，这样"选中 → 写进设置 →
  下一次运行不再问"是一条端到端断言，而不是只看函数被调用。
- **用户选择模型那部分（2026-10-01 维护者裁决后重写）**要求测试面覆盖：① 只要设置为空就弹选择列表
  （**包括只提供一个模型时**），每行的显示名、`vendor/family`、`id`、`maxInputTokens` 与提供者都断言；
  ② 选中后写入的是 `ConfigurationTarget.Global` 上的 `aiPreReviewModel = vendor/id`（两个模型共享
  family 时也必须匹配回同一个模型——这正是"写 id 不写 family"的回归测试）；③ 取消选择 ⇒ 零模型调用、
  零请求、零写入；④ 配置的取值没命中任何被提供模型 ⇒ 拒绝并列清单，**一次模型调用都不发**；
  ⑤ 选定的模型装不下指令 ⇒ 按两个数字拒绝，旁边那个预算更大的模型**一次都没被调用**；
  ⑥ **永不轮换**：多提供一个"能答对"的模型，让选定的那个连续失败两次，断言只有一个不同模型被调用过
  （`modelsCalled(...) === 1`）、消息里有"no other model was called"，并且错误消息指向换模型的命令；
  ⑦ 重试只发生在契约违规上，同一条提示词的**同一份字节**被发两次；硬失败 / 同意被拒 / 取消都只有一次调用。
  **探测命令的用例一条都不改**：它按"选定的模型 × 形态"各写一块，与运行的重试是两个互不相干的循环。
- **设置页那一行（2026-10-01 补）**要求测试面覆盖两半：① **宿主处理器**（
  `src/webview/__tests__/viewProviderDispatch.test.ts` 的 "AI pre-review chat model settings" 组）——
  每个被提供模型带着显示名 / `vendor` / `family` / `id` / `maxInputTokens` 与它会被写成的取值回来
  （`vendor/id` 优先，两个模型共享 family 时必须分开）、配置的当前值原样回来、`vscode.lm` 不存在 /
  `selectChatModels()` 抛错 / 空列表三种情况各给一句 `reason`、写入落在
  `ConfigurationTarget.Global` 的 `aiPreReviewModel` 上、非法形态**一个字节都不写**、写失败回 `error`，
  并且全程**没有任何模型的 `sendRequest` 被调用**（选模型是配置，不是使用）。这份文件用的是共享的
  `vscode` mock（没有 `lm` 字段），所以每个用例自己装上 `lm` 再还原，"没有语言模型 API"才是默认环境。
  ② **组件那一半**（`webview/src/views/__tests__/Settings.aiPreReviewModel.test.ts`）——选项从回复渲染、
  每项带提供者与预算、选中即写、写失败把下拉恢复成真正存着的值、空列表显示宿主的 `reason`、刷新会再请求
  一次，以及"配置值命中不了任何模型"时那一行会说明。`Settings.*.test.ts` 里其他用例的 `useAppState`
  mock 要补上这两个新函数（那一行在 `onMounted` 时就会读一次列表）。
- **诊断 dump 与探测那部分（2026-10-01 第三次排查补）要求测试面补四件事**：① dump 的纯格式与
  开关分开测：`src/__tests__/aiPreReviewDiagnostics.test.ts` 用真实临时目录断言"关闭时目录里
  什么都没有、没有文件路径"和"打开时文件里有 role + 逐字文本 + 完整回答 + 时间戳 + 自述头"，
  以及"写失败只回一行、绝不抛"；② `aiPreReview.test.ts` 里加一组 debug 开关用例：关闭时
  **零文件**且输出通道的行里没有回答文本，打开时文件里有指令那一半、简报与**完整**回答，
  失败的模型调用也留下 `answer chars: 0` 与失败原因；③ 探测命令测两处闸门（功能开关关闭、
  debug 关闭都**零 `sendRequest`**）、"只问被选定的那一个模型、每种形态都问到（设置为空或没命中时
  一次都不发）"，以及"同意被拒时只问一次就停"；④ 请求形态本身用一条
  测试锁住"`sendRequest` 收到的只有一个 `User` 消息，指令在前、请求在后"——否则一次重构就可能
  把契约放回可以被丢掉的那一条消息里。debug 开关在 `beforeEach` 里显式置为 `false`，因为
  `Logger` 缓存的是构造时读到的值，而断言"关闭时零文件"的用例必须真的在关闭状态跑。

### 9.6 调试诊断：dump 文件与模型探测（2026-10-01 第三次排查补）

**这一节是"回答正文不进输出通道"那条规则的唯一出口**：dump 与探测都只在 `forgejoToolkit.debug` 打开
时存在，形态被故意做得尽量窄（裁决与理由见 §7.2）；契约失败时的有界摘录规则同样写在 §7.2。原始测量
（"到底发了什么、到底回了什么"在默认路径上曾经无法回答）留在记录里。

- **文件与开关。** `src/aiPreReviewDiagnostics.ts` 的 `createAiPreReviewDiagnostics()` 接受
  "日志目录 + 是否开启"两个输入，**只有 `forgejoToolkit.debug` 打开时**才解析出文件路径：关闭时
  `filePath === undefined`，`section()` / `attempt()` 是彻底的空操作，"写错地方"在类型上都不可能。
  目录取 `context.logUri`（VS Code 的 "Open Logs Folder" 打开的就是它，先例是
  `src/mcpWriteSettings.ts` 的 `mcpWriteAuditFilePath`），文件名为常量
  `AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME = 'ai-pre-review-diagnostics.log'`；写入复用写工具审计那个
  有界 append（`appendMcpWriteAuditLine`，4 MB 一轮 + 1 个滚动副本），所以文件不会无限增长。
- **打开它的命令（2026-10-01 补）。** `forgejoToolkit.aiPreReviewOpenDiagnostics` 把
  `<logUri>/ai-pre-review-diagnostics.log` 在编辑器里打开（`workspace.openTextDocument` +
  `showTextDocument`）；文件不存在时说明"它只在 `forgejoToolkit.debug` 打开时写入"并点名该设置，
  宿主没有日志目录时同样明说，而不是报错或什么都不开。它**不受功能开关把关**（读本地文件不发任何
  内容），也不受 debug 把关——它恰恰要在诊断文件缺失时可被调用，所以只加 `contributes.commands`
  一条、不加带 `when` 的菜单项（与选模型的命令同形）。契约失败消息用它来回答"怎么拿到完整提示词与
  回答"。
- **一节一次调用，自述且逐字。** run 头一节写目标（`instance:owner/repo#index`）、两个开关、被提供的
  模型及其 `maxInputTokens`、尝试上限与请求形态；每次模型调用一节写被问模型的
  `vendor` / `family` / `id`、消息条数、**逐字的 role + 文本**（`--- message 1/1 role=user chars=N ---`
  标记，指令那一半在内）、请求与回答各自的时间戳与耗时、**完整原始回答**（含字符数）与 `outcome`
  一行（合规 JSON / 三类契约失败 / 模型调用失败 / 取消），默认路径那条有界形状描述作为 `note:`
  附在下面。每节都重复一句"本文件含提示词与模型原始输出、只在 debug 打开时写入"，因此单个滚动副本
  被单独发出来也仍然自述。
- **同一个模型被问两次时，两块要能区分（2026-10-01 第五次排查补；同日维护者裁决后标签口径已改）。**
  一次调用一节的**标签**同时写出两个计数：
  `attempt 1/2 for the chosen model (call 1 of at most 2 in this run)`——前者是"这是这个模型的第几次
  询问"，后者是"这是整次运行的第几次调用"。run 头的上限一行也写全
  （`attempt bound: at most 2 model call(s) per run — one chosen model, asked again only after a
contract violation; no other model is ever called`），另外一行写清**本次用的是哪个模型、这个选择
  从哪里来**（`model used by this run: … ; chosen from the setting "…" = "…"` 或 `… chosen from the
model the user picked just now (written into the setting)`），所以只拿到滚动副本的一节也能算出它处在
  哪。身份行本身在同一个模型的两块里完全一样，**只有标签能把它们分开**，这就是重试在 dump 里的证据形状。
- **写失败不改行为。** 追加失败只回一行 `onError`（调用方接到 `logger.error`），第一次之后不再重复；
  这一行只有路径与错误文本，永远不含提示词或回答。
- **探测命令。** `forgejoToolkit.aiPreReviewProbeChatModels`（`COMMAND_AI_PRE_REVIEW_PROBE`）：
  调色板条目的 `when` 要求**两个**设置同时打开
  （`config.forgejoToolkit.debug && config.forgejoToolkit.aiPreReview`，与入口一致），处理体另外
  再查一遍这两个设置，任一不满足就**一条模型请求都不发**。它**只问用户选定的那一个模型**：由
  `forgejoToolkit.aiPreReviewModel` 单独决定（`resolveAiPreReviewProbeTarget()`，与运行共用
  `findOfferedAiPreReviewModel()`，所以两个界面不可能对"当前是哪个模型"给出不同答案）——设置为
  **空**或命中不了任何被提供的模型时**一次都不发**，把"是空的"还是"值没命中"分开说清并列出被提供
  的模型，刻意**不**退化成"随便挑一个模型问"或"退回问全部"：两种都会把调用花在用户没有选择的
  模型上。问的是四种形态的同一句废话：单条 `User` 无指令（对照）、两条 `User`（旧形态）、单条
  `User` 含指令（新形态）、以及不带指令块的标点回声（`AI_PRE_REVIEW_PROBE_ECHO_PROMPT`）；判词是
  `answered exactly "{}" as asked` / `did NOT answer the requested "{}"`，回声形态另有布尔判词
  `answered the echo exactly as asked: true|false`。它不读 Pull Request、不发任何仓库内容；dump 头
  有两行（`models asked by this probe: …` 与 `why these models: the chosen model — …`），把"问了
  谁、为什么是它"写进文件本身；进度条文案是 `Asking the chosen chat model the same trivial
question…`。同意框被拒绝或取消时不重复问（失败经 `classifyModelError` 分类，与运行同一条路径，
  只把已完成的调用写进文件）。**探测不受运行的重试影响**：循环是"每个形态各一次"，写成
  `probe "<形态>"`，不读 `AI_PRE_REVIEW_MAX_*`，也不做第二次尝试——探测要回答的正是"一次调用会
  碰到什么"，把运行的重试掺进去会让它测的是别的东西。探测与运行写**同一个文件**，所以"探测一次 +
  预评审一次"两轮运行的证据可以在同一个文件里直接对照。
- **碎片边界也进输出通道（2026-10-01 第八次修正）。** 本节的 dump 保存的是**拼接后**的完整回答，
  有界摘录同样是拼接后的；**碎片边界本身**此前没有任何地方记录，而那正是"提供者的碎片本来就是坏的"
  与"我们的累积弄坏了它"之间唯一的分界。两条流循环现在各写**一行一个碎片**
  （`AI pre-review: answer fragment 3 of 8 in the stream: length=12, text="…"`，文本按失败摘录那套转义、
  同一个 200 字符上限、被截断时追加 `, cut from N characters`）加**一行小结**
  （`AI pre-review: answer stream summary: 8 fragment(s), 62 character(s), excerpt="…"`）。
  两条路、成功失败都写——它描述的是传输而不是裁决；**被取消或中途失败的流不写**（半读的流没有诚实的
  总数）。**严格由 `logger.isDebugEnabled()` 把关**，
  没有新设置，为假时一行都不交给 logger，消息/toast/通知一个字都不加，所以 debug 关闭时行为与今天
  逐字节相同（判据、理由与测试见记录开头那条修正）。

---

## 10. 分阶段落地计划与风险

阶段 0–4 已在同一次改动里全部落地，此后每一次验收与裁决都直接改在本文的各节里。当时的阶段划分、
每阶段的验收口径与测试清单原文留在记录的「从契约里移出的历史」一节。

---

## 11. 风险

### 11.1 风险与处置

| 风险                            | 影响                                       | 处置                                                                                                      |
| ------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 用户以为是"AI 已经评审过了"     | 草稿被无脑提交，等于自主维护               | 默认不勾选；提交入口不变；文案反复写"草稿、逐条确认"（§5）                                                |
| 送出去的简报里有不该外发的内容  | 隐私事故                                   | 送什么由用户选择（`aiPreReviewPromptScope`，默认 `ask` 时先问一次）；脱敏 URL/主机名；开关默认关闭（§7）  |
| 模型输出畸形、锚点乱指          | 评论文不对行，或直接被服务端拒绝           | §8 的全部校验；过不了就丢，绝不猜                                                                         |
| 追加到人手写的待提交评审        | AI 意见与人意见混在一起，无法分辨          | 运行前提示"将追加到 #N"；变体见 §13.3；PENDING 不是公开记录，风险有界（§6.3）                             |
| 部分失败留下半份草稿            | 用户以为没发生                             | §6.4 明确写出前 M-1 条保留 + 失败原因；不回滚                                                             |
| 无模型 / 无权限时的提示太笼统   | 用户以为扩展坏了                           | §9.3 分三种给提示，并指出该去装/登录什么，以及设置键在哪                                                  |
| 大 PR 超预算                    | 模型看到半份 diff 却以为完整，给出错误结论 | 按文件粒度丢弃并显式标注截断；`countTokens` 先核对（§7.2）                                                |
| 用户把"预评审"当成 MCP 工具去用 | 混淆两条写路径                             | 本功能**不是** MCP 工具，不注册进 `mcp/tools.ts`；工具面的写路径仍是 `submit_pull_review`（§13.3 的范围） |
| 模型给出"批准/要求修改"的结论   | 变成自动化决策                             | 本功能只产出**行级评论**，不产出评审结论；结论永远由人在「提交评审」里选（§2.1）                          |

---

## 12. 事实核对清单

**引用一律以符号名与标题为准**（行号会随在途改动漂移）。写作时为 HEAD `5da224b`。

| 断言                                                                                                                                                                        | 位置（符号 / 标题）                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR diff 打开与 `forgejo-pr` URI 的构造                                                                                                                                      | `packages/forgejo-toolkit/src/webview/viewProvider.ts` 的 `openPullRequestDiff` / `_buildDiffUri`                                                                                                                                                                                                                                                                            |
| diff 视图的上下文键与菜单把关                                                                                                                                               | `src/comments/pullReviewCommentController.ts` 的 `CONTEXT_IN_PR_DIFF`；`package.json` 的 `contributes.menus` 的 `editor/context` / `editor/lineNumber/context`                                                                                                                                                                                                               |
| 单飞标记的既有写法                                                                                                                                                          | `src/commands/index.ts` 的 `publishToForgejoInFlight` / `createPrFromCurrentBranchInFlight`                                                                                                                                                                                                                                                                                  |
| 命令按 URI 找编辑器、回退活动编辑器                                                                                                                                         | `src/commands/index.ts` 里 `COMMAND_ADD_COMMENT` 的处理体（同文件的 `sameDocumentUri` / `toLineNumber`）                                                                                                                                                                                                                                                                     |
| 草稿评论的创建 / 追加 / 提交 / 取消                                                                                                                                         | `src/comments/pullReviewCommentPanel.ts` 的 `_handleSubmitPullReviewComment` / `_handleSubmitPullReview` / `_handleDeletePullReview`                                                                                                                                                                                                                                         |
| "继续评审"如何找到既有 PENDING 评审                                                                                                                                         | `src/comments/pullReviewCommentController.ts` 的 `addComment`（`state === 'PENDING' && user.login === instance.username`）                                                                                                                                                                                                                                                   |
| `pendingReviewId` 只来自宿主上下文                                                                                                                                          | 同上文件的 `_captureTarget`（注释说明 webview 上报值只当一致性信号）                                                                                                                                                                                                                                                                                                         |
| 待提交评审必须有非空正文（占位 `.`）                                                                                                                                        | `src/api/client.ts` 的 `createPendingPullReview`                                                                                                                                                                                                                                                                                                                             |
| 提交 / 追加 / 删除草稿的客户端方法                                                                                                                                          | 同上文件的 `submitPullReview` / `addPullReviewComment` / `deletePullReview` / `deletePullReviewComment`                                                                                                                                                                                                                                                                      |
| `event` 的三种取值与 `APPROVED` 拼写                                                                                                                                        | `src/comments/pullReviewCommentPanel.ts` 的 `_handleSubmitPullReview`；`shared/webview/messages.ts` 的 `PullReviewSubmitEvent`                                                                                                                                                                                                                                               |
| 行号是 1-based file line，`position`/`original_position` 的侧                                                                                                               | `src/comments/reviewCommentPosition.ts` 的 `resolveReviewCommentLine`                                                                                                                                                                                                                                                                                                        |
| 写侧 `old_position` / `new_position` / `extra_lines_count`                                                                                                                  | `src/comments/pullReviewCommentPanel.ts` 的 `_handleSubmitPullReviewComment`                                                                                                                                                                                                                                                                                                 |
| diff 行号表与"必须落在 diff 内"的判定                                                                                                                                       | `src/utils/parseDiff.ts` 的 `parsePullDiff`；`src/comments/pullReviewCommentController.ts` 的 `addComment`                                                                                                                                                                                                                                                                   |
| 简报的预算与截断口径（复用对象）                                                                                                                                            | `mcp/tools.ts` 的 `PR_REVIEW_BRIEF_BUDGET` / `PR_REVIEW_DIFF_BUDGET` / `PR_REVIEW_COMMENT_BUDGET` / `PR_REVIEW_MAX_DIFF_FILES` / `PR_REVIEW_MAX_COMMENTS` / `PR_REVIEW_MAX_COMMENT_LENGTH`                                                                                                                                                                                   |
| 工具结果的两道长度上限                                                                                                                                                      | 同上文件的 `MAX_TOOL_TEXT_LENGTH` / `MAX_TOOL_RESULT_LENGTH`                                                                                                                                                                                                                                                                                                                 |
| 路径段校验的既有写法                                                                                                                                                        | 同上文件的 `pathSegmentSchema` / `isSafePathSegment`                                                                                                                                                                                                                                                                                                                         |
| 可选 `vscode.lm` API 的降级写法                                                                                                                                             | `src/mcpServerProvider.ts` 的 `registerMcpServerProvider`（`vscode.lm?.registerMcpServerDefinitionProvider` + `typeof … === 'function'`）                                                                                                                                                                                                                                    |
| 该降级路径的测试                                                                                                                                                            | `src/__tests__/mcpServerProvider.test.ts` 的 "skips registration on an editor without the MCP definition API instead of failing activation"                                                                                                                                                                                                                                  |
| `vscode` 的整模块 mock（当前没有 `lm` 字段）                                                                                                                                | `src/__tests__/extension-setup.ts`（`vi.mock('vscode', …)`）、`vitest.extension.config.mts`                                                                                                                                                                                                                                                                                  |
| 设置读取"读不到即关闭"的先例                                                                                                                                                | `src/mcpWriteSettings.ts` 的 `enabledMcpWriteTools` / `isMcpWriteAuditToFileEnabled`                                                                                                                                                                                                                                                                                         |
| 设置项 / manifest 文案的双语要求                                                                                                                                            | `package.json` 的 `contributes.configuration`；`package.nls.json` 与 `package.nls.zh-cn.json`                                                                                                                                                                                                                                                                                |
| 宿主文案的 l10n 两文件                                                                                                                                                      | `packages/forgejo-toolkit/l10n/bundle.l10n.json` 与 `bundle.l10n.zh-cn.json`                                                                                                                                                                                                                                                                                                 |
| i18n 平价测试（键、占位符、可达性）                                                                                                                                         | `src/webview/__tests__/i18nParity.test.ts`                                                                                                                                                                                                                                                                                                                                   |
| "设置项必须已 contribute"的断言写法                                                                                                                                         | `src/__tests__/leasePollingGuards.test.ts`                                                                                                                                                                                                                                                                                                                                   |
| 评审全流程的 MSW mock（pending 语义）                                                                                                                                       | `src/test/mocks/handlers.ts`（`pendingReview` 的创建 / 追加 / 提交 / 删除）                                                                                                                                                                                                                                                                                                  |
| `vscode.lm` **没有**"当前选中 / 最近使用"的读数，`selectChatModels` 不承诺顺序                                                                                              | 同上类型的 `ChatRequest.model`（只在 `ChatRequestHandler` 参数里）、`LanguageModelAccessInformation`（`onDidChange` / `canSendRequest`）、`LanguageModelChatSelector`、`lm.selectChatModels`                                                                                                                                                                                 |
| ~~窗口级的"曾给出合规回答"记忆与尝试排序~~（2026-10-01 维护者裁决后**已删除**，保留此行的目的是说明它确实不在了）                                                           | `src/aiPreReview.ts` 里**不再有** `contractSatisfyingModelKeys` / `orderAiPreReviewCandidates` / `resetAiPreReviewModelMemory`（可搜索确认）                                                                                                                                                                                                                                 |
| 用户选择的模型：取值形态、解析与匹配（`vendor/family` / `vendor/id` / `@version`）                                                                                          | `src/aiPreReviewSettings.ts` 的 `AI_PRE_REVIEW_MODEL_SETTING` / `parseAiPreReviewModelSelector` / `matchesAiPreReviewModelSelector` / `AI_PRE_REVIEW_MODEL_SELECTOR_FORMS` / `aiPreReviewModelSettingValue`                                                                                                                                                                  |
| 一个"被提供模型"的读取、命名、去重与预算（运行侧与设置页共用的那一份答案）                                                                                                  | `src/aiPreReviewModels.ts` 的 `aiPreReviewModelIdentity` / `formatAiPreReviewModelIdentity` / `aiPreReviewModelKey` / `uniqueAiPreReviewModels` / `maxInputTokensOf` / `queryAiPreReviewChatModels`                                                                                                                                                                          |
| 设置页里的模型选择：下拉内容、刷新、空列表原因、写入与写失败                                                                                                                | 同上文件的 `listAiPreReviewChatModelChoices` / `isStorableAiPreReviewModelSettingValue`；`src/webview/viewProvider.ts` 的 `getAiPreReviewChatModels` / `setAiPreReviewChatModel`；`shared/webview/messages.ts` 的 `AiPreReviewChatModelOption` / `aiPreReviewChatModels` / `aiPreReviewChatModelSaved`；`webview/src/views/Settings.vue` 的 `settings.aiPreReviewModel` 一行 |
| 同一选择的三个入口（设置字段 / 命令 / 设置页）与"manifest 字段做不成动态下拉"                                                                                               | `package.json` 的 `contributes.configuration`（`forgejoToolkit.aiPreReviewModel` 是自由文本）；`src/aiPreReviewSettings.ts` 的 `AI_PRE_REVIEW_MODEL_SETTING`；`src/aiPreReview.ts` 的 `chooseAiPreReviewModel`；`webview/src/views/Settings.vue` 的下拉                                                                                                                      |
| 选择写进设置（全局配置更新）与"能写回"的取值形态                                                                                                                            | 同上文件的 `writeAiPreReviewModelSetting` / `formatAiPreReviewModelSettingValue`（`vendor/id` 优先）                                                                                                                                                                                                                                                                         |
| 配置的值没命中任何被提供模型即拒绝并列清单（不再传给 API、不再排序）                                                                                                        | `src/aiPreReview.ts` 的 `findOfferedAiPreReviewModel` / `describeOfferedAiPreReviewModels` / `reportAiPreReviewModelRefusal`（`runAiPreReview` 里按 `aiPreReviewModelSettingValue()` 分支）                                                                                                                                                                                  |
| 运行时模型选择：QuickPick 的内容（全部被提供模型）、写入设置、取消口径                                                                                                      | 同上文件的 `pickAiPreReviewModel` / `rememberChosenAiPreReviewModel` / `reportModelChoiceDismissed` / `chooseAiPreReviewModel`                                                                                                                                                                                                                                               |
| 换模型的命令（注册、贡献、双语标题、不受功能开关把关）                                                                                                                      | 同上文件的 `COMMAND_AI_PRE_REVIEW_CHOOSE_MODEL` / `registerAiPreReviewCommand`；`package.json` 的 `contributes.commands`；`package.nls.json` 与 `package.nls.zh-cn.json` 的 `command.aiPreReviewChooseModel.title`                                                                                                                                                           |
| 只做校验、绝不替换：指令提示词放不下 / 量不出来时按数字拒绝                                                                                                                 | 同上文件的 `validateChosenAiPreReviewModel` / `reportInstructionBudgetFailure` / `reportChosenModelNotMeasurable` / `chooseModelActionHint`                                                                                                                                                                                                                                  |
| 契约失败的三分（空 / 非 JSON / 形状错在哪个字段）                                                                                                                           | `src/aiPreReviewBrief.ts` 的 `parseAiPreReviewResponse`（`AiPreReviewContractFailure`）                                                                                                                                                                                                                                                                                      |
| 契约失败的重试上限（**一个**模型最多 2 次 = 最多 2 次调用）                                                                                                                 | `src/aiPreReview.ts` 的 `AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL` / `gatherPreReviewRequest`（单层循环）                                                                                                                                                                                                                                                                        |
| 每次调用的尝试编号（该模型第几次 / 整次运行第几次）与失败/成功时的调用数                                                                                                    | 同上文件的 `gatherPreReviewRequest`（`label: attempt n/2 for the chosen model (call m of at most 2 in this run)`）、`AiPreReviewModelAttempt.attempt` / `describeFailedAttempts` / `reportContractFailures`                                                                                                                                                                  |
| 有界形状描述（长度 / 是否 `{` 开头 / 首行前 60 字符；debug 级）                                                                                                             | `src/aiPreReviewBrief.ts` 的 `describeAiPreReviewAnswerShape` / `AI_PRE_REVIEW_ANSWER_PREFIX_LENGTH`                                                                                                                                                                                                                                                                         |
| 失败行里的有界摘录（契约违规时始终写：≤200 字符、`JSON.stringify` 转义成一行；成功时一个字都不写）                                                                          | `src/aiPreReviewBrief.ts` 的 `aiPreReviewAnswerExcerpt` / `AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH`；`src/aiPreReview.ts` 的 `contractFailureLogLine` / `reportContractFailures` / `diagnosticsActionHint`                                                                                                                                                                       |
| 打开诊断文件的命令（不受功能开关把关；文件不存在时点名 `forgejoToolkit.debug`）                                                                                             | `src/aiPreReview.ts` 的 `COMMAND_AI_PRE_REVIEW_OPEN_DIAGNOSTICS` / `openAiPreReviewDiagnostics`；`package.json` 的 `contributes.commands`；`package.nls.json` 与 `package.nls.zh-cn.json` 的 `command.aiPreReviewOpenDiagnostics.title`                                                                                                                                      |
| 请求形态：一条 `User` 消息装指令与请求（2026-10-01 改）                                                                                                                     | `src/aiPreReviewBrief.ts` 的 `buildAiPreReviewPromptMessages` / `aiPreReviewPromptText` / `AiPreReviewPromptMessage`                                                                                                                                                                                                                                                         |
| 预算按"真正发出的那段文本"计一次                                                                                                                                            | `src/aiPreReview.ts` 的 `countRequestTokens`（`preparePrompt` 与 `validateChosenAiPreReviewModel` 都走它）                                                                                                                                                                                                                                                                   |
| 调试 dump：文件名、开关、格式与有界写入                                                                                                                                     | `src/aiPreReviewDiagnostics.ts` 的 `createAiPreReviewDiagnostics` / `formatAiPreReviewDiagnosticsAttempt` / `formatAiPreReviewDiagnosticsSection` / `AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME`                                                                                                                                                                                    |
| dump 的接线与 run 头事实                                                                                                                                                    | `src/aiPreReview.ts` 的 `createRunDiagnostics` / `gatherPreReviewRequest`（每次调用一节）                                                                                                                                                                                                                                                                                    |
| 日志目录的先例（`context.logUri` + 有界 append）                                                                                                                            | `src/mcpWriteSettings.ts` 的 `mcpWriteAuditFilePath`；`src/mcpWriteAudit.ts` 的 `appendMcpWriteAuditLine`                                                                                                                                                                                                                                                                    |
| 模型探测命令：只问用户选定的那一个模型（2026-10-01 改）、两个闸门、四种形态、同一句问话                                                                                     | `src/aiPreReview.ts` 的 `COMMAND_AI_PRE_REVIEW_PROBE` / `probeAiPreReviewChatModels` / `resolveAiPreReviewProbeTarget` / `findOfferedAiPreReviewModel` / `aiPreReviewProbeShapes` / `AI_PRE_REVIEW_PROBE_PROMPT`；`package.json` 的 `contributes.menus.commandPalette` 里 `config.forgejoToolkit.debug` 那一项                                                               |
| dump 与探测的测试                                                                                                                                                           | `src/__tests__/aiPreReviewDiagnostics.test.ts`；`src/__tests__/aiPreReview.test.ts` 的 "the debug diagnostics dump" / "the chat model probe" / "the request shape" / "the bounded retry of the chosen model" 四组                                                                                                                                                            |
| 有界摘录的测试（debug 关闭时的短碎片与长回答、200 字符上限、转义与单行、成功时无回答文本、不泄露 diff/简报/提示词）                                                         | `src/__tests__/aiPreReview.test.ts` 的 "the contract failure is diagnosable (§8.1, §9.3)" 组                                                                                                                                                                                                                                                                                 |
| debug 下的碎片清单与小结（一行一个碎片、一行两个总数与有界开头；两条流循环都写；关闭时一行都没有）                                                                          | `src/aiPreReview.ts` 的 `logAnswerFragments` / `answerFragmentLogLine` / `answerStreamSummaryLogLine`；`src/aiPreReviewBrief.ts` 的 `aiPreReviewAnswerExcerpt` / `AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH`；测试见 `src/__tests__/aiPreReview.test.ts` 的 "the debug-only fragment log of a streamed answer" 组                                                                  |
| debug 下的 part 清单与小结（一行一个 part：序号/运行时类名/长度/内容，tool-call 写工具名与 JSON input，其余有界检查；一段流一行 kind 计数；解析结果不变；关闭时一行都没有） | `src/aiPreReview.ts` 的 `logResponseStreamParts` / `responsePartLogLine` / `responseStreamSummaryLogLine` / `responsePartKind` / `runtimeClassName` / `inspectPartShape`；测试见 `src/__tests__/aiPreReview.test.ts` 的 "the debug-only parts log of a response stream" 组                                                                                                   |
| 诊断文件命令的测试（文件在时打开、文件不在时点名设置、无日志目录、注册与贡献、不受开关把关）                                                                                | 同上文件的 "the diagnostics-file command" 组                                                                                                                                                                                                                                                                                                                                 |
| 用户选择模型的测试（每次都问 / 写入设置 / 取消零调用 / 拒绝 / 绝不轮换）                                                                                                    | `src/__tests__/aiPreReview.test.ts` 的 "the model pick (§7.2)" / "choosing the model later (COMMAND_AI_PRE_REVIEW_CHOOSE_MODEL)" / "the chosen model is validated, never substituted (§7.2)" 三组                                                                                                                                                                            |
| 设置页那一行的测试（宿主处理器 + 组件）                                                                                                                                     | `src/webview/__tests__/viewProviderDispatch.test.ts` 的 "AI pre-review chat model settings" 组；`webview/src/views/__tests__/Settings.aiPreReviewModel.test.ts`                                                                                                                                                                                                              |
| `@types/vscode` 1.102.0 里**没有** system 角色（枚举只有 `User` / `Assistant`，类只有这两个工厂）                                                                           | 同上类型的 `LanguageModelChatMessageRole` / `LanguageModelChatMessage`；官方指南 「Language Model API」 的 "Build the language model prompt" 一节（"doesn't support the use of system messages"）                                                                                                                                                                            |
| 非 Copilot provider 如何收到消息（`role` + content parts，自行转换角色）                                                                                                    | 官方指南 "Language Model Chat Provider API" 的 "Message format and conversion" 一节（`LanguageModelChatRequestMessage` 与示例 `convertMessages`）                                                                                                                                                                                                                            |
| debug 日志的既有开关                                                                                                                                                        | `src/logger.ts` 的 `Logger.debug` / `forgejoToolkit.debug`                                                                                                                                                                                                                                                                                                                   |
| 提示词范围：五个取值、`ask` 的 fail-closed 模态框与写回设置                                                                                                                 | `src/aiPreReviewSettings.ts` 的 `AI_PRE_REVIEW_PROMPT_SCOPE` / `aiPreReviewPromptScope`；`src/aiPreReview.ts` 的 `askAiPreReviewPromptScope`                                                                                                                                                                                                                                 |
| 确认面板的宿主半边（一次只开一个面板、逐条重校验、整批拒绝、取消口径）                                                                                                      | `src/aiPreReviewPanel.ts` 的 `AiPreReviewPanel` / `selectPanelEntries` / `aiPreReviewPanelCreate` / `aiPreReviewPanelRejected`；`shared/webview/messages.ts` 的 `AiPreReviewPanelSelectedBody`                                                                                                                                                                               |
| 确认面板的组件（完整正文、默认零勾选、编辑与恢复原文、Create 计数）                                                                                                         | `webview/src/AiPreReviewPanel.vue`；`webview/src/entries/aiPreReview.ts`；`webview/aiPreReview.html`                                                                                                                                                                                                                                                                         |
| 正文语言：`forgejoToolkit.locale` 优先、否则显示语言，指令块按语言构建一次                                                                                                  | `src/aiPreReviewBrief.ts` 的 `buildAiPreReviewSystemPrompt` / `aiPreReviewBodyLanguageName` / `aiPreReviewCommentBodyLanguage`；`src/utils/resolveLocale.ts` 的 `resolveLocale`                                                                                                                                                                                              |
| 答案从响应流的候选通道取：分类、两股候选与契约仲裁、`text` 兜底、单消费者与 debug 选择行                                                                                    | `src/aiPreReview.ts` 的 `classifyResponsePart` / `collectResponseStreamParts` / `readTextProjection` / `readResponseCandidates` / `pickResponseCandidate` / `responseCandidateSelectionLogLine`                                                                                                                                                                              |
| PR 详情页入口：webview 消息、坐标校验与同一个 runner                                                                                                                        | `src/webview/viewProvider.ts` 的 dispatch；`src/webview/repoIdentity.ts` 的 `parseWebviewPullRequestTarget`；`src/aiPreReview.ts` 的 `setAiPreReviewRunner` / `runAiPreReview`                                                                                                                                                                                               |
| 本套件自己的 MSW 状态清理                                                                                                                                                   | `src/__tests__/aiPreReview.test.ts` 的 `beforeEach`（`resetMockState()`，来自 `src/test/mocks/handlers.ts`）                                                                                                                                                                                                                                                                 |
| `vscode.lm` 的类型面（`selectChatModels` / `sendRequest` / `countTokens` / `maxInputTokens` / `LanguageModelError`）                                                        | `@types/vscode` 1.102.0 的 `index.d.ts`（`LanguageModelChat` / `LanguageModelChatMessage` / `LanguageModelChatResponse` / `namespace lm`）                                                                                                                                                                                                                                   |
| 引擎底线                                                                                                                                                                    | `packages/forgejo-toolkit/package.json` 的 `engines.vscode`                                                                                                                                                                                                                                                                                                                  |
| 宿主侧用 `vscode.lm` 而不是 MCP sampling 的方向                                                                                                                             | [`../architecture/mcp-server.md`](../architecture/mcp-server.md) 的「Security model」一节末段                                                                                                                                                                                                                                                                                |
| Codeberg 约束与"人类维护信号"                                                                                                                                               | `AGENTS.md` 的「Codeberg hosting and resource usage」一节、`CONTRIBUTING.md` 开头                                                                                                                                                                                                                                                                                            |
| 写侧先例（默认关闭 + 逐次确认 + 不做自动 approve）                                                                                                                          | [`mcp-write-tools-confirmation.md`](./mcp-write-tools-confirmation.md)（其 §3.6 即该先例）                                                                                                                                                                                                                                                                                   |
| "代码会发给模型供应商、加默认关闭开关"的既有判断                                                                                                                            | `TODO.md` 的「P2 PR 描述生成的行级 diff」条目                                                                                                                                                                                                                                                                                                                                |

---

## 13. 留给维护者的决定

**这一节的问题只有维护者能回答；本节之外的内容是我按仓库既有取向定下的决定**（写在各节里，
并在 §2 汇总）。每条都给了我的建议与理由，供裁决时参考。**维护者已于 2026-09-29 逐条裁决**，
结论就地写在每条里；实现与交付记录见记录开头的「交付记录」与 `docs/design/README.md` 的索引行。

1. **送给模型供应商的内容边界**（§7.1）。三个选项：
   (a) 默认只送"简报"（文件路径、增删行数、已有意见的元数据），diff 正文要第二个开关；
   (b) 一个开关同时打开简报与 diff 正文；(c) 默认就送 diff 正文。
   ~~**建议 (a)**~~ **裁决：取 (a)，第二个开关为窗口级**（`forgejoToolkit.aiPreReviewIncludeDiff`，
   默认 `false`）——本项目现有设置全是窗口级，不开按实例的先例。理由见 §7.1。（**后续取代**：这个
   布尔已被 `forgejoToolkit.aiPreReviewPromptScope` 取代并从 manifest 删除，见 §7.1。）
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
   命名一旦发布就是对外契约，本轮定稿。**2026-10-01 修正**：`when` 在
   `forgejoToolkit.inPullRequestDiff` 之外还要与 `config.forgejoToolkit.aiPreReview` 相与——开关关掉时
   不显示入口，理由与实现见记录开头那条修正；挂的位置与命令命名不变。（**后续取代**：
   `editor/context` 那条贡献后来删除，入口只剩 `editor/title` 与 PR 详情页的按钮，见 §6.1。）
7. **本次改动是否要附带一个 changeset**：**裁决：设计记录本身不补**（写作时它不改任何用户可见
   行为，也已随记录一起落地）；**这次实现是用户可见的，因此带自己的 changeset**。
   **2026-10-01 的修正没有新开 changeset**：功能尚未发布，`.changeset/ai-pre-review.md` 就是它
   唯一的发布说明，重试与失败诊断写进同一条（上一批交付后修正也是这么处理的）。第五次排查
   （按模型的重复询问、"花掉几次调用"的报数、`FEATURES.md` 与两份 `CHANGELOG` 的同步）同样只改
   这一条，不新开 changeset。**维护者关于"模型由用户选择"的裁决也只改这一条**：同一份未发布的
   changeset 里把"自动选择 / 跨模型轮换 / 窗口记忆"的句子换掉，两份 `CHANGELOG` 与之同步。
   **2026-10-02：六条迭代 changeset 合并回唯一一条**——本次交付的六个改动（回答取自 stream part、
   提示词范围、确认面板、创建前编辑正文、正文语言、入口移到 PR 详情页）此前各自开了一份
   `.changeset/ai-pre-review.md` 之外的 changeset 文件；它们是同一个**从未发布**功能的迭代，各自成条
   只会在发布说明里把同一件事重复六遍，所以内容全部并入 `.changeset/ai-pre-review.md`（包名与 bump
   级别不变，仍是 `forgejo-toolkit: minor`），那六份文件删除。记录开头各条修正里"这条改动自己的
   changeset"的说法，自本条起一律指这唯一一份文件，正文按功能当前的样子重写。
8. **文档同步要动哪些文件**（阶段 4 交付时）：**裁决**：`FEATURES.md`（一条能力）、
   `TODO.md`（本条目移出、只留未做的部分）、两份 `CHANGELOG`（字节一致）、本记录与
   `docs/design/README.md` 的状态列。README / FAQ 本轮不动。
9. **"谁来选模型"**（§7.2）：**维护者已裁决（2026-10-01）：用户选，扩展不选、不换。** 空设置 =
   运行时问一次并把答案写进 `forgejoToolkit.aiPreReviewModel`，非空 = 每次都用它；跨模型轮换、
   按历史排序、按预算挑选与窗口记忆全部删除；留下的只有校验（报数字、不替换）。实现口径写在
   §7.2 与记录开头那条修正里。
