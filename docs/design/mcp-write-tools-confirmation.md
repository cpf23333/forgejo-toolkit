# MCP Phase 2 写工具的确认模型

- 状态：**设计已定稿，首批两个工具与第二批的第一个候选均已交付**——2026-09-28 维护者已裁决 §13 的全部十个问题
  （§13 因此从「开放问题」改写为决定记录）；阶段 0（按工具的开关 + 注解骨架 + 来源标记）、
  阶段 1（`create_issue_comment`）与阶段 2（`submit_pull_review`）都已按本文落地，第二批的第一个
  候选 `cancel_action_run`（§4.1、§13.3）也已于 **2026-09-28** 交付并带自己的开关，交付记录见
  `FEATURES.md` 的「已完成」「MCP Server」一节，实现现状见
  [`docs/architecture/mcp-server.md`](../architecture/mcp-server.md) 的 「Write tools」 一节。**仍开放**的只剩
  `rerun_action_run` 的版本闸门（等 Forgejo ≥ 17，见 `TODO.md` 的「等上游版本」条目）；原先列为
  "可选、需单独批准"的**阶段 3（broker 会话的宿主侧模态框）已于 2026-10-02 决定不做**，理由与
  三条前置条件保留在同名小节「§9 阶段 3 决定不实现」里。本文其余部分仍按写作时的基线描述
  （设计文档只指向跟踪条目，不持有待办项的唯一副本）
- 关联：`TODO.md` 的「AI / MCP 规划」条目；`docs/architecture/mcp-server.md` 见
  [MCP Server Integration](../architecture/mcp-server.md) 的 「Security model」 与
  「Future directions」 两节
- 适用范围：MCP 工具面里所有会改服务端状态的工具（创建评论、提交 review、以后可能的创建 issue / 合并 PR / 重跑 workflow 等）
- 基线代码：写作时为 HEAD `b14d764`；2026-09-27 的复核重开了**实现侧**的断言并把位置改成
  **符号名 / 标题**（见「§12 事实核对清单」），上一轮留下的行号没有逐条复查，已不再作为断言依据

> 相对引用说明：仓库内路径都从仓库根写起。工作树里有其他 agent 的在途改动，行号会漂移，
> 所以每条断言都给出**可搜索的标识符 / 代码片段**；**以标识符为准**，行号只用于加速定位。
> 核对方式见「§12 事实核对清单」。

---

## 1. 问题

Phase 1 的 MCP 工具面**全部只读**，而且这个"只读"不只是约定，是从三条相互独立的机制上钉住的：

1. `mcp/tools.ts:1614`（`const readOnly = {...}`）定义了一个共享注解并施加到每一个工具上：
   `const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };`
   （30 处 `annotations: readOnly`）。
2. `mcp/__tests__/server.test.ts:55-103` 把这条性质**锁死**：对 `tools/list` 返回的每一个工具断言
   `tool.annotations?.readOnlyHint === true`，并断言工具名集合恰好 30 个。
3. `docs/architecture/mcp-server.md` 的「Security model」一节写明：标了 `readOnlyHint` 的工具 VS Code
   **不会**逐次弹确认框，所以"人在环内"的保证完全由工具面本身承担（每个工具都映射到 `GET`，
   唯一例外是 `get_workspace_repository`——它不发任何请求，只读扩展发布在本地的工作区状态文件）。

Phase 2 要加写工具，第 1、3 条同时失效：只要有一个工具不标 `readOnlyHint`，第 2 条测试必须改成
"按工具分类断言"，而"人在环内"就必须由新的机制补回来。

这里有一个容易被忽略的前提差异，它是整篇设计的地基：

| 启动路径                                                                                                                                | 谁创建 MCP server                                                                      | 进程里有 `vscode` 吗 | 能弹 VS Code 对话框吗           |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------- | ------------------------------- |
| VS Code 按 `contributes.mcpServerDefinitionProviders` 拉起（provider 注册点 `src/mcpServerProvider.ts` 的 `registerMcpServerProvider`） | `out/mcp-server.mjs` 子进程（`mcp/server.ts` 的 `main()`）                             | 没有                 | **不能**                        |
| 静态 `mcp.json` 经 shim → broker（`mcp/server.ts` 的 `main()` 转发分支）                                                                | **扩展宿主进程**（`src/mcpBroker.ts` 的 `createBrokerMcpServer` 调 `createMcpServer`） | 有                   | **可以，但默认不做**（见 §3.4） |
| 静态 `mcp.json`，扩展宿主不在（`mcp/server.ts` 的匿名分支）                                                                             | 子进程，匿名                                                                           | 没有                 | 不能                            |

**第一行还有一层前提（2026-09-27 核对，必须与"能弹对话框吗"一起读）：** 扩展提供的 definition
只在**扩展宿主的 broker 可达**时才会发布——`src/mcpServerProvider.ts` 的
`provideMcpServerDefinitions` 在 `mcpBrokerIsReachable(...)` 为假时**返回空数组**并记一条 info
（"an extension-provided definition carries no token of its own"）。这是 `docs/architecture/mcp-server.md`
的「Architecture」一节写明的行为：没有可达 broker 时定义解析整体不产出，静态 `mcp.json` 路由则照旧
降级为匿名只读。也就是说第一行那台"能拉起子进程"的前提，本身就是"宿主还在跑"。

也就是说：**"无头 MCP 子进程弹不了 VS Code 确认框"对第一条路径是永久事实，对第二条路径只是当下
策略。** 但第三条路径决定了本设计的下限——那时连 token 都没有。

---

## 2. 决策（摘要）

1. **人类确认是默认行为，不是可选项。** 不标 `readOnlyHint`、不标 `destructiveHint: false`，
   让 VS Code 的逐次工具审批成为第一道闸门；写工具**另外**要求逐项显式开启的设置开关（默认
   全部关闭），这是第二道闸门。两道闸门都通过才可能发出写请求。
2. **不发明的 token 一律拒绝。** 只有在"由扩展宿主自己发起"的会话里（扩展提供的 definition，或
   静态 `mcp.json` 转发进来的 broker 会话），写工具才可用；无法证明
   这一点时（无 broker 的匿名子进程、只带用户手写明文 token 的静态配置）写工具**返回拒绝并
   说明原因**，绝不降级为匿名、也绝不去读磁盘上的 token。注意 token 本身**不再随 `env` 下发**
   （见 §5）：宿主判据是"这个会话是不是本宿主建立的"，不是"子的环境里有没有凭据"。
3. **首批只做两个工具**：`create_issue_comment`、`submit_pull_review`。
   "重跑 workflow"**在本仓库当前依赖下无法实现**（§4.1，`swagger.v1.json` 里没有该端点，
   `KNOWN_ISSUES.md` 的「Re-running an action run is not exposed through the REST API」条目已把它记为平台限制），推迟到依赖 Forgejo ≥ 17 的版本闸门。
   2026-09-28 定稿：保留这两个下划线名（否决 `add_issue_comment`，§13.7），`cancel_action_run`
   **不在首批**（它是第二批的第一个候选，§13.3）。
4. **dry-run 值得做**，但只作为工具参数（`dryRun`），不作为第三种运行模式；默认 `false`，
   工具描述要求 agent 在批量提交前先跑一次 dry-run 并把计划念给用户。（2026-09-28 定稿：
   它**不需要**单独开关，§13.9。）
5. **审计**默认落在 `Forgejo Toolkit` Output Channel：调用方、实例、仓库、目标编号、正文字节数与
   摘要哈希、结果、耗时。**不落**评论正文全文。2026-09-28 的决定追加：新增**窗口级**布尔设置
   `forgejoToolkit.mcpWriteAuditToFile`（默认 `false`，所以默认行为就是"只进 Output Channel"），
   打开后把**同一条记录**以 JSON Lines **追加**到扩展 `context.logUri` 下的
   `mcp-write-audit.jsonl`，并在通道里打印一行指明该路径；1 MB 上限 + 两个滚动文件（§8、§13.5）。

---

## 3. 为什么无头子进程弹不了确认框，以及有哪些可用的杠杆

### 3.1 事实

- 子进程是 `process.execPath` 起的普通 Node 进程（`src/mcpServerProvider.ts` 的
  `provideMcpServerDefinitions` 里 `new vscode.McpStdioServerDefinition(...)`），入口
  `mcp/server.ts`，只与 stdio 说话（同文件的 `main()`）。它没有 `vscode` 模块，构建期还有一道
  硬约束：构建期的 chunk 图检查会在任何从 mcp 入口可达的 chunk 引入 `vscode` 时**让构建失败**
  （`docs/architecture/mcp-server.md` 的「Architecture」一节）。
- 它的诊断输出只能走 stderr（`mcp/server.ts` 顶部的日志注释），stdout 是协议帧。
- 因此"在工具处理函数里 `vscode.window.showWarningMessage`"这条最自然的路，在子进程里是**不可
  达**的语法级不可能，而不是"没写"。

### 3.2 杠杆一：不标 `readOnlyHint`，把审批交给 VS Code

MCP 的 `ToolAnnotations` 是提示位，不是保证。VS Code 用 `readOnlyHint` 决定只读工具是否**跳过**
逐次审批；本仓库目前正是靠这一点实现"只读工具不弹框"
（`docs/architecture/mcp-server.md` 的「Security model」一节）。反过来，一个既无 `readOnlyHint` 也无
`destructiveHint: false` 的工具就落回"每次调用都要用户批准"的默认路径。

- **本设计依赖**：写工具不设 `readOnlyHint`，也**不**设 `destructiveHint: false`。写工具是
  创建评论/提交 review，语义上是"外部可见的持久副作用"，MCP 规范里 `destructiveHint: false`
  的含义是"只做追加、不破坏已有数据"——用它去换更宽松的提示是错的方向，而且它只在
  `readOnlyHint: false` 时才被解读，容易误导客户端。
- **这条依赖的证据状态（2026-09-27 核对）**：它不再是推断，也不再需要"先做点击实测才能开工"。
  官方 MCP 开发者指南正面写着"未标 `readOnlyHint` 的工具都会显示确认对话框"、注解一节写着
  "VS Code 不询问只读工具"，Language Model Tool 指南补充存在 "Always Allow"（引文与链接见
  §11.1）。因此 §9 阶段 1/2 **不以本机实测为门槛**；一次 dev host 点击实测降级为"顺手做一次"
  的一致性抽查，只在它与文档冲突时才升级为阻塞项（那时以实测为准，见 §11.1）。
- **必须诚实承认它不足**：审批是客户端的策略，用户可以整体关掉（"总是允许"类设置），
  非 VS Code 的 MCP 客户端也不一定实现。所以它是**第一道闸门，不是唯一一道**。
  这一点在文档与设置项描述里都要写清楚，不能给用户"标了就安全"的错觉。
- **1.139.1 上的实测（2026-09-28）**：这条依赖成立，但闸门比本文原先写的**多一道**，"总是允许"
  的持久范围也测出来了。用打包好的 VSIX 在维护者的真实窗口里跑一次写调用（走静态用户
  `mcp.json` → shim → broker 路由）：① 逐次审批**确实会弹**，但**不是原生模态框**，而是 Chat
  视图里的一张内联卡片（标题 `运行 create_issue_comment - forgejo (MCP 服务器)`，按钮
  `在此会话中允许`（分裂按钮，带下拉箭头）与 `跳过`；界面语言是 zh-cn，**英文界面的字符串本次
  没有实测**）。② 卡片跑完之后**还有第二道用户可见的闸门**：结果审批卡片
  （`审批工具结果 - 已运行 create_issue_comment`，按钮 `在此会话中允许，无需审核` 与 `跳过`）。
  ③ 下拉里的**按工具** `始终允许` **不落 `settings.json`**（该文件点击前后字节一致），而是写进
  **profile 级** `globalStorage/state.vscdb` 的记忆项 `chat/autoconfirm`，值为
  `{"mcp_<serverId>_<tool>":true}`；此后**同一个工具**的下一次调用**不再弹任何卡片**——即它是
  **整个 profile 内、按工具**静默，而不是只静默本会话。因此本节的措辞要收紧：写调用的客户端侧
  闸门是**两道**，而"关掉审批"的代价是**一次点击、profile 全局生效**。完整字符串、两个记忆项与
  **未覆盖项**记在 §13.1；这条后果同时作为输入写进 §10 的对应行。

### 3.3 杠杆二：逐工具设置开关，默认关闭

无头子进程读不到扩展设置（这不是推测，`docs/architecture/mcp-server.md` 的「Architecture」一节明确记录了同一
问题的既有解法：per-instance 的 `syncApiUrlsToInstanceUrl` 只能靠 `FORGEJO_MCP_SYNC_API_URLS`
环境变量传下去）。所以开关必须在**宿主侧**生效，并在 spawn 环境里体现：

- 在 `package.json` 的 `forgejoToolkit` 配置段加开关（先例：`packages/forgejo-toolkit/package.json`
  的 `forgejoToolkit.notificationPollingEnabled` / `notificationPollingInterval`，含
  `package.nls.json` / `package.nls.zh-cn.json` 里对应的双语文案）。`forgejoToolkit.mcpEnabled` **已经落地**
  （`packages/forgejo-toolkit/package.json` 的 `contributes.configuration`，双语文案同样在
  `package.nls.json` / `package.nls.zh-cn.json`；
  本文原先记为"正在由另一批改动落地"，2026-09-27 核对已交付）：读取见
  `src/mcpServerProvider.ts` 的 `isMcpServerEnabled`，开关的实时语义
  （关闭即撤销注册、停掉 broker 与工作区映射）见同文件的 `registerMcpServerProvider`。
  新开关应当与它同一层命名。
- **按工具**而不是一个大开关（2026-09-28 定稿，§13.2）：`forgejoToolkit.mcpWriteTools.createIssueComment`
  与 `...submitPullReview`，默认 `false`。理由是 Codeberg 那条约束（§3.6）要求"人明确同意某个
  具体副作用"，一个总开关做不到这一点；首批因此只设**两个**开关（尚未实现，见 §9 阶段 0）。
- `src/mcpServerProvider.ts` 在 `provideMcpServerDefinitions` 里读开关（同处已有读 `http.proxy`
  的先例），把关照的开关写进 `env`（如 `FORGEJO_MCP_WRITE_TOOLS=createIssueComment`；
  宿主构造 definition `env` 的构造点在那里 —— 注意它现在**只放身份**，token 不出宿主，所以
  "宿主提供"这件事在 broker 路由上还得由握手里的实例 id/会话来源来证明，不能只靠 `env`）。
  MCP 子进程的 `mcp/tools.ts` 用同一套"环境变量即设置"的既有模式（`FORGEJO_MCP_SYNC_API_URLS`
  在 `mcp/server.ts` 里的读法）解析它。
- **开关改动必须触发重解析**：provider 已经因为 `http.proxy`（以及新落地的 `mcpEnabled`）
  在同一处 `vscode.workspace.onDidChangeConfiguration` 监听里重解析
  （`src/mcpServerProvider.ts` 的 `registerMcpServerProvider`：`mcpEnabled` 走
  `event.affectsConfiguration(MCP_ENABLED_SETTING)` 的重新应用分支，`http.proxy` 走
  `event.affectsConfiguration('http.proxy')` 的重解析触发），把新键加进
  同一个 `affectsConfiguration` 判断即可，否则用户打开开关后要重载窗口才生效。

### 3.4 杠杆三：扩展宿主 broker 能做与不能做

broker 路径（`docs/architecture/mcp-server.md` 的「Broker mode」一节）值得单独说，因为它**确实**让扩展宿主亲自
创建 MCP server（`src/mcpBroker.ts` 的 `createBrokerMcpServer`，内部调
`createMcpServer`），因此在原理上可以弹框。但：

- **能做**：宿主侧工具处理函数里可以调用任何 `vscode` API，包括
  `vscode.window.showWarningMessage(..., { modal: true }, ...)`。仓库里已有现成范式：
  webview 破坏性命令的宿主侧确认 `_confirmDestructive`（`src/webview/viewProvider.ts`），
  它存在的理由（"webview 是不可信的，必须宿主再问一次"，同处的注释）正好可以
  平移过来："工具调用来自 LLM，同样不可信，必须宿主问一次"。
- **不能做**：broker 会话与"哪个窗口是用户正在看的窗口"没有绑定关系。broker 仍然每个用户只有
  一个端点（`src/mcpBroker.ts` 的 `attemptMcpBrokerStart` 与它的上方注释：先绑定的窗口赢，
  `EADDRINUSE` 即让位），
  而一个会话的 cwd 可能属于**任何**窗口的工作区（`src/mcpBroker.ts` 的
  `findBrokerStateMatch` 专门处理这件事）。所以"在正确的窗口里弹框"本身就需要额外设计：要么在
  持有 broker 的那个窗口弹（可能是用户没在看的窗口），要么先按 `findBrokerStateMatch` 找到会话
  所属窗口、把请求路由过去——后者是一个新的跨窗口 UI 路由机制，不是本文范围。
- **"持有 broker 的那个窗口"本身还会变（2026-09-27 核对：自动交接已交付）**：broker 归属不再是
  会话级固定的。让位窗口会保留一个 `BROKER_TAKEOVER_POLL_MS = 5_000` 的 `unref()` 看门狗
  （`src/mcpBroker.ts` 的 `startMcpBrokerTakeoverWatcher` / `checkBrokerTakeover`），
  它读注册文件、用 `process.kill(pid, 0)` 探活记录的 pid
  （同文件的 `isProcessAlive` / `brokerRegistrationOwnerIsAlive`），确认"持有者已走"就自己重新绑定，并跑与首次绑定完全相同的那条 post-bind 路径
  （`attemptMcpBrokerStart`，返回 `'owned' | 'contended' | 'failed'`；看门狗由
  `cleanupMcpBroker()` 清理）。实测：持有者被硬杀后让位窗口 **1,400 ms** 内接管，
  重复一次 **124 ms**（走查记录见提交 `c5118a6` 与 `52ede35`；平台行为与"已有会话会随之结束"的残余写在
  `KNOWN_ISSUES.md` 的「Only one window can own the MCP broker」条目）。对本文的直接影响：宿主侧模态框的"在哪个窗口
  问"因此有**两条**路径而不是一条——即使将来真的实现"由持有 broker 的窗口弹框"，一次接管之后
  持有者就可能是另一个用户没在看的窗口，而在接管发生的那一刻，原持有窗口里正在阻塞等待的模态框
  所服务的会话本身也结束了（`KNOWN_ISSUES.md` 的「Only one window can own the MCP broker」条目中「What the handover cannot rescue」一段）。这不改变下面的结论，但它把"路由到会话所属
  窗口"从"更干净的做法"升级为该功能的**前置条件**，而不是可选的优化。
- **风险**：模态框会**阻塞**该 MCP 工具调用直到用户响应或超时。一个没人看的窗口弹出的模态框会
  让 agent 会话挂住。MCP 的 stdio 会话没有给工具结果定义"等用户"这种中间态。
- **结论**：**首版不在 broker 路径上加宿主侧模态框。** 用"不标 `readOnlyHint` + 逐工具开关"覆盖
  两条路径，把宿主侧模态框列为**可选的第二阶段**，并且只在解决了"路由到哪个窗口"（上面那条交接
  路径使它更棘手）与"超时/无人响应"这两个问题之后才做——这两条前置条件保留在
  「§9 阶段 3 决定不实现」里（该阶段已于 2026-10-02 决定不做）。

### 3.5 杠杆四：工具描述必须写明副作用

工具描述是 agent 唯一必然读到的合约（本仓库已经这么用：`get_pr_review_brief` 的长描述逐项列出
它刻意省略了什么，见 `mcp/tools.ts` 里它的 description）。写工具的 `description` 必须至少包含：

1. 这是一次**会改变服务端状态**的写操作，会产生用户可见的持久记录；
2. 精确的副作用边界（"在 issue/PR 下新增一条评论；不改标题、不改状态、不合并"；
   "提交一条 review，结论为 COMMENT / APPROVED / REQUEST_CHANGES 之一"）；
3. 需要 `write:issue` 级别的 token scope，缺 scope 时服务端回 403；
4. 该工具是否受设置开关约束（关闭时返回明确拒绝文本，见 §5）；
5. 幂等键语义与 retry 建议（§6）；
6. `dryRun` 的用法建议。

描述是英文（既有约定：MCP 侧输出文案保持英文，`TODO.md` 的「AI / MCP 规划」一节开头的约定句）。

### 3.6 与 Codeberg 约束的关系

`AGENTS.md` 的「Codeberg hosting and resource usage」一节记录：Codeberg 的服务条款不欢迎"看起来由 LLM agent 自主维护"的项目，要求保留
人类维护信号。对本设计的直接影响：

- **"人类确认"必须是默认路径**，而不是一个需要用户去开启的增强项。具体落地为：写工具默认
  **不可见/不可用**（开关关闭时连工具注册都跳过或返回拒绝），开关文案明确写出"会让 AI 以你的
  名义在该实例上留下公开记录"。
- 在设置文案与本文里都要提示：VS Code 侧的"总是允许"会绕过逐次审批，那等于把自主权交给 agent，
  与本项目的托管政策相悖，不建议开启。
- 不做任何"agent 自动 approve / 自动 merge / 自动发 release"的能力。首批两个工具都只产生
  **人类可读的公开文字**，且提交 review 的 `APPROVED` 结论需要用户在审批对话框里再确认一次
  （这是 §3.2 的默认效果，不需要额外机制）。

---

## 4. 首批工具的选择

### 4.1 事实：重跑 workflow 目前做不了

任务是"首批只开创建评论 / 提交 review / 重跑 workflow"（这是本文写作时的任务口径；`TODO.md` 里
原先对应的措辞已按本节结论修正，见下），但按当前依赖树，第三个做不到：

- `packages/forgejo-api/spec/swagger.v1.json` 里 `/repos/{owner}/{repo}/actions/runs/{run_id}`
  的存在路径只有 `.../runs/{run_id}`（:6258）、`.../artifacts`（:6357）、`.../cancel`（:6425）、
  `.../jobs`（:6473）、`.../logs`（:6523）。**全文件搜索 `rerun` 无任何命中**（`Select-String`
  零结果）。
- `KNOWN_ISSUES.md` 的「Re-running an action run is not exposed through the REST API」条目已把这件事记为平台限制，并给出服务端源码层面的证据（rerun 只作为
  session 认证的 web 路由存在）。
- 版本闸门只写在一处：`TODO.md` 的「等上游版本」条目（"等上游版本：Forgejo v17（约 2026-10 底）
  的 workflow / job rerun"，并写明"用 ≥17.0 版本闸门，并同步移除 `KNOWN_ISSUES` 对应条目"）。
  **本文原先引用 `FEATURES.md` 的行号是错的**（2026-09-27 核对：当时该文件全文没有 rerun / v17
  字样；它的 Actions 已完成清单「CI / Actions」一节里只有"Actions 运行详情页支持取消正在运行的
  记录"）。该文件此后已重排，rerun 现在只记在 `FEATURES.md` 未完成侧的「等上游」一节里
  （"Workflow / job 重新运行（rerun）与按 job 过滤日志，两者都等 Forgejo v17"）；
  **2026-09-28 阶段 2 交付后的现状核对**：本文原先在这里引用的那个 FEATURES 条目（首批写工具的
  待办条目）已随首批两个工具交付而消失，写工具的现状现在记在 `FEATURES.md` 已完成侧
  「MCP Server」一节的 Phase 2 条目里——本文只记录这次核对，不改写已裁决的决策。
  原先还要求修正的 `TODO.md` 措辞（"首批只开创建评论 / 提交 review / 重跑 workflow"）
  **已经改完**：该条目（标题以「P2 MCP 写工具阶段 3」开头，现已按 2026-10-02 的决定从
  `TODO.md` 删除；这里说的是**它当时**写的内容，不当成现存的引用）当时写的是"首批收窄为
  `create_issue_comment` + `submit_pull_review`（rerun workflow 在当前 swagger 里没有端点，等
  Forgejo v17）"——本文记录这次改动已经发生，而不是假设它还没发生。
- 客户端侧也没有对应方法：`src/api/client.ts` 的 Actions 写操作只有 `cancelActionRun`
  与 `deleteActionRun`（2026-09-27 核对：`client.ts` 里搜到的 Actions 写方法就这两个）。

**决策**：首批 = `create_issue_comment` + `submit_pull_review`。
`rerun_action_run` 作为**依赖阻塞项**登记（等 v17 端点 + 复现验证），不占首版范围。
**2026-09-28 定稿（§13.3、§13.4）**：首批**只有**这两个内容生产工具；`cancel_action_run`
（`src/api/client.ts` 的 `cancelActionRun`，`POST .../cancel` 在 spec 里存在）**不在首批**，
它是**第二批的第一个候选**，并且会带自己的开关。原先"如果维护者坚持首版就要一个 Actions 侧
写工具"的分支随之关闭：它语义上是「取消」而不是"重跑"，且用户侧已有按钮，收益不明显。rerun 的
推迟被接受：等 Forgejo ≥ 17 走版本闸门，**不写手写 web 路由**（那会绕开被审计的 API 面）。

**交付记录（2026-09-28）**：上面这个决定**没有被改写**，只是它的候选已经落地——
`cancel_action_run` 作为第二批的第一个工具交付，带自己的开关
`forgejoToolkit.mcpWriteTools.cancelActionRun`（默认关闭，与另外两个开关彼此独立），
复用同一套两道闸门、`dryRun`、共享幂等表与审计行；它没有请求体，因此审计行按既定规则
**不带** `bytes`/`sha256`（缺失，而不是 0），同一 run 在 10 分钟窗口内的重复调用直接回放
（第二次取消是同一次逻辑操作），而跨工具复用同一个 key 仍然报错。实现现状见
[MCP Server Integration](../architecture/mcp-server.md) 的 「Write tools」 一节，还剩的工作
（阶段 3 已被决定不做，`rerun_action_run` 的版本闸门仍开放）现在只保留在本记录里：阶段 3 的
理由与前置条件见「§9 阶段 3 决定不实现」，`rerun_action_run` 的闸门在 `TODO.md` 的
「等上游版本」条目里另有一份。

### 4.2 两个首批工具各自需要什么

| 项           | `create_issue_comment`                                                                | `submit_pull_review`                                                                |
| ------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 客户端方法   | `createIssueComment(owner, repo, index, body)`，`src/api/client.ts`                   | `submitPullReview(owner, repo, index, reviewId, event, body?)`，`src/api/client.ts` |
| 入参         | `owner`, `repo`, `index`, `body`                                                      | `owner`, `repo`, `index`, `reviewId`, `event`(枚举), `body?`                        |
| 关键校验     | `owner`/`repo` 走既有 `pathSegmentSchema`（`mcp/tools.ts`）；`body` 需非空 + 长度上限 | 同上；`event` 用 `z.enum` 限定，不能透传任意字符串到服务端                          |
| 结果         | 返回新评论的 `id` 与 `html_url`（可让用户直接打开确认）                               | 返回 review 的 `id`/`state`/`html_url`                                              |
| 需要的新注解 | `readOnlyHint: false`，`idempotentHint: false`，`destructiveHint` 不设                | 同左                                                                                |
| 失败面       | 403（缺 `write:issue`）、404（issue 不存在或不可见）、422（空正文/被限流）            | 403、404、409/422（review 已被提交或状态冲突）、正文字数为空且 event 非 COMMENT     |
| 幂等         | 用调用方提供的 `idempotencyKey`（§6）                                                 | 同左；另外"提交同一条 review 两次"服务端会拒绝，天然有一层保护                      |

补充一个首版应避免的坑：`submitPullReview` 的 `event` 是裸 `string`（`src/api/client.ts` 的
`submitPullReview` 签名，默认
`'COMMENT'`），而 `mcp/tools.ts` 的入参校验是唯一能挡住模型乱填的地方；服务端收到
`REQUEST_CHANGES` 与 `CHANGES_REQUESTED` 两种拼写，仓库里已有 `isChangesRequestedState`
（`mcp/tools.ts`）为读侧处理了这个二义性。**写侧必须只用一种拼写**（建议
`REQUEST_CHANGES`，Forgejo 自己的 `ReviewStateType`），并在工具描述里写明，否则 agent 的
"要求修改"可能某天变成一个 422。

**拼写勘误（2026-09-28，阶段 2 实现时按已安装的服务端源码核对）**：本文原先在上面这一段的枚举里
把"批准"写成了 `APPROVE`，**这是错的**。服务端只接受 **`APPROVED`**
（`modules/structs/pull_review.go`：`ReviewStateApproved ReviewStateType = "APPROVED"`），
`REQUEST_CHANGES` 原本就是对的；`event` 的枚举因此是 `COMMENT` / `APPROVED` /
`REQUEST_CHANGES`。`APPROVE` 是 Go 客户端库里那个**参数名**形状的默认值
（`src/api/client.ts` 的 `submitPullReview(event: string = 'COMMENT')` 原样透传字符串），
不是服务端认的值：`routers/api/v1/repo/pull_review.go` 的 `preparePullReviewType` 的 `switch`
只对 `api.ReviewStateApproved` / `api.ReviewStateRequestChanges` / `api.ReviewStateComment` 有分支，
其余值落到 `default` 的"review stay pending"，随后被以 422 拒绝——也就是一次**看起来像语义错误的
空转**。本文其余各处出现的 `APPROVE` 值一律按此更正为 `APPROVED`；原先的写法保留在本次勘误记录里，
不静默改写。

---

## 5. 没有扩展宿主时必须发生什么

**要求：写工具拒绝，绝不降级。**

现状（`mcp/server.ts` 的 `main()`）的降级链是：broker 转发 → 失败则零配置自动发现 → 匿名只读，
**但只对不带实例身份的启动成立**：扩展提供的 definition 带 `FORGEJO_MCP_INSTANCE_ID` 与
`FORGEJO_MCP_BROKER_ONLY`，此时不降级（记 stderr 日志并以退出码 1 结束），因为它的 `env` 里
根本没有 token——token 只留在 SecretStorage、由 broker 在宿主内使用。
第 2、3 步里 `token` 可能是空串（`mcp/server.ts` 的匿名分支日志明确记录了这一点），也可能是用户
手写在 `mcp.json` 的 `env.FORGEJO_MCP_TOKEN` 里（`docs/architecture/mcp-server.md` 的
「Security model」 一节把这条路作为"扩展没跑但想认证"的官方建议）。**这两种情况对读工具无害，
对写工具不可接受**：

- 匿名 → 写请求必定 401，但这已经是一次"尝试"，而且错误文本会让 agent 以为是权限问题而不是
  "本会话不允许写"。
- 用户手写明文 token → 写操作**会成功**，而这条路径完全绕开了扩展的逐项开关与审计。这不是
  "降级"，是"放飞"。

**决策**：给会话加一个显式的**来源标记**，写工具只在标记为"宿主注入"时可用。

- 机制：`src/mcpServerProvider.ts` 的 `provideMcpServerDefinitions` 里那个 `env` 已经由宿主独占构造，加一个内部分隔用的键
  （例如 `FORGEJO_MCP_WRITE_TOOLS=<逗号分隔的工具名>`）。**没有这个键就没有写工具**——
  零配置路径、broker 不可用路径、用户手写 `mcp.json` 路径都不会有它。
- broker 路径同样满足：`createBrokerMcpServer`（`src/mcpBroker.ts`）是宿主进程内的函数，
  它给 `createMcpServer` 传的就是同一个 `WorkspaceContextOptions` 风格的对象（`mcp/mcpServer.ts`），
  把允许的写工具一并传下去即可（注意它必须**独立**计算，不能从子进程环境继承，因为 broker 会话
  可能来自任何静态配置）。这一点在 2026-09-27 的自动交接之后依然成立、而且更需要强调：接管发生
  后，标记是由**当时**持有 broker 的那个窗口重新计算的，所以"谁提供了凭证"随窗口而变，但
  "只会由扩展宿主提供"这条性质不变。
- 拒绝时的返回必须是**成功的工具结果 + 明确的拒绝文本**，而不是 `isError: true`：
  `callTool` 的错误路径（`mcp/tools.ts` 里 `callTool` 的 catch/`isError` 分支）会把消息渲染成 `isError`，agent 容易把它读成
  "重试一下可能就好"。用普通结果说明"本会话未启用写工具，原因是 <没有扩展宿主 / 开关未开启>，
  **并点名要打开哪个设置**（如 `forgejoToolkit.mcpWriteTools.createIssueComment`；2026-09-28
  定稿，§13.8），请用户在扩展设置里开启"，让 agent 停下来问人，而不是原地重试。
- **绝不做**的事：子进程自己去读 SecretStorage / `state.vscdb` / OS keychain。
  `docs/architecture/mcp-server.md` 的「Security model」一节已经把这条边界写成设计决定（"从外部进程伸手进凭据存储
  正是凭据窃取的样子"），本文不改变它。

---

## 6. 幂等与重复提交保护

**风险面**：agent 会因为超时、上下文截断或"看起来没反应"而重试；VS Code 的审批对话框也可能被
连点两次。

**决策**：

1. 两个写工具都接受可选参数 `idempotencyKey: string`（建议由 agent 生成一个稳定的随机串，
   并在描述里要求"同一次逻辑操作重试时必须复用同一个 key"）。
2. 幂等表放在**会话内存**里（`mcp/tools.ts` 层，每个 MCP server 实例一份；注意 broker 的
   "每连接一个 server 实例"语义，见 `mcp/brokerServer.ts` 模块注释里 "Every connection gets its
   own MCP server instance" 那段，所以表的生命周期正好等于一个
   会话，也正好等于该 broker 会话所连的那个窗口的寿命——交接发生时旧会话结束，表随之消失，
   这正是我们想要的：新会话不该继承旧会话的幂等记录）。条目内容：key → { tool, 目标三元组,
   结果摘要, 完成时间 }；TTL **10 分钟**、容量上限 **32 条**（2026-09-28 定稿：就用这两个值，
   且**不在设置里暴露**——没有人会去调这个旋钮，而拒绝文案已经承担了"告诉调用方等待"的职责，
   见 §13.6）防止 agent 刷爆内存。
3. **命中时的行为分两种**，必须区分：
   - 同一 key **且** 目标与正文摘要一致 → 返回"这是重复调用"的说明 + 上一次的结果，不重发请求；
   - 同一 key 但目标或正文不同 → 返回错误，要求换 key（说明 agent 的复用方式错了）。
4. **不把幂等做成服务端去重**：Forgejo 的评论/review 端点是"必定创建"语义，服务端没有幂等键
   概念。所以"重试真的重复发了一条"这个残余风险是存在的，必须在工具描述与本文里承认。
5. **不做"先查后写"的替代幂等**（例如"提交前先拉评论列表看有没有同正文的评论"）：这会引入
   TOCTOU，而且对"同一个人有意发两条一样的评论"是错误行为。
6. 注解层面：写工具 **不** 标 `idempotentHint: true`。虽然工具内部有幂等键，但那要求调用方
   配合传同一个 key；标成幂等会让某些 MCP 客户端自动重试，反而制造出"调用方没传 key 的重复
   提交"。宁可让运维侧看到重复也不让客户端自作主张。

---

## 7. 要不要 dry-run / plan 模式

**要，但只是工具参数，不是第三种运行模式。**（2026-09-28 定稿：`dryRun` **不设单独开关**——
它没有副作用，而"仓库是否存在"用只读工具本来就查得到，见 §13.9。）

理由：

- 对 agent 来说，最有价值的并不是"能撤销"（写操作不可撤销），而是"能在真正提交前把计划念给
  用户听"。一个 `dryRun: true` 的调用返回"将要提交: 实例 A / owner/repo / issue #12 /
  正文 341 字符 / 摘要 9f2c…"，用户可以在审批对话框里对着这段话点"允许"或"拒绝"。
- 这与本仓库既有的"preview/confirm"基因一致：`get_pr_review_brief` 刻意"只给形状不给正文"
  （`mcp/tools.ts:1999` 的描述原文是 "line counts only, never the diff text"；同一条取向也写在
  它的 handler 注释里，`:1157-1164`），让 agent 拿到决策依据而不必先付出读全量 diff 的代价；
  dry-run 在写侧是同一种取向——**给用户决策依据，而不把副作用一起递过去**。
- 实现成本极低：dry-run 在 `callTool` 的 handler 里提前返回，不发请求；参数校验、开关校验、
  幂等键校验顺序照旧（否则 dry-run 会变成"绕过校验的探测"）。
- 代价与限制要写明：dry-run **不能**证明服务端会接受（token scope、可见性、限流、422 都只有在
  真实请求里才会暴露）。所以描述里不能说"dry-run 通过就一定会成功"。

**不建议**的做法：

- 不建议做"待确认队列"（写请求落盘、等用户到某个 UI 里点提交）。那需要一个新的 UI 面板 + 跨
  进程状态 + 过期语义，收益不如让 VS Code 的审批对话框承担这一步。
- 不建议让 dry-run 成为默认值。默认 `false` 才能让"审批对话框 = 提交"这个心智模型成立；
  默认 `true` 会让 agent 为了完成任务多绕一轮，而很多会话只有一轮预算。

---

## 8. 审计：agent 改了什么

**决策**：每个写工具调用（无论成功、失败、被开关拒绝、dry-run）都往 `Forgejo Toolkit`
Output Channel 记一条结构化日志，格式与既有日志一致（`src/logger.ts` 的实例由
`src/extension.ts` 的激活路径装配，即那里的 `logger.watch()` / `dispose()`）。

**2026-09-28 定稿（§13.5）**：Output Channel 仍是**默认**落点，另加一个**窗口级**布尔设置
`forgejoToolkit.mcpWriteAuditToFile`（默认 `false`，所以默认行为就是"只进 Output Channel"）。
打开后，**同一条记录**以 **JSON Lines**（一行一个 JSON 对象）**追加**到扩展 `context.logUri`
下的 `mcp-write-audit.jsonl`（VS Code 的 "Open Logs Folder" 可以打开这个目录），通道里同时打印
**一行**指明该路径。轮转：**1 MB 上限 + 两个滚动文件**，所以文件不会无界增长。通道里的文本与
文件里的文本**完全相同**。这个设置**用户可见**，所以实现时要在 `package.nls.json` 与
`package.nls.zh-cn.json` 里同时加条目。**以上全部是决定，不是实现**——本文不声称任何一项已经落地。

字段（固定的字段集，含义如下）：

- `at` 时间戳、`tool` 工具名、`dryRun`；
- `caller` 调用方（扩展宿主，或哪个 broker 会话）；
- `instance` 实例**名称**与 id（不写 token；URL 走既有 `redactUrlUserinfo` 规则：
  `src/api/versionProbe.ts` 把它导出为 `redactInstanceUrl` 别名）；
- `repo` 与 `target`：仓库与目标编号（`owner/repo#index`，review 再加 `reviewId`）；
- `bytes` 与 `sha256`：正文**字节数 + 内容摘要哈希**。**不记正文全文**——评论可能含用户粘贴的
  敏感内容，而 Output Channel 是用户会随手复制粘贴到 issue 里的东西；
- `result`：`ok` / `http:<status>` / `refused:<reason>` / `duplicate`，以及服务端返回的对象 id 与
  `html_url`；
- `ms` 耗时毫秒数。

（本文原先的草案里还有"幂等键**前缀**"与"sha256 前 12 位"两条：固定字段集里没有幂等键，
`sha256` 也不再规定截断长度。）

**必须承认的缺口**：

- 日志是**按窗口**的，且 broker 会话记在**持有 broker 的那个窗口**
  （`src/mcpBroker.ts` 的 `createBrokerMcpServer` 跑在宿主进程里，日志走该进程的
  `logger`），所以用户可能在"另一个窗口的 Output Channel"里才看到记录。2026-09-27 的自动交接
  让这句话更严重一层：持有窗口本身会在会话之间变化（§3.4），所以同一个静态 `mcp.json` 配置的
  两次会话，日志可能分别落在两个不同窗口的 Output Channel 里。这一点要写进 FAQ 而不是假装日志
  是全局的。
- 落盘是**可选**的（2026-09-28 决定，见上）：默认 `false`，打开后同一条记录才会以 JSON Lines
  追加到 `context.logUri` 下的 `mcp-write-audit.jsonl`（1 MB 上限 + 两个滚动文件），
  通道里同时打印一行该路径。默认不开时日志不落盘、不跨会话保留（`logger.ts` 是 OutputChannel
  包装）。
- 工具结果里返回 `html_url` 是有意的第二重审计：用户可以在 Forgejo 网页界面看到 agent 到底
  写了什么，这比本地产的日志更权威。

---

## 9. 分阶段落地计划

每一阶段都以"能独立回滚"为粒度；阶段之间不并行发布。

### 阶段 0 — 只加设置与注解骨架（无任何写能力）

- 加**两个**逐工具开关（默认 `false`）+ 双语文案；加 `FORGEJO_MCP_WRITE_TOOLS` 环境变量的
  传递与解析；加"来源标记缺失 → 拒绝"的判定函数（纯函数，先只被测试调用）。
- 把 `mcp/__tests__/server.test.ts:95-98` 的"所有工具都只读"断言改成**按工具分类**：
  维护一个显式的 `READ_ONLY_TOOLS` 集合，断言"其余工具**不**带 `readOnlyHint`"——这样将来
  任何新工具忘记表态都会失败。
- 测试必须钉住：工具名集合的**精确**相等（现有测试风格，`server.test.ts:63-94`）；每个写工具
  在开关关闭时**不在**工具列表里（或存在但一律返回拒绝，二选一需固定语义）。
- **点击实测降级为"顺手做"**：阶段 0 不再以"本机实测确认对话框会弹"为开工门槛（§11.1 已由官方
  文档回答，§3.2 记录了证据强度）。如果顺手做了实测且它与文档冲突，则以实测为准，阶段 1/2 停，
  回落到阶段 3 的宿主侧确认（2026-09-28：两件遗留事项挂在**阶段 1 的验收**上，见阶段 1）。
  （2026-10-02：这条回退路径已随阶段 3 的决定不做而消失，见「§9 阶段 3 决定不实现」；阶段 1
  的验收实测没有触发它。）

### 阶段 1 — `create_issue_comment`

- 先做"人类确认成本最低"的那一个：单次追加、无状态机、结果可直接在网页界面核对。
- 需要：handler + schema + 描述（§3.5 六项）+ dry-run + 幂等表 + 审计日志
  （含 `forgejoToolkit.mcpWriteAuditToFile` 的落盘路径、JSON Lines 与轮转，§13.5）。
- **验收项（2026-09-28 从 §13.1 移入，不是开工门槛）**：① 在已安装的 VS Code 版本上用 dev host
  点一次，确认对话框真的会出现；② 查清 "Always Allow" 实际持久了什么（按工具？按会话？永久？）。
  回退照旧：如果实测与官方文档矛盾，阶段 1/2 停下并回落到阶段 3 的宿主侧确认
  （2026-10-02：该回退路径已不复存在，原因同上；本次实测与文档不矛盾，见下）。
  **2026-09-28 已实测**（用的是维护者的真实窗口，不是 dev host——装好的扩展加一次真实 agent
  会话就够了）：结论与未覆盖项见 §13.1，客户端侧闸门的修正描述见 §3.2，风险表的对应行见 §10。
- 测试必须钉住：
  - 关闭开关 → 拒绝，且**没有发出任何 HTTP 请求**（用 MSW 断言请求数为 0，而不是只看返回文本）；
  - 关闭开关时的拒绝文本**点名要打开的设置键**（§5、§13.8）；
  - 打开开关但无宿主来源标记 → 拒绝，同样断言零请求；
  - 打开开关 + 有标记 → 走 `createIssueComment`，返回含 id 与 url；
  - 同 key 重放 → 只发一次请求（MSW 计数），返回重复说明；
  - 同 key 不同正文 → 错误；
  - `dryRun: true` → 零请求 + 结果里含目标与正文长度；
  - 正文为空 / 超长 → 校验失败，零请求；
  - 403 带 `write:issue` 的响应体 → 工具文本里出现"lack the required scope"类的信息
    （注意：宿主侧的 403 toast 在无头进程里是 no-op，`src/api/clientHost.ts` 的接口注释与
    `headlessHost` 都把它写死为 `() => undefined`，
    所以**只有工具文本能告诉用户该改 token**，这条必须有测试）；
  - 不复用 `readOnly` 注解对象（断言 `readOnlyHint !== true`）。

### 阶段 2 — `submit_pull_review`

- 需要额外的东西：`event` 的枚举与拼写决策（§4.2 及该节末的**拼写勘误**：批准值是 `APPROVED`，
  不是 `APPROVE`）；对 `APPROVED` 的额外文案（"这会算作一次
  正式批准，可能满足分支保护要求"）；对 `REQUEST_CHANGES` 的额外文案。
- 额外的测试：`event` 非法值被 schema 拒绝；`APPROVED` 与 `REQUEST_CHANGES` 各自映射到正确的
  请求体（用 MSW 读取请求体断言，而不是只看返回）。
- 建议在阶段 2 交付时同时给 `docs/architecture/mcp-server.md` 的「Security model」/
  「Future directions」两节补上写工具的现状描述（那里现在只是预告）。

### 阶段 3 决定不实现（2026-10-02）— broker 会话的宿主侧模态框

**决定（2026-10-02，维护者）：阶段 3 不建。** 两道已交付的闸门——VS Code 的逐次调用审批（靠
**始终不标 `readOnlyHint`** 保住，见 §3.2）与扩展自己的逐工具开关（默认关闭，见 §3.3）——已经
覆盖正常配置。阶段 3 只是在**用户或其客户端把逐次审批关掉**的那个情形上再加一道闸门，而它要
付出实实在在的复杂度：把模态框按 `findBrokerStateMatch` 路由到**会话所属窗口**、该窗口不可用时
的兜底、**超时即拒绝**的语义，以及"绝不把模态框弹在错误的窗口里"。所以这是**有意放弃**，不是
遗忘；下面原先写的取舍与三条前置条件按记录体例**原样保留**，以便将来那个情形真的重要时有人能
从这里接手。放弃不改变任何已交付行为：三个写工具仍然各自带开关、默认关闭、会走 VS Code 的逐次
审批。**若要重启**，此处就是起点：三条前置条件缺一不可，且必须重新取得维护者的单独批准。

（以下为 2026-09-28 的原文，保留不改；"需要单独批准"这一状态已被上面的决定取代。）

前置条件，缺一不可：

1. 解决"在哪个窗口问"——需要把会话按 `findBrokerStateMatch`（`src/mcpBroker.ts`）路由到
   会话所属窗口，并有一个"该窗口不可用"的兜底。**自动交接（§3.4）把这一条从"更干净的做法"变成
   硬性前置**：持有 broker 的窗口会在会话之间变化，所以"交给当时的持有窗口"不再是一个稳定的
   近似，而是一条真的会弹错窗口的路径。**维护者的取舍（2026-09-28，§13.10）**：模态框**路由到
   会话所属窗口**；如果这套跨窗口路由的代价被证明太高，正确的降级是**拒绝这次写**，而不是把
   模态框弹在错误的窗口里（这一条随着 2026-10-02"阶段 3 不建"的决定一并作废：整个阶段不再实现）；
2. 解决"无人响应"——模态框必须有超时，超时等于拒绝，且这个语义要写进工具结果；
3. 有实测证据表明 VS Code 的逐次审批在真实会话里确实会弹（§11.1 已由官方文档给出答案，所以
   这一条不再是"阶段 1/2 的阻塞项"；对当时的阶段 3 它退化为一次"本机版本与文档一致"的抽查——
   但如果抽查与文档不符，模态框就从"可选"变成"必需"）。

在这三条满足前，不要实现宿主侧模态框："一个没人看的窗口弹了一个阻塞性的框"比"由 VS Code
审批"更糟。**2026-10-02：这个阶段已被决定不做**，上面三条前置条件原样留档，供将来重启时接手。

---

## 10. 风险

| 风险                        | 影响             | 现状下的处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 用户/客户端关掉逐次审批     | 写操作不再有人看 | 逐工具开关是第二道闸门；设置文案明确警告；不提供任何"自动批量"能力。这一格正是宿主侧模态框（阶段 3）当初要补的那个缺口，而**该阶段已于 2026-10-02 决定不做**——判断是：为"用户自己关掉了一道闸门"再加一道宿主侧闸门，不值它带来的跨窗口路由与超时语义，理由与重启条件见「§9 阶段 3 决定不实现」。**2026-09-28 实测**：卡片下拉里的按工具 `始终允许` 写的是 **profile 级** `chat/autoconfirm`（不在 `settings.json` 里），此后该工具**整个 profile 内**不再弹卡片——即关掉逐次审批是**一次点击、profile 全局生效**，而且 1.139.1 上还多一道结果审批闸门（§3.2、§13.1） |
| agent 重试导致重复评论      | 公开的噪音记录   | 幂等键 + 描述里的 retry 指引；承认残余风险（§6.4）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| token scope 不足            | 403，工具失败    | 工具文本点名 scope（宿主 toast 在无头进程无效）；阶段 1 测试锁住这条文本                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 误把写工具当成只读          | 无确认执行       | `readOnlyHint` 不设 + 测试断言 + 描述首句声明副作用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 静态配置里手写 token 的会话 | 绕过全部闸门     | 来源标记缺失 → 拒绝；这也是 §5 的核心                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 审计日志不在用户当前窗口    | 用户以为"没发生" | 工具结果返回 `html_url`；FAQ 说明日志按窗口，且 broker 会话的日志落在**当时持有 broker** 的窗口                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Codeberg 政策观感           | 项目托管风险     | 默认关闭 + 人类确认默认 + 明确不做自动 approve/merge                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

---

## 11. 会改变本决策的证据

1. **~~VS Code 的审批实测缺失~~ → 已由官方文档回答（2026-09-27）。** 官方 MCP 开发者指南在
   "Tools" 一节明确写着：_"Users can edit model-generated input parameters in the tool
   confirmation dialog. **The confirmation dialog will be shown for all tools that are not
   marked with the `readOnlyHint` annotation.**"_，注解一节又写着 _"`readOnlyHint`: … **VS Code
   doesn't ask for confirmation to run read-only tools.**"_；Language Model Tool 指南补充
   _"the user can also select to 'Always Allow' a certain tool"_。也就是说阶段 0 的假设成立：
   **不标 `readOnlyHint` 就会被逐次拦截审批**（且参数可在对话框里改），只读工具不会。
   依据：[MCP developer guide](https://code.visualstudio.com/api/extension-guides/ai/mcp)、
   [Language Model Tool API](https://code.visualstudio.com/api/extension-guides/ai/tools)。
   **证据强度**：官方文档，不是本机实测；"总是允许"的持久范围（是否可被用户永久放行）文档只
   提到存在该选项，未说明有效范围，因此阶段 0 仍值得顺手做一次点击实测（不再是硬门槛）。
   还有一处细节值得记下来：这句话出现在 Language Model Tool 指南的 `prepareInvocation` 一节
   （"扩展工具"的确认流程），并不在 MCP 工具那一节的对话框说明里——也就是说"Always Allow 也能
   用在 MCP 工具上"是合理推断而不是文档明说，这正是实测仍值得做的第二个理由。
   原先的要求——"若实测表明不弹框则阶段 1/2 必须停"——随之失效：文档与实现若不一致，以实测为准
   并回落阶段 3（broker 侧宿主确认）。（2026-10-02：该回退目标已决定不做，见「§9 阶段 3 决定不
   实现」；本次验收实测（§13.1）与文档一致，没有触发它。）
2. **如果 Codeberg 或上游明确表示"任何由扩展代发的公开文字都不可接受"**，那么正确做法是把
   首批工具从"直接提交"改成"生成 draft + 由用户在扩展的 UI 里点提交"，那是另一份设计。
3. **如果 Forgejo ≥ 17 落地 rerun 端点**，把 `rerun_action_run` 提回首批（并同步改
   `KNOWN_ISSUES.md` 的「Re-running an action run is not exposed through the REST API」条目与 `KNOWN_ISSUES.zh.md` 的「重新运行 Actions 运行记录未在 REST API 中暴露」条目、`TODO.md` 的「等上游版本」
   条目；**注意**：`FEATURES.md` 没有这条版本闸门记录，本文原先对 `FEATURES.md` 的引用经核对是错的，
   见 §4.1），同时按 §9 的模式给它单独一个开关。
4. **如果出现"持久审计日志"的硬需求**（合规、多用户机器）：2026-09-28 的决定给出了**可选**的
   落盘方案（`forgejoToolkit.mcpWriteAuditToFile`，append-only 追加 + 轮转，§13.5），但那是
   "用户自己打开"的便利设施；合规级硬需求要重估的是保留期、是否默认打开，以及与
   `docs/release.md` 的数据保留说明对齐。
5. **如果 MCP 规范或 VS Code 引入"需要人类确认"的正式注解位**（而不是只靠不标只读），本文的
   §3.2 与 §3.4 应当收敛到那一个机制上，删掉自定义的便利设施。
6. **broker 归属不再是会话级固定（2026-09-27 交付的自动交接）**：一个让位窗口会在持有者消失后
   自己接管端点（`BROKER_TAKEOVER_POLL_MS = 5_000`，实测 1,400 ms / 重复 124 ms，
   见 `src/mcpBroker.ts` 的 `startMcpBrokerTakeoverWatcher` / `checkBrokerTakeover`；
   记录见提交 `52ede35`/`c5118a6`、
   `KNOWN_ISSUES.md` 的「Only one window can own the MCP broker」条目）。它**加强**了 §3.4 对宿主侧模态框的保留意见，并把"路由到会话
   所属窗口"从优化项升级为前置条件（该前置条件现在按「§9 阶段 3 决定不实现」留档）。它**削弱**的说法只有一个："broker 的
   宿主窗口在整个会话生命周期内固定"——本文原先隐含了这个假设（例如 §8 说日志记在"持有 broker
   的那个窗口"），现在必须改口为"记在当时持有 broker 的那个窗口"。它不改变任何首版决策：写工具
   仍然靠"不标 `readOnlyHint` + 逐工具开关"，而这两者都与 broker 归属无关。

---

## 12. 事实核对清单

**引用一律以符号名与标题为准。** 2026-09-27 的这一轮重核只覆盖**实现侧**的断言：位置改成
**符号名 / 标题**，行号会随在途改动漂移，符号名不会。**写作时（HEAD `b14d764`）与上一轮
（HEAD `c5118a6`）留下的行号没有在这一轮逐条复查**，所以下表不再给行号——要定位就按符号名搜。

| 断言                                                                                                                                                               | 位置（符号 / 标题）                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 只读注解对象与 `readOnlyHint: true`                                                                                                                                | `packages/forgejo-toolkit/mcp/tools.ts` 的 `const readOnly`                                                                                                                                                                                                      |
| 每个工具挂同一个 `readOnly` 注解                                                                                                                                   | `packages/forgejo-toolkit/mcp/tools.ts` 全文（30 处 `annotations: readOnly`）                                                                                                                                                                                    |
| 工具面恰好 30 个工具、测试锁死"所有工具只读"与工具名集合                                                                                                           | `packages/forgejo-toolkit/mcp/__tests__/server.test.ts`（工具名名单与 `readOnlyHint` 断言）                                                                                                                                                                      |
| 工具名是 `ToolName`，新工具必须进 `PAGED_LISTS`                                                                                                                    | `packages/forgejo-toolkit/mcp/tools.ts` 的 `ToolName` / `PAGED_LISTS`                                                                                                                                                                                            |
| `callTool` 的错误渲染路径                                                                                                                                          | `packages/forgejo-toolkit/mcp/tools.ts` 的 `callTool`                                                                                                                                                                                                            |
| 路径段校验 schema                                                                                                                                                  | `packages/forgejo-toolkit/mcp/tools.ts` 的 `pathSegmentSchema`                                                                                                                                                                                                   |
| `REQUEST_CHANGES` / `CHANGES_REQUESTED` 二义性（读侧已处理）                                                                                                       | `packages/forgejo-toolkit/mcp/tools.ts` 的 `isChangesRequestedState`                                                                                                                                                                                             |
| `get_pr_review_brief` 的长描述（"只给形状不给正文"）                                                                                                               | `packages/forgejo-toolkit/mcp/tools.ts` 里该工具的 description 与 handler 注释                                                                                                                                                                                   |
| `createIssueComment`                                                                                                                                               | `packages/forgejo-toolkit/src/api/client.ts` 的 `createIssueComment`                                                                                                                                                                                             |
| `submitPullReview`（`event: string = 'COMMENT'`）                                                                                                                  | `packages/forgejo-toolkit/src/api/client.ts` 的 `submitPullReview`（签名里 `event` 的默认值）                                                                                                                                                                    |
| `cancelActionRun` / `deleteActionRun`（Actions 侧现有写操作）                                                                                                      | `packages/forgejo-toolkit/src/api/client.ts` 的 `cancelActionRun` / `deleteActionRun`                                                                                                                                                                            |
| 宿主构造 definition `env` 的构造点（只放身份，**不含 token**）                                                                                                     | `packages/forgejo-toolkit/src/mcpServerProvider.ts` 的 `provideMcpServerDefinitions`                                                                                                                                                                             |
| provider 因配置变化重解析                                                                                                                                          | 同上，`registerMcpServerProvider` 的 `onDidChangeConfiguration` 监听                                                                                                                                                                                             |
| `forgejoToolkit.mcpEnabled` 已交付（读取 + 运行时撤销）                                                                                                            | `packages/forgejo-toolkit/package.json` 的 `contributes.configuration`、`src/mcpServerProvider.ts` 的 `isMcpServerEnabled` / `registerMcpServerProvider`                                                                                                         |
| 设置项先例（轮询开关 + 双语文案）                                                                                                                                  | `packages/forgejo-toolkit/package.json` 的 `forgejoToolkit.notificationPollingEnabled` / `notificationPollingInterval`、`package.nls.json` 与 `package.nls.zh-cn.json` 的对应键                                                                                  |
| 无头进程读不到设置，只能靠环境变量                                                                                                                                 | `docs/architecture/mcp-server.md` 的「Architecture」一节                                                                                                                                                                                                         |
| 降级链：broker → 零配置 → 匿名（含匿名分支的显式日志）；**带实例身份的 definition 不降级**（`FORGEJO_MCP_BROKER_ONLY` / 显式实例 id 解析失败 → stderr + 退出码 1） | `packages/forgejo-toolkit/mcp/server.ts` 的 `main()`                                                                                                                                                                                                             |
| 静态 `mcp.json` 的 broker 转发启动行                                                                                                                               | 同上（"No instance credentials in the launch environment …"）                                                                                                                                                                                                    |
| broker 会话由宿主创建 MCP server                                                                                                                                   | `packages/forgejo-toolkit/src/mcpBroker.ts` 的 `createBrokerMcpServer`（内部调 `createMcpServer`）                                                                                                                                                               |
| broker 每个用户一个端点、先绑定者赢                                                                                                                                | `packages/forgejo-toolkit/src/mcpBroker.ts` 的 `attemptMcpBrokerStart`（含 `EADDRINUSE` 让位）                                                                                                                                                                   |
| broker 会话可能属于别的窗口                                                                                                                                        | `packages/forgejo-toolkit/src/mcpBroker.ts` 的 `findBrokerStateMatch`                                                                                                                                                                                            |
| broker 归属可变：5 s 看门狗 + pid 探活后自行接管                                                                                                                   | `packages/forgejo-toolkit/src/mcpBroker.ts` 的 `startMcpBrokerTakeoverWatcher` / `checkBrokerTakeover` / `isProcessAlive` / `brokerRegistrationOwnerIsAlive` / `cleanupMcpBroker`                                                                                |
| broker 每连接一个 server 实例                                                                                                                                      | `packages/forgejo-toolkit/mcp/brokerServer.ts` 模块注释里 "Every connection gets its own MCP server instance" 那段                                                                                                                                               |
| 宿主侧破坏性确认的既有范式                                                                                                                                         | `packages/forgejo-toolkit/src/webview/viewProvider.ts` 的 `_confirmDestructive`                                                                                                                                                                                  |
| 无头 client host 的 401/403 hook 是 no-op                                                                                                                          | `packages/forgejo-toolkit/src/api/clientHost.ts` 的接口注释与 `headlessHost`                                                                                                                                                                                     |
| 403 + scope 的识别与文案                                                                                                                                           | `packages/forgejo-toolkit/src/api/client.ts` 里识别缺失 scope 的分支、`src/api/vscodeClientHost.ts` 的 `notifyInsufficientScope`                                                                                                                                 |
| `write:issue` 的 403 语义已被记录                                                                                                                                  | `KNOWN_ISSUES.md` 的「Issue/PR attachment upload during creation requires two API calls」条目（及 `KNOWN_ISSUES.zh.md` 的「Issue/PR 创建时上传附件需要分两次 API 调用」条目）                                                                                    |
| spec 里没有 rerun 端点                                                                                                                                             | `packages/forgejo-api/spec/swagger.v1.json`（`:6258/:6357/:6425/:6473/:6523` 是全部 runs 子路径；`rerun` 零命中）                                                                                                                                                |
| rerun 是平台限制、等 v17                                                                                                                                           | `KNOWN_ISSUES.md` 的「Re-running an action run is not exposed through the REST API」条目、`TODO.md` 的「等上游版本」条目（这条闸门现在记在 `FEATURES.md` 未完成侧的「等上游」一节；已完成清单「CI / Actions」一节里只有「取消运行」，rerun 已不在 MCP 首批之列） |
| MCP 侧文案保持英文                                                                                                                                                 | `TODO.md` 的「AI / MCP 规划」一节开头的约定句                                                                                                                                                                                                                    |
| Codeberg 对 LLM 自主维护的态度                                                                                                                                     | `AGENTS.md` 的「Codeberg hosting and resource usage」一节                                                                                                                                                                                                        |
| 构建期禁止 mcp 入口引入 `vscode`                                                                                                                                   | `docs/architecture/mcp-server.md` 的「Architecture」一节                                                                                                                                                                                                         |
| 只读工具不弹确认框 / Phase 2 预告                                                                                                                                  | `docs/architecture/mcp-server.md` 的「Security model」与「Future directions」两节                                                                                                                                                                                |
| 不从外部进程读凭据存储的设计决定                                                                                                                                   | `docs/architecture/mcp-server.md` 的「Security model」一节                                                                                                                                                                                                       |
| broker 自动交接的仓库内记录                                                                                                                                        | `KNOWN_ISSUES.md` 的 broker 条目、提交 `52ede35`/`c5118a6`                                                                                                                                                                                                       |
| VS Code 对确认行为的官方说明（外部来源）                                                                                                                           | `code.visualstudio.com/api/extension-guides/ai/mcp` 的 "Tools" / "Tool annotations"、`.../ai/tools` 的 `prepareInvocation`（引文见 §11.1）                                                                                                                       |
| 走查 harness 的位置与用法                                                                                                                                          | `tools/ui-review/README.md` 的「Release walkthrough checklist」一节                                                                                                                                                                                              |

---

## 13. 决定记录（原「留给维护者的开放问题」）

**维护者已于 2026-09-28 裁决完本节的全部十条。** 本节保留原有编号（本文各处按 `§13.x` 引用它们），
逐条写成"决定"；原先的提问以删除线保留，不静默删除——问过什么本身是记录的一部分。裁决只有三种
去向：**已决定**、**推迟到阶段 3 并先记下取舍**、**移入阶段 1 的验收**。**本节的决定已按
阶段 0/1/2 落地**（逐条实现状态见 `FEATURES.md` 的「已完成」「MCP Server」一节与
`docs/architecture/mcp-server.md` 的 「Write tools」）。**2026-10-02 更新**：阶段 3 已由维护者
**决定不做**（理由与重启条件见「§9 阶段 3 决定不实现」），因此本节第 10 条的性质由"推迟"变为
"随阶段 3 一并关闭"，原先记下的取舍作为该决定的依据保留。`rerun_action_run` 的版本闸门仍开放，
记在 `TODO.md` 的「等上游版本」条目里。

1. ~~**`readOnlyHint` 的实测结论是什么？** 官方文档已经回答了主要部分（§11.1，2026-09-27：不标
   `readOnlyHint` 的工具会显示确认对话框、只读工具不会），所以这**不再是本文的阻塞性前提**。
   剩下两件次要的事：(a) 在本机装的 VS Code 版本上做一次 dev host 点击实测并留证，确认对话框
   真的会弹；(b) "Always Allow" 的有效范围——文档只提到存在该选项，没说能否永久放行，而且那句
   话出自扩展工具的确认流程而不是 MCP 工具对话框小节。若 (a) 与文档冲突，以实测为准，阶段 1/2
   停下并回落到阶段 3 的宿主侧确认。~~ **移入阶段 1 的验收（2026-09-28）**：它**不再是阻塞性
   前提**（官方文档已回答主要问题），上面那两件小事改挂在**阶段 1 的验收**上，而不是开工门槛；
   回退照旧——如果实测与官方文档矛盾，阶段 1/2 停下并回落到阶段 3 的宿主侧确认
   （§9 阶段 1）。
   **验收实测（2026-09-28，VS Code 1.139.1 + 打包 VSIX `forgejo-toolkit-0.0.1.vsix`，在维护者的
   真实窗口里、走静态用户 `mcp.json` → shim → broker 路由）**：①② 都测到，且**与 §11.1 的官方
   文档不矛盾**，阶段 1/2 不触发回退。
   ① 确认界面**真的会出现**，但**不是原生模态框**，而是 Chat 视图里的一张内联卡片。界面语言是
   zh-cn，卡片上的字符串逐字为：标题 `运行 create_issue_comment - forgejo (MCP 服务器)`；正文是
   工具 description 原文（英文）、`显示更多`、`输入` 与调用 JSON `{ "owner": … , "repo": … }`、
   `查看更多`、`请注意，MCP 服务器或恶意对话内容可能会尝试通过工具滥用 "Code"。`、
   `⚠ Adds a comment to issue #9 — changes server state.`；按钮为 `在此会话中允许`（分裂按钮，
   带 `∨` 箭头）与 `跳过`。箭头展开后是**按工具**的 `允许和审阅一次` / `允许并跳过审阅结果` /
   `此工作区中允许` / `始终允许`，以及**按服务器**的 `允许此会话中来自 forgejo-toolkit 的工具` /
   `允许此工作区中来自 forgejo-toolkit 的工具` / `始终允许来自 forgejo-toolkit 的工具`。
   **英文界面下的对应字符串本次没有实测**，不要把上面这些中文当成英文原文的转写。
   ② 点击**按工具的 `始终允许`** 之后：`settings.json` 点击前后**字节一致**（规则不落在设置里），
   规则落在 **profile 级** `globalStorage/state.vscdb` 的记忆项 `chat/autoconfirm` 里，值为
   `{"mcp_<serverId>_<tool>":true}`（本次实测 `{"mcp_forgejo-tool3_create_issue_comment":true}`，
   键 = 服务器 id + 工具名）；VS Code 自己对这次自动放行的记录是
   `isConfirmed:{"type":3,"scope":"profile"}`。**同一个工具的下一次调用**（`dryRun: true`）
   **没有再弹任何卡片**，直接执行——所以"始终允许"的范围是 **profile（用户）级、按工具**，不是
   按会话、也不是按工作区；这条后果已作为输入写进 §10 的那一行。
   ③ 顺带测到一件 §3.2 原先没写的事：**1.139.1 上一次写调用有两道用户可见的闸门**。工具跑完之后
   还会弹**第二张结果审批卡片**：标题 `审批工具结果 - 已运行 create_issue_comment`，按钮
   `在此会话中允许，无需审核`（带 `∨`）与 `跳过`；它落盘的是**工作区**级记忆项
   `chat/servers/autoconfirm-post`（键 = 扩展 id + 服务器标签；标签里含配置的实例 URL，按本仓库
   不写实例地址的约定，这里不复现它的值）。两道闸门都在 Chat 视图里，都不是原生模态框。
   **本次未覆盖**（不要当作已验证）：扩展自己提供的 definition（跑的是静态 `mcp.json` 路由，
   `caller` 为 `extension host (broker session, cwd …)`；扩展提供的那几个 definition 在 Chat 的
   工具选择器里能看到，但会话用的是静态那一个）、跨窗口 / 跨工作区的粘性、按服务器档
   （`始终允许来自 … 的工具`）的持久结果、403 缺 scope 的路径（token 有写权限，真实调用返回
   `ok`）、以及打开 `mcpWriteAuditToFile` 之后的 JSONL 文件（该设置本次保持默认关闭，磁盘上
   没有该文件）。
2. ~~**开关粒度**：逐工具（本文建议）还是"写工具总开关"？逐工具更贴合 Codeberg 那条约束，
   但设置页要放 2–N 个开关。~~ **已决定（2026-09-28）：逐工具**，按本文的建议；首批因此只设
   **两个**开关（默认 `false`，§3.3）。
3. ~~**首批是否包含 `cancel_action_run`**（唯一现在就能做的 Actions 写操作，语义是「取消」而不是
   "重跑"）？如果包含，它是第三个开关。~~ **已决定（2026-09-28）：不含。** 首批只保留两个
   **内容生产**工具；`cancel_action_run` 是**第二批的第一个候选**，并且要带它自己的开关（§4.1）。
   **交付记录（2026-09-28）：该候选已交付**，带自己的开关
   `forgejoToolkit.mcpWriteTools.cancelActionRun`；本条的**决定本身不变**——它仍然不属于首批，
   只是第二批的第一个工具已经落地。
4. ~~**`rerun_action_run` 是否接受"依赖 Forgejo ≥ 17 + 版本闸门"的推迟**，还是要求现在就用手写
   web 路由实现（本文与 `KNOWN_ISSUES.md` 的「Re-running an action run is not exposed through the REST API」条目都反对）？~~ **已决定（2026-09-28）：接受推迟。**
   等 Forgejo ≥ 17 并走版本闸门；**不写手写 web 路由**——那会绕开被审计的 API 面，
   `KNOWN_ISSUES.md` 的对应条目已经把这条平台限制记在案（§4.1）。
5. ~~**审计要不要落盘**（跨会话、可检索），还是 Output Channel 足够？如果落盘，数据保留与
   `docs/release.md` 的说明需要一起改。~~ **已决定（2026-09-28）：Output Channel 仍是默认**，
   另加一个**窗口级**布尔设置 `forgejoToolkit.mcpWriteAuditToFile`（默认 `false`，所以默认行为
   就是 Output-Channel-only）。打开后，**同一条记录**以 **JSON Lines**（一行一个 JSON 对象）
   **追加**到扩展 `context.logUri` 下的 `mcp-write-audit.jsonl`（VS Code 的 "Open Logs Folder"
   可以打开这个目录），通道里同时打印**一行**指明该路径。轮转：**1 MB 上限 + 两个滚动文件**，
   所以文件不会无界增长。通道里的文本与文件里的文本**完全相同**，字段集固定为 `at`、`caller`
   （扩展宿主或 broker 会话）、`instance`、`repo`、`target`、`tool`、`dryRun`、`bytes`、
   `sha256`（正文的哈希）、`result`、`ms`，**永远不记评论 / review 正文全文**（§2.5 已经这么
   要求）。字段含义与"硬需求出现时要重估什么"见 §8 与 §11.4。该设置**用户可见**，所以实现时
   要在 `package.nls.json` 与 `package.nls.zh-cn.json` 里同时加条目。
6. ~~**幂等键 TTL 与容量**（本文给 10 分钟 / 32 条）是否合适？是否需要在设置里暴露？~~
   **已决定（2026-09-28）：就用 10 分钟 / 32 条，且不在设置里暴露。** 没有人会去调这个旋钮，
   而既有的拒绝文案已经承担了"告诉调用方等待"的职责（§6）。
7. ~~**工具命名**：`create_issue_comment` / `submit_pull_review` 是否与既有 30 个工具（下划线、
   动词在前）风格一致，还是应当叫 `add_issue_comment`（与扩展内部命令
   `addPullReviewComment` 对齐）？命名一旦发布就是对外契约。~~
   **已决定（2026-09-28）：保留 `create_issue_comment` 与 `submit_pull_review`。**
   否决 `add_issue_comment`：它对齐的是一个**用户永远看不到的内部命令名**，而已发布的工具面用的
   是**下划线、动词在前**（`create_…`）。
8. ~~**要不要在阶段 1 之前把"写工具未启用"的拒绝文案做成 prompt 模板的一部分**，让 agent 在遇到
   拒绝时自动转向"请用户在设置里开启"，而不是反复重试？~~ **已决定（2026-09-28）：拒绝文案必须
   点名要打开的设置键**（如 `forgejoToolkit.mcpWriteTools.createIssueComment`），让调用方能直接
   告诉用户该开哪个开关，而不是原地重试；实现与测试要求见 §5 与 §9 阶段 1。
9. ~~**`dryRun` 是否也需要单独开关？** 本文认为不需要（它不产生副作用），但它确实是一条可以
   用来探测仓库存在性的路径——如果维护者认为这算信息泄露，可以把它也纳入开关。~~
   **已决定（2026-09-28）：不设单独开关。** 它没有副作用，而"仓库是否存在"用只读工具本来就能
   查到（§7）。
10. ~~**如果将来真要做宿主侧模态框（阶段 3），它是"由当时持有 broker 的窗口弹"还是"必须路由到
    会话所属窗口"？** 自动交接（§3.4）之后"当时的持有窗口"会随会话变化，甚至与上一会话不是
    同一个窗口；本文的倾向是后者（路由），但代价是新增一套跨窗口 UI 路由。需要维护者在动手前
    明确取舍。~~ **推迟到阶段 3 自己的批准（2026-09-28），取舍先记下：路由到"会话所属窗口"**；
    如果这套跨窗口路由的代价被证明太高，正确的降级是**拒绝这次写**，而不是把模态框弹在错误的
    窗口里（§9 阶段 3）。**已随阶段 3 关闭（2026-10-02）**：模态框不建，上面这条取舍保留为
    "为什么不建"的依据；重启条件见「§9 阶段 3 决定不实现」。

**本节至此十条全部关闭，没有新增开放问题。** 阶段 0/1/2 已按 §9 的分阶段计划交付；唯一仍开放
的写工具事项是 `rerun_action_run` 的版本闸门（见 §4.1 与 `TODO.md` 的「等上游版本」条目）。
