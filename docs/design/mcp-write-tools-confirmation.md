# MCP Phase 2 写工具的确认模型

- 状态：**设计（未实现）**，实现前需维护者裁决本文末尾的开放问题
- 关联：`TODO.md` 的「AI / MCP 规划」条目；`docs/architecture/mcp-server.md` 见
  [MCP Server Integration](../architecture/mcp-server.md) 的 "Security model" 与
  "Future directions" 两节
- 适用范围：MCP 工具面里所有会改服务端状态的工具（创建评论、提交 review、以后可能的创建 issue / 合并 PR / 重跑 workflow 等）
- 基线代码：HEAD `b14d764`，行号按**当前工作树**（含其他 agent 的在途改动）核对

> 相对引用说明：仓库内路径都从仓库根写起。工作树里有其他 agent 的在途改动，行号会漂移，
> 所以每条断言都同时给出**可搜索的标识符 / 代码片段**；以标识符为准，行号只用于加速定位。
> 核对方式见「§12 事实核对清单」。

---

## 1. 问题

Phase 1 的 MCP 工具面**全部只读**，而且这个"只读"不只是约定，是从三条相互独立的机制上钉住的：

1. `mcp/tools.ts:1616`（`const readOnly = {...}`）定义了一个共享注解并施加到每一个工具上：
   `const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };`
   （30 处 `annotations: readOnly`）。
2. `mcp/__tests__/server.test.ts:55-98` 把这条性质**锁死**：对 `tools/list` 返回的每一个工具断言
   `tool.annotations?.readOnlyHint === true`，并断言工具名集合恰好 30 个。
3. `docs/architecture/mcp-server.md:562-570` 写明：标了 `readOnlyHint` 的工具 VS Code
   **不会**逐次弹确认框，所以"人在环内"的保证完全由工具面本身承担（每个工具都映射到 `GET`）。

Phase 2 要加写工具，第 1、3 条同时失效：只要有一个工具不标 `readOnlyHint`，第 2 条测试必须改成
"按工具分类断言"，而"人在环内"就必须由新的机制补回来。

这里有一个容易被忽略的前提差异，它是整篇设计的地基：

| 启动路径                                                                                     | 谁创建 MCP server                                                                          | 进程里有 `vscode` 吗 | 能弹 VS Code 对话框吗           |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------- | ------------------------------- |
| VS Code 按 `contributes.mcpServerDefinitionProviders` 拉起（`src/mcpServerProvider.ts:299`） | `out/mcp-server.mjs` 子进程（`mcp/server.ts:128`）                                         | 没有                 | **不能**                        |
| 静态 `mcp.json` 经 shim → broker（`mcp/server.ts:44-85`）                                    | **扩展宿主进程**（`src/mcpBroker.ts:315` 的 `createBrokerMcpServer` 调 `createMcpServer`） | 有                   | **可以，但默认不做**（见 §3.4） |
| 静态 `mcp.json`，扩展宿主不在（`mcp/server.ts:86`）                                          | 子进程，匿名                                                                               | 没有                 | 不能                            |

也就是说：**"无头 MCP 子进程弹不了 VS Code 确认框"对第一条路径是永久事实，对第二条路径只是当下
策略。** 但第三条路径决定了本设计的下限——那时连 token 都没有。

---

## 2. 决策（摘要）

1. **人类确认是默认行为，不是可选项。** 不标 `readOnlyHint`、不标 `destructiveHint: false`，
   让 VS Code 的逐次工具审批成为第一道闸门；写工具**另外**要求逐项显式开启的设置开关（默认
   全部关闭），这是第二道闸门。两道闸门都通过才可能发出写请求。
2. **不发明的 token 一律拒绝。** 只有在"扩展宿主亲自注入"的会话里，写工具才可用；无法证明
   这一点时（无 broker 的匿名子进程、只带用户手写明文 token 的静态配置）写工具**返回拒绝并
   说明原因**，绝不降级为匿名、也绝不去读磁盘上的 token。
3. **首批只做两个工具**：`create_issue_comment`、`submit_pull_review`。
   "重跑 workflow"**在本仓库当前依赖下无法实现**（§4.1，`swagger.v1.json` 里没有该端点，
   `KNOWN_ISSUES.md:73-79` 已把它记为平台限制），推迟到依赖 Forgejo ≥ 17 的版本闸门。
4. **dry-run 值得做**，但只作为工具参数（`dryRun`），不作为第三种运行模式；默认 `false`，
   工具描述要求 agent 在批量提交前先跑一次 dry-run 并把计划念给用户。
5. **审计**落在 `Forgejo Toolkit` Output Channel：调用方、实例、仓库、目标编号、正文字节数与
   摘要哈希、结果、耗时。**不落**评论正文全文。

---

## 3. 为什么无头子进程弹不了确认框，以及有哪些可用的杠杆

### 3.1 事实

- 子进程是 `process.execPath` 起的普通 Node 进程（`src/mcpServerProvider.ts:145`），入口
  `mcp/server.ts`，只与 stdio 说话（`mcp/server.ts:150`）。它没有 `vscode` 模块，构建期还有一道
  硬约束：esbuild 的 metafile 检查会在任何从 mcp 入口可达的 chunk 引入 `vscode` 时**让构建失败**
  （`docs/architecture/mcp-server.md:66-73`）。
- 它的诊断输出只能走 stderr（`mcp/server.ts:11-16`），stdout 是协议帧。
- 因此"在工具处理函数里 `vscode.window.showWarningMessage`"这条最自然的路，在子进程里是**不可
  达**的语法级不可能，而不是"没写"。

### 3.2 杠杆一：不标 `readOnlyHint`，把审批交给 VS Code

MCP 的 `ToolAnnotations` 是提示位，不是保证。VS Code 用 `readOnlyHint` 决定只读工具是否**跳过**
逐次审批；本仓库目前正是靠这一点实现"只读工具不弹框"
（`docs/architecture/mcp-server.md:562-566`）。反过来，一个既无 `readOnlyHint` 也无
`destructiveHint: false` 的工具就落回"每次调用都要用户批准"的默认路径。

- **本设计依赖**：写工具不设 `readOnlyHint`，也**不**设 `destructiveHint: false`。写工具是
  创建评论/提交 review，语义上是"外部可见的持久副作用"，MCP 规范里 `destructiveHint: false`
  的含义是"只做追加、不破坏已有数据"——用它去换更宽松的提示是错的方向，而且它只在
  `readOnlyHint: false` 时才被解读，容易误导客户端。
- **必须诚实承认它不足**：审批是客户端的策略，用户可以整体关掉（"总是允许"类设置），
  非 VS Code 的 MCP 客户端也不一定实现。所以它是**第一道闸门，不是唯一一道**。
  这一点在文档与设置项描述里都要写清楚，不能给用户"标了就安全"的错觉。

### 3.3 杠杆二：逐工具设置开关，默认关闭

无头子进程读不到扩展设置（这不是推测，`docs/architecture/mcp-server.md:94-101` 明确记录了同一
问题的既有解法：per-instance 的 `syncApiUrlsToInstanceUrl` 只能靠 `FORGEJO_MCP_SYNC_API_URLS`
环境变量传下去）。所以开关必须在**宿主侧**生效，并在 spawn 环境里体现：

- 在 `package.json` 的 `forgejoToolkit` 配置段加开关（先例：`packages/forgejo-toolkit/package.json:113-124`
  的 `notificationPollingEnabled` / `notificationPollingInterval`，含 `package.nls.json:20-21`
  与 `package.nls.zh-cn.json:20-21` 的双语文案）。注意 `forgejoToolkit.mcpEnabled`
  （`package.json:130-133`）正在由另一批改动落地，新开关应当与它同一层命名。
- 建议**按工具**而不是一个大开关：`forgejoToolkit.mcpWriteTools.createIssueComment`
  与 `...submitPullReview`，默认 `false`。理由是 Codeberg 那条约束（§3.6）要求"人明确同意某个
  具体副作用"，一个总开关做不到这一点。
- `src/mcpServerProvider.ts` 在 `provideMcpServerDefinitions` 里读开关（同处已有读 `http.proxy`
  的先例，`:149-151`），把关照的开关写进 `env`（如 `FORGEJO_MCP_WRITE_TOOLS=createIssueComment`；
  宿主注入 token 的 `env` 构造点是 `:265-270`）。
  MCP 子进程的 `mcp/tools.ts` 用同一套"环境变量即设置"的既有模式（`FORGEJO_MCP_SYNC_API_URLS`
  在 `mcp/server.ts:120` 的读法）解析它。
- **开关改动必须触发重解析**：provider 已经因为 `http.proxy`（以及新落地的 `mcpEnabled`）
  在 `onDidChangeMcpServerDefinitions` 上重解析（`src/mcpServerProvider.ts:145-151`），把新键加进
  同一个 `affectsConfiguration` 判断即可，否则用户打开开关后要重载窗口才生效。

### 3.4 杠杆三：扩展宿主 broker 能做与不能做

broker 路径（`docs/architecture/mcp-server.md:236-324`）值得单独说，因为它**确实**让扩展宿主亲自
创建 MCP server（`src/mcpBroker.ts:315-341`，其中 `:337` 调 `createMcpServer`），因此在原理上可以弹框。但：

- **能做**：宿主侧工具处理函数里可以调用任何 `vscode` API，包括
  `vscode.window.showWarningMessage(..., { modal: true }, ...)`。仓库里已有现成范式：
  webview 破坏性命令的宿主侧确认 `_confirmDestructive`（`src/webview/viewProvider.ts:4645-4649`），
  它存在的理由（"webview 是不可信的，必须宿主再问一次"，`viewProvider.ts:4638-4644`）正好可以
  平移过来："工具调用来自 LLM，同样不可信，必须宿主问一次"。
- **不能做**：broker 会话与"哪个窗口是用户正在看的窗口"没有绑定关系。broker 是**全机器唯一**的
  （`src/mcpBroker.ts:122-131`，先绑定的窗口赢，其余 `EADDRINUSE` 让位），而一个会话的 cwd 可能
  属于**任何**窗口的工作区（`src/mcpBroker.ts:250-298` 的 `findBrokerStateMatch` 专门处理这件
  事）。所以"在正确的窗口里弹框"本身就需要额外设计：要么在持有 broker 的那个窗口弹（可能是用户
  没在看的窗口），要么先按 `findBrokerStateMatch` 找到会话所属窗口、把请求路由过去——后者是一个
  新的跨窗口 UI 路由机制，不是本文范围。
- **风险**：模态框会**阻塞**该 MCP 工具调用直到用户响应或超时。一个没人看的窗口弹出的模态框会
  让 agent 会话挂住。MCP 的 stdio 会话没有给工具结果定义"等用户"这种中间态。
- **结论**：**首版不在 broker 路径上加宿主侧模态框。** 用"不标 `readOnlyHint` + 逐工具开关"覆盖
  两条路径，把宿主侧模态框列为**可选的第二阶段**，并且只在解决了"路由到哪个窗口"与"超时/无人
  响应"这两个问题之后才做（见 §9 阶段 3）。

### 3.5 杠杆四：工具描述必须写明副作用

工具描述是 agent 唯一必然读到的合约（本仓库已经这么用：`get_pr_review_brief` 的长描述逐项列出
它刻意省略了什么，`mcp/tools.ts:1961-1979`）。写工具的 `description` 必须至少包含：

1. 这是一次**会改变服务端状态**的写操作，会产生用户可见的持久记录；
2. 精确的副作用边界（"在 issue/PR 下新增一条评论；不改标题、不改状态、不合并"；
   "提交一条 review，结论为 COMMENT / APPROVE / REQUEST_CHANGES 之一"）；
3. 需要 `write:issue` 级别的 token scope，缺 scope 时服务端回 403；
4. 该工具是否受设置开关约束（关闭时返回明确拒绝文本，见 §5）；
5. 幂等键语义与 retry 建议（§6）；
6. `dryRun` 的用法建议。

描述是英文（既有约定：MCP 侧输出文案保持英文，`TODO.md:28`）。

### 3.6 与 Codeberg 约束的关系

`AGENTS.md:96-106` 记录：Codeberg 的服务条款不欢迎"看起来由 LLM agent 自主维护"的项目，要求保留
人类维护信号。对本设计的直接影响：

- **"人类确认"必须是默认路径**，而不是一个需要用户去开启的增强项。具体落地为：写工具默认
  **不可见/不可用**（开关关闭时连工具注册都跳过或返回拒绝），开关文案明确写出"会让 AI 以你的
  名义在该实例上留下公开记录"。
- 在设置文案与本文里都要提示：VS Code 侧的"总是允许"会绕过逐次审批，那等于把自主权交给 agent，
  与本项目的托管政策相悖，不建议开启。
- 不做任何"agent 自动 approve / 自动 merge / 自动发 release"的能力。首批两个工具都只产生
  **人类可读的公开文字**，且提交 review 的 `APPROVE` 结论需要用户在审批对话框里再确认一次
  （这是 §3.2 的默认效果，不需要额外机制）。

---

## 4. 首批工具的选择

### 4.1 事实：重跑 workflow 目前做不了

任务是"首批只开创建评论 / 提交 review / 重跑 workflow"，但按当前依赖树，第三个做不到：

- `packages/forgejo-api/spec/swagger.v1.json` 里 `/repos/{owner}/{repo}/actions/runs/{run_id}`
  的存在路径只有 `.../runs/{run_id}`（:6258）、`.../artifacts`（:6357）、`.../cancel`（:6425）、
  `.../jobs`（:6473）、`.../logs`（:6523）。**全文件搜索 `rerun` 无任何命中**（`Select-String`
  零结果）。
- `KNOWN_ISSUES.md:73-79` 已把这件事记为平台限制，并给出服务端源码层面的证据（rerun 只作为
  session 认证的 web 路由存在）。
- `ROADMAP.md:17` 把 rerun 明确列在"等上游版本：Forgejo v17（约 2026-10 底）"里，
  并且要求用版本闸门 + 同步移除 `KNOWN_ISSUES` 条目。**`TODO.md:17` 与 `ROADMAP.md` 在这一点上
  是一致的**，`TODO.md:35` 的措辞（"首批只开创建评论 / 提交 review / 重跑 workflow"）需要按此
  修正。
- 客户端侧也没有对应方法：`src/api/client.ts` 的 Actions 写操作只有 `cancelActionRun`（:1006）
  与 `deleteActionRun`（:1128）。

**决策**：首批 = `create_issue_comment` + `submit_pull_review`。
`rerun_action_run` 作为**依赖阻塞项**登记（等 v17 端点 + 复现验证），不占首版范围。
如果维护者坚持首版就要一个"Actions 侧"的写工具，唯一现在就成立的是 `cancel_action_run`
（`src/api/client.ts:1056`，`POST .../cancel` 在 spec 里存在），但它与"重跑"的语义不同，
且用户侧已有按钮，收益不明显——列为备选而非首批。

### 4.2 两个首批工具各自需要什么

| 项           | `create_issue_comment`                                                                          | `submit_pull_review`                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 客户端方法   | `createIssueComment(owner, repo, index, body)`，`src/api/client.ts:2517`                        | `submitPullReview(owner, repo, index, reviewId, event, body?)`，`src/api/client.ts:2680` |
| 入参         | `owner`, `repo`, `index`, `body`                                                                | `owner`, `repo`, `index`, `reviewId`, `event`(枚举), `body?`                             |
| 关键校验     | `owner`/`repo` 走既有 `pathSegmentSchema`（`mcp/tools.ts:1276-1284`）；`body` 需非空 + 长度上限 | 同上；`event` 用 `z.enum` 限定，不能透传任意字符串到服务端                               |
| 结果         | 返回新评论的 `id` 与 `html_url`（可让用户直接打开确认）                                         | 返回 review 的 `id`/`state`/`html_url`                                                   |
| 需要的新注解 | `readOnlyHint: false`，`idempotentHint: false`，`destructiveHint` 不设                          | 同左                                                                                     |
| 失败面       | 403（缺 `write:issue`）、404（issue 不存在或不可见）、422（空正文/被限流）                      | 403、404、409/422（review 已被提交或状态冲突）、正文字数为空且 event 非 COMMENT          |
| 幂等         | 用调用方提供的 `idempotencyKey`（§6）                                                           | 同左；另外"提交同一条 review 两次"服务端会拒绝，天然有一层保护                           |

补充一个首版应避免的坑：`submitPullReview` 的 `event` 是裸 `string`（`client.ts:2853`，默认
`'COMMENT'`），而 `mcp/tools.ts` 的入参校验是唯一能挡住模型乱填的地方；服务端收到
`REQUEST_CHANGES` 与 `CHANGES_REQUESTED` 两种拼写，仓库里已有 `isChangesRequestedState`
（`mcp/tools.ts:607`）为读侧处理了这个二义性。**写侧必须只用一种拼写**（建议
`REQUEST_CHANGES`，Forgejo 自己的 `ReviewStateType`），并在工具描述里写明，否则 agent 的
"要求修改"可能某天变成一个 422。

---

## 5. 没有扩展宿主时必须发生什么

**要求：写工具拒绝，绝不降级。**

现状（`mcp/server.ts:37-110`）的降级链是：broker 转发 → 失败则零配置自动发现 → 匿名只读。
第 2、3 步里 `token` 可能是空串（`mcp/server.ts:115-118` 明确记录了匿名分支），也可能是用户
手写在 `mcp.json` 的 `env.FORGEJO_MCP_TOKEN` 里（`docs/architecture/mcp-server.md:544-547`
把这条路作为"扩展没跑但想认证"的官方建议）。**这两种情况对读工具无害，对写工具不可接受**：

- 匿名 → 写请求必定 401，但这已经是一次"尝试"，而且错误文本会让 agent 以为是权限问题而不是
  "本会话不允许写"。
- 用户手写明文 token → 写操作**会成功**，而这条路径完全绕开了扩展的逐项开关与审计。这不是
  "降级"，是"放飞"。

**决策**：给会话加一个显式的**来源标记**，写工具只在标记为"宿主注入"时可用。

- 机制：`src/mcpServerProvider.ts:265-270` 的 `env` 已经由宿主独占构造，加一个内部分隔用的键
  （例如 `FORGEJO_MCP_WRITE_TOOLS=<逗号分隔的工具名>`）。**没有这个键就没有写工具**——
  零配置路径、broker 不可用路径、用户手写 `mcp.json` 路径都不会有它。
- broker 路径同样满足：`createBrokerMcpServer`（`src/mcpBroker.ts:315-341`）是宿主进程内的函数，
  它给 `createMcpServer` 传的就是同一个 `WorkspaceContextOptions` 风格的对象，把允许的写工具
  一并传下去即可（注意它必须**独立**计算，不能从子进程环境继承，因为 broker 会话可能来自任何
  静态配置）。
- 拒绝时的返回必须是**成功的工具结果 + 明确的拒绝文本**，而不是 `isError: true`：
  `callTool` 的错误路径（`mcp/tools.ts:1577-1597`）会把消息渲染成 `isError`，agent 容易把它读成
  "重试一下可能就好"。用普通结果说明"本会话未启用写工具，原因是 <没有扩展宿主 / 开关未开启>，
  请用户在扩展设置里开启"，让 agent 停下来问人。
- **绝不做**的事：子进程自己去读 SecretStorage / `state.vscdb` / OS keychain。
  `docs/architecture/mcp-server.md:538-543` 已经把这条边界写成设计决定（"从外部进程伸手进凭据存储
  正是凭据窃取的样子"），本文不改变它。

---

## 6. 幂等与重复提交保护

**风险面**：agent 会因为超时、上下文截断或"看起来没反应"而重试；VS Code 的审批对话框也可能被
连点两次。

**决策**：

1. 两个写工具都接受可选参数 `idempotencyKey: string`（建议由 agent 生成一个稳定的随机串，
   并在描述里要求"同一次逻辑操作重试时必须复用同一个 key"）。
2. 幂等表放在**会话内存**里（`mcp/tools.ts` 层，每个 MCP server 实例一份；注意 broker 的
   "每连接一个 server 实例"语义，`mcp/brokerServer.ts:27-29`，所以表的生命周期正好等于一个
   会话）。条目内容：key → { tool, 目标三元组, 结果摘要, 完成时间 }；TTL 建议 10 分钟，
   容量上限（如 32 条）防止 agent 刷爆内存。
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

**要，但只是工具参数，不是第三种运行模式。**

理由：

- 对 agent 来说，最有价值的并不是"能撤销"（写操作不可撤销），而是"能在真正提交前把计划念给
  用户听"。一个 `dryRun: true` 的调用返回"将要提交: 实例 A / owner/repo / issue #12 /
  正文 341 字符 / 摘要 9f2c…"，用户可以在审批对话框里对着这段话点"允许"或"拒绝"。
- 这与本仓库既有的"preview/confirm"基因一致：`get_pr_review_brief` 刻意"只给形状不给正文"
  （`mcp/tools.ts:1131-1138`），让 agent 拿到决策依据而不必先付出读全量 diff 的代价；
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
`src/extension.ts:54` 装好）。

字段：

- 时间戳、工具名、`dryRun`、幂等键**前缀**（前 8 字符，便于关联但不记录全量以免被当成凭据）；
- 实例**名称**与 id（不写 token；URL 走既有 `redactUrlUserinfo` 规则，
  `src/api/versionProbe.ts:15`）；
- 目标：`owner/repo#index`（review 再加 `reviewId`）；
- 正文：**字节数 + 内容摘要哈希**（sha256 前 12 位）。**不记正文全文**——评论可能含用户粘贴的
  敏感内容，而 Output Channel 是用户会随手复制粘贴到 issue 里的东西；
- 结果：`ok` / `http:<status>` / `refused:<reason>` / `duplicate`，以及服务端返回的对象 id 与
  `html_url`；
- 耗时毫秒数。

**必须承认的缺口**：

- 日志是**按窗口**的，且 broker 会话记在**持有 broker 的那个窗口**（`src/mcpBroker.ts:122-131`），
  所以用户可能在"另一个窗口的 Output Channel"里才看到记录。这一点要写进 FAQ 而不是假装日志
  是全局的。
- 日志默认只在 Output Channel 里，**不落盘**、不跨会话保留（`logger.ts` 是 OutputChannel
  包装）。如果维护者要求"可审计的持久记录"，那需要新的设计（append-only 文件 + 轮转），
  见 §13 开放问题。
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

### 阶段 1 — `create_issue_comment`

- 先做"人类确认成本最低"的那一个：单次追加、无状态机、结果可直接在网页界面核对。
- 需要：handler + schema + 描述（§3.5 六项）+ dry-run + 幂等表 + 审计日志。
- 测试必须钉住：
  - 关闭开关 → 拒绝，且**没有发出任何 HTTP 请求**（用 MSW 断言请求数为 0，而不是只看返回文本）；
  - 打开开关但无宿主来源标记 → 拒绝，同样断言零请求；
  - 打开开关 + 有标记 → 走 `createIssueComment`，返回含 id 与 url；
  - 同 key 重放 → 只发一次请求（MSW 计数），返回重复说明；
  - 同 key 不同正文 → 错误；
  - `dryRun: true` → 零请求 + 结果里含目标与正文长度；
  - 正文为空 / 超长 → 校验失败，零请求；
  - 403 带 `write:issue` 的响应体 → 工具文本里出现"lack the required scope"类的信息
    （注意：宿主侧的 403 toast 在无头进程里是 no-op，`src/api/clientHost.ts:28-33`，
    所以**只有工具文本能告诉用户该改 token**，这条必须有测试）；
  - 不复用 `readOnly` 注解对象（断言 `readOnlyHint !== true`）。

### 阶段 2 — `submit_pull_review`

- 需要额外的东西：`event` 的枚举与拼写决策（§4.2）；对 `APPROVE` 的额外文案（"这会算作一次
  正式批准，可能满足分支保护要求"）；对 `REQUEST_CHANGES` 的额外文案。
- 额外的测试：`event` 非法值被 schema 拒绝；`APPROVE` 与 `REQUEST_CHANGES` 各自映射到正确的
  请求体（用 MSW 读取请求体断言，而不是只看返回）。
- 建议在阶段 2 交付时同时给 `docs/architecture/mcp-server.md` 的 "Security model" /
  "Future directions" 两节补上写工具的现状描述（当前 `:530-531`、`:611-617` 只是预告）。

### 阶段 3（可选，需单独批准）— broker 会话的宿主侧模态框

前置条件，缺一不可：

1. 解决"在哪个窗口问"——需要把会话按 `findBrokerStateMatch`（`src/mcpBroker.ts:250-298`）路由到
   会话所属窗口，并有一个"该窗口不可用"的兜底；
2. 解决"无人响应"——模态框必须有超时，超时等于拒绝，且这个语义要写进工具结果；
3. 有实测证据表明 VS Code 的逐次审批在真实会话里确实会弹（本仓库尚**没有**这项实测，见 §11）。

在这三条满足前，不要实现宿主侧模态框："一个没人看的窗口弹了一个阻塞性的框"比"由 VS Code
审批"更糟。

---

## 10. 风险

| 风险                        | 影响             | 现状下的处置                                                             |
| --------------------------- | ---------------- | ------------------------------------------------------------------------ |
| 用户/客户端关掉逐次审批     | 写操作不再有人看 | 逐工具开关是第二道闸门；设置文案明确警告；不提供任何"自动批量"能力       |
| agent 重试导致重复评论      | 公开的噪音记录   | 幂等键 + 描述里的 retry 指引；承认残余风险（§6.4）                       |
| token scope 不足            | 403，工具失败    | 工具文本点名 scope（宿主 toast 在无头进程无效）；阶段 1 测试锁住这条文本 |
| 误把写工具当成只读          | 无确认执行       | `readOnlyHint` 不设 + 测试断言 + 描述首句声明副作用                      |
| 静态配置里手写 token 的会话 | 绕过全部闸门     | 来源标记缺失 → 拒绝；这也是 §5 的核心                                    |
| 审计日志不在用户当前窗口    | 用户以为"没发生" | 工具结果返回 `html_url`；FAQ 说明日志按窗口                              |
| Codeberg 政策观感           | 项目托管风险     | 默认关闭 + 人类确认默认 + 明确不做自动 approve/merge                     |

---

## 11. 会改变本决策的证据

1. **VS Code 的审批实测缺失。** 本仓库记录了"只读工具不弹框"，但**没有**任何实测证据表明
   "不标 `readOnlyHint` 时 VS Code 一定会弹框"，也没有证据表明它在"总是允许"设置下会怎样。
   阶段 0 结束前必须用 `tools/ui-review/` 的隔离 dev host 实测一次（README：
   `tools/ui-review/README.md` 的走查清单），把结果回填到本文与
   `docs/architecture/mcp-server.md:562-570`。**如果实测表明它不弹框，整个阶段 1/2 必须停，
   改为先做 broker 侧宿主确认（阶段 3）。**
2. **如果 Codeberg 或上游明确表示"任何由扩展代发的公开文字都不可接受"**，那么正确做法是把
   首批工具从"直接提交"改成"生成 draft + 由用户在扩展的 UI 里点提交"，那是另一份设计。
3. **如果 Forgejo ≥ 17 落地 rerun 端点**，把 `rerun_action_run` 提回首批（并同步改
   `KNOWN_ISSUES.md:73-79` 与 `KNOWN_ISSUES.zh.md` 的对应条目、`ROADMAP.md:17`、
   `TODO.md:17`），同时按 §9 的模式给它单独一个开关。
4. **如果出现"持久审计日志"的硬需求**（合规、多用户机器），阶段 1 之前要先设计落盘审计
   （append-only + 轮转 + 与 `docs/release.md` 的数据保留说明对齐）。
5. **如果 MCP 规范或 VS Code 引入"需要人类确认"的正式注解位**（而不是只靠不标只读），本文的
   §3.2 与 §3.4 应当收敛到那一个机制上，删掉自定义的便利设施。

---

## 12. 事实核对清单

本文所有关于现状的断言都来自以下已读代码行（HEAD `b14d764`，"读"= 本次会话实际打开核对）：

| 断言                                                          | 位置                                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 只读注解对象与 `readOnlyHint: true`                           | `packages/forgejo-toolkit/mcp/tools.ts:1583`                                                                      |
| 每个工具挂同一个 `readOnly` 注解                              | `packages/forgejo-toolkit/mcp/tools.ts` 全文（28 处 `annotations: readOnly`）                                     |
| 测试锁死"所有工具只读"与工具名集合                            | `packages/forgejo-toolkit/mcp/__tests__/server.test.ts:63-98`                                                     |
| 工具名是 `ToolName`，新工具必须进 `PAGED_LISTS`               | `packages/forgejo-toolkit/mcp/tools.ts:1226`、`:1361-1401`                                                        |
| `callTool` 的错误渲染路径                                     | `packages/forgejo-toolkit/mcp/tools.ts:1577-1597`                                                                 |
| 路径段校验 schema                                             | `packages/forgejo-toolkit/mcp/tools.ts:1239-1292`                                                                 |
| `REQUEST_CHANGES` / `CHANGES_REQUESTED` 二义性（读侧已处理）  | `packages/forgejo-toolkit/mcp/tools.ts:607`                                                                       |
| `createIssueComment`                                          | `packages/forgejo-toolkit/src/api/client.ts:2678-2680`                                                            |
| `submitPullReview`（`event: string = 'COMMENT'`）             | `packages/forgejo-toolkit/src/api/client.ts:2853-2869`                                                            |
| `cancelActionRun` / `deleteActionRun`（Actions 侧现有写操作） | `packages/forgejo-toolkit/src/api/client.ts:1056`、`:1178`                                                        |
| 宿主注入 token 的 env 构造点                                  | `packages/forgejo-toolkit/src/mcpServerProvider.ts:265-270`、`:299`                                               |
| provider 因配置变化重解析                                     | `packages/forgejo-toolkit/src/mcpServerProvider.ts:145-151`                                                       |
| 设置项先例（轮询开关 + 双语文案）                             | `packages/forgejo-toolkit/package.json:113-124`、`package.nls.json:20-21`、`package.nls.zh-cn.json:20-21`         |
| 无头进程读不到设置，只能靠环境变量                            | `docs/architecture/mcp-server.md:94-101`                                                                          |
| 降级链：broker → 零配置 → 匿名                                | `packages/forgejo-toolkit/mcp/server.ts:37-118`                                                                   |
| 匿名分支的显式日志                                            | `packages/forgejo-toolkit/mcp/server.ts:115-118`                                                                  |
| broker 会话由宿主创建 MCP server                              | `packages/forgejo-toolkit/src/mcpBroker.ts:315-342`                                                               |
| broker 全机器唯一、先绑定者赢                                 | `packages/forgejo-toolkit/src/mcpBroker.ts:122-131`、`:163-174`                                                   |
| broker 会话可能属于别的窗口                                   | `packages/forgejo-toolkit/src/mcpBroker.ts:250-298`                                                               |
| broker 每连接一个 server 实例                                 | `packages/forgejo-toolkit/mcp/brokerServer.ts:27-29`                                                              |
| 宿主侧破坏性确认的既有范式                                    | `packages/forgejo-toolkit/src/webview/viewProvider.ts:4638-4649`                                                  |
| 无头 client host 的 401/403 hook 是 no-op                     | `packages/forgejo-toolkit/src/api/clientHost.ts:28-33`                                                            |
| 403 + scope 的识别与文案                                      | `packages/forgejo-toolkit/src/api/client.ts:3200-3221`、`src/api/vscodeClientHost.ts:141-158`                     |
| `write:issue` 的 403 语义已被记录                             | `KNOWN_ISSUES.md:25`（及 `KNOWN_ISSUES.zh.md` 对应条目）                                                          |
| spec 里没有 rerun 端点                                        | `packages/forgejo-api/spec/swagger.v1.json`（`:6258/:6357/:6425/:6473/:6523` 是全部 runs 子路径；`rerun` 零命中） |
| rerun 是平台限制、等 v17                                      | `KNOWN_ISSUES.md:73-79`、`ROADMAP.md:17`、`TODO.md:17`                                                            |
| MCP 侧文案保持英文                                            | `TODO.md:28`                                                                                                      |
| Codeberg 对 LLM 自主维护的态度                                | `AGENTS.md:96-106`                                                                                                |
| 构建期禁止 mcp 入口引入 `vscode`                              | `docs/architecture/mcp-server.md:66-73`                                                                           |
| 只读工具不弹确认框 / Phase 2 预告                             | `docs/architecture/mcp-server.md:562-570`、`:611-617`                                                             |
| 不从外部进程读凭据存储的设计决定                              | `docs/architecture/mcp-server.md:528-547`                                                                         |
| 走查 harness 的位置与用法                                     | `tools/ui-review/README.md`（"Release walkthrough checklist"）                                                    |

---

## 13. 留给维护者的开放问题

1. **`readOnlyHint` 的实测结论是什么？** 在真实 VS Code（含"总是允许"开启的配置）里，不标
   `readOnlyHint` 的 MCP 工具到底弹不弹、能不能被用户永久放行？这是本文最大的未验证前提
   （§11.1）。需要一次 dev host 实测并留证。
2. **开关粒度**：逐工具（本文建议）还是"写工具总开关"？逐工具更贴合 Codeberg 那条约束，
   但设置页要放 2–N 个开关。
3. **首批是否包含 `cancel_action_run`**（唯一现在就能做的 Actions 写操作，语义是"取消"而不是
   "重跑"）？如果包含，它是第三个开关。
4. **`rerun_action_run` 是否接受"依赖 Forgejo ≥ 17 + 版本闸门"的推迟**，还是要求现在就用手写
   web 路由实现（本文与 `KNOWN_ISSUES.md:73-79` 都反对）？
5. **审计要不要落盘**（跨会话、可检索），还是 Output Channel 足够？如果落盘，数据保留与
   `docs/release.md` 的说明需要一起改。
6. **幂等键 TTL 与容量**（本文给 10 分钟 / 32 条）是否合适？是否需要在设置里暴露？
7. **工具命名**：`create_issue_comment` / `submit_pull_review` 是否与既有 30 个工具（下划线、
   动词在前）风格一致，还是应当叫 `add_issue_comment`（与扩展内部命令
   `addPullReviewComment` 对齐）？命名一旦发布就是对外契约。
8. **要不要在阶段 1 之前把"写工具未启用"的拒绝文案做成 prompt 模板的一部分**，让 agent 在遇到
   拒绝时自动转向"请用户在设置里开启"，而不是反复重试？
9. **`dryRun` 是否也需要单独开关？** 本文认为不需要（它不产生副作用），但它确实是一条可以
   用来探测仓库存在性的路径——如果维护者认为这算信息泄露，可以把它也纳入开关。
