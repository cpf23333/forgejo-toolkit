# AI 模型传输的接缝与第二种实现（OpenAI 兼容端点）

- 状态：**设计已定稿；接缝与第二种传输连同它的设置面已实施，webview 那一半也已实施（2026-10-04），
  接进 AI 预评审的端到端接线已实施并在真实编辑器里走查通过（2026-10-05）；导出/导入（§10、§11.4）也已实施
  （2026-10-06：`version: 3` 的 `ai` 段、导入预览的冲突三选一与 `http://` 提示、逐字段校验、密钥只进加密导出、
  导入不得静默启用出网，均有测试；§11.4 的落地记录见该节）**。接在这道接缝上的功能已有两条：AI 预评审，以及
  PR 描述生成（2026-10-06，它特有的决定——材料只从 `/compare` 取、自己的开关与范围、不发 hunk——在
  [`ai-pr-description.md`](./ai-pr-description.md)，本文不重复）。Issue 分诊 / 通知摘要按
  `selectedModelFor(feature)` 接的活还没做（它们是各自的独立功能，见 `FEATURES.md`
  的「未完成」与 §11.4）。「为常见本地服务预填地址」已决定不做，理由见 §12。（本文只写决定与理由。）阶段划分与
  每阶段的验收口径见 §11；动手前需要确认的未知见 §13；已核实的事实见 §16。
  **2026-10-06 的设置面裁决（维护者）已就地写进 §8**：目的地分成两层——一条**默认目的地**
  （`forgejoToolkit.aiDefaultProvider` + `forgejoToolkit.aiDefaultModel`，两个平铺字符串）是主路径，逐功能
  `aiModelBindings` 降级为叠加在它之上的**覆盖项**；§8.2 的归属表、§8.3 的设置清单与 §8.4 的次序表都按现状更新，
  页面的呈现规格在 [`settings-page.md`](./settings-page.md) 的 §3.2。
  **2026-10-06 的第二次设置面裁决（维护者，同一改动）**：`forgejoToolkit.aiProvidersEnabled` 与
  `forgejoToolkit.aiLocalOnly` 连同整套地址策略（含逐端点的 `localOnly` 承诺、`isLocalAiEndpointHost` 与它的
  测试）被**整体移除**，位置由一个全局开关 `forgejoToolkit.aiEnabled`（默认**开**）接替；它说的是"完全不要用
  AI"，在逐功能开关之上，关闭时连编辑器自己提供的模型也不问。维护者的两条理由、新的三层分工与"导入永不打开任何开关"
  的规则写在 §8.3、§8.8 与 §10.3；三层分工在设置页上的呈现见
  [`settings-page.md`](./settings-page.md) 的 §3.2。

- 适用范围：**宿主侧 AI 功能取用一个模型的那一步**。当前已交付的只有 AI 预评审（draft-only，见
  [`ai-prereview.md`](./ai-prereview.md)），本文用它的调用点来定接缝的形状。不含 MCP 工具面、不含自动提交 /
  自动 approve、不含 webview 里的任何模型调用（`vscode.lm` 只在扩展宿主可用）。

- 本文**不是**任务清单：本项工作已交付，`TODO.md` 原先跟踪它的那条 P4 条目随交付移除（`TODO.md` 只保留未完成
  事项）——这项工作的记录因此是 `FEATURES.md` 的「AI 端点（OpenAI 兼容）」条目（用户可见的能力）与本文自身：本文
  只承担"定了什么、为什么、否掉了什么"，落地过程在提交历史里。第二个接上这道接缝的功能（PR 描述生成）的待办仍在
  `TODO.md` 的「P2 PR 描述生成的行级 diff」条目，它特有的决定在
  [`ai-pr-description.md`](./ai-pr-description.md)。

- 关联：宿主侧 AI 调用的方向由 [`../architecture/mcp-server.md`](../architecture/mcp-server.md) 的
  「Security model」一节末段写明（"UI-facing AI features … should instead use `vscode.lm` on the host"）；
  外发内容的隐私纪律与"默认关闭"的先例来自 [`ai-prereview.md`](./ai-prereview.md)；写侧"默认关闭 + 逐次确认"
  的先例来自 [`mcp-write-tools-confirmation.md`](./mcp-write-tools-confirmation.md)；扩展已上架 Open VSX（见
  `README.md` 的「Open VSX」一节），没有 Copilot 的编辑器正是本文面对的用户。

- 基线代码：写作时为 HEAD `9e1ffede`（工作树干净）。工作树里可能有其他 agent 的在途改动，**行号会漂移**，所以
  每条断言都给**可搜索的符号名 / 标识符**；以符号名为准，行号只用于加速定位。核对清单见 §16。

## 现状摘要

- **只有一条路**：AI 预评审取模型、调模型、量 token 全部直接对着 `vscode.LanguageModelChat` 写，没有任何中间
  层（§3.1）。
- **送什么由用户选，且只问一次**：`forgejoToolkit.aiPreReviewPromptScope` 的五个取值与那个模态框是现行的外发
  同意面，模态框里那句"送给你选的模型所属的提供者"是本文必须改写的**唯一**一处措辞（§7.1）。
- **设置面是"手工起名"的一层**：模型选择只是 `vendor/family` 或 `vendor/id` 的自由文本，运行时列表只存在于
  设置页的一次消息往返里，manifest 的下拉做不成（§3.1、§8.3）。
- **密钥已有先例**：实例 token 只在 `SecretStorage`，从不下放 settings，导出时**只有选了加密才包含**（§8.2、
  §10.2）。
- **请求层已有先例**：`shared/request` 的薄客户端 + 代理 dispatcher 对 + 超时合并 + 错误分类（§16）；
  **它没有重试**（§6.6；那处措辞当时写在 `TODO.md` 的那条待办里，条目已随交付移除，原文与纠正都记在 §6.6）。
- **测试面**：MSW 是进程内拦截（不是起一个 HTTP 服务），`src/test/mocks/` 的那套 mock **只在非生产构建里存在**，
  `tools/ui-review/` 的 dev host 正是加载那份构建（§15）。

---

## 1. 问题

AI 预评审的**唯一**模型来源是 `vscode.lm`：

- 没有编辑器提供的模型时，命令直接报"没有可用模型"并结束（§2.1 的 `reportNoChatModel`）；
- 因此"没装 Copilot / 没登录 / 无订阅 / 被策略禁用"的机器上，这个功能一条都用不了，而扩展已经上架 Open VSX，
  正是这类用户最多的地方。

要做的是加一条**用户自配的 OpenAI 兼容端点**。难点不在 HTTP 本身，而在四件事：

| 难点                        | 为什么不能"顺手做"                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------- |
| 接缝的形状                  | 现行调用点要的不只是"一段文本"：它要**两股候选流**、要能取消、要一个先于请求的预算判断 |
| 第二个实现的行为等价性      | 同一句提示词在 `vscode.lm` 与在直连端点上的"答案从哪里取"不是同一个问题（§5.4）        |
| 同意面（外发对象换成了 IP） | 用户配的 base URL 才是真实目的地，一句写死的"你选的提供者"会变成谎话（§7）             |
| 两件事必须**不**发生        | 自动回退到另一条路、以及"导入配置 = 启用出网"（§7.4、§7.5）                            |

**本文的选择**：先抽接缝（阶段 1，纯重构、零行为变化），再实现第二个传输（阶段 2），再把已交付的 AI 预评审接上
（阶段 3）。**默认仍是 `vscode.lm`**：`aiTransport` 默认 `auto`，而 `auto` 只在编辑器一个模型都提供不了时才去看
已配置的端点。一条直连请求要真正发出，需要端点已配置、密钥已存、某个功能（默认目的地或逐功能覆盖）**点名**了它，
以及那次运行自己的外发同意——§7.3 把这几件事分开列，是因为任何两件都不能互相推断。

### 1.1 三条与本文的边界直接相关的事实

1. **`vscode.lm` 接的是编辑器里所有贡献语言模型的扩展，不只是 Copilot**（`lm.selectChatModels` 的类型面就是
   如此）。所以"没有订阅"未必等于"没有模型"，这条要写进用户可见文案（§9.1）。
2. **BYOK 是否经 `vscode.lm` 暴露给我们，本文未能核实**：VS Code 自带的"在 Copilot 里添加 Anthropic / OpenAI /
   Gemini / Ollama 密钥"若确实走 `vscode.lm`，直连的主要价值就集中在 VSCodium 这类编辑器上。列为 §13 的第一条。
3. **`vscode.env.appName` / `uriScheme` / `appHost` / `remoteName` 在本仓库里一次都没被读过**（可搜索确认）。这
   正好符合"按能力判断、按品牌只做诊断"的要求：本文不引入品牌判断，见 §9。

---

## 2. 决策（摘要）

1. **一道接缝**：新增内部接口 `AiModelTransport`（`id` / 取模型 / 量 token / 跑一次带流式的请求），AI 功能只
   依赖它。形状由**现行调用点真正需要的东西**反推，不多一条（§4）。
2. **两个实现**：`VscodeLmTransport`（把今天的代码原封不动搬进去，**逐字节零行为变化**，§5）与
   `OpenAiCompatibleTransport`（用户自配端点，§6）。
3. **一个选择点**：`selectedModelFor(feature)` 是唯一决定"这次走哪条路、用哪个模型"的地方，设置在
   `forgejoToolkit.aiModelBindings`（§8.4）。它只挑不换：挑不中即失败，**不换路**（§7.5）。
4. **默认仍是 `vscode.lm`**：`forgejoToolkit.aiTransport` 默认 `auto`，而 `auto` 在配置了 provider **且**有逐功能
   绑定时才走直连；否则走 `vscode.lm`。**直连绝不是默认目的地**（§3.3）。
5. **外发同意说真话**：那个一次性模态框的目的地说法改成"发给你配置的 `<显示名>`（`<base URL>`）"，端点为空时
   仍是"你选的模型所属的提供者"。**回答之前什么都不发**（§7.1–§7.3）。
6. **导入不得静默出网**：非密字段进导出 JSON，**密钥与自定义 header 的 value 只进加密导出**；导入
   **不写**任何开关、**不写** scope 设置（§10）。
7. **能力不足就明说**：没有可用模型时按能力判断（`vscode.lm` 是否存在 + `selectChatModels()` 是否为空），设置页
   明说并给两条路；端点做不到的事（工具调用、可靠 JSON）**明确降级**，不悄悄换行为（§9）。
8. **明确不做**：为每家写原生 SDK、让 MCP 侧调模型、两传输间自动回退或负载均衡、token 计费统计、模型/供应商
   预设市场（§12）。

---

## 3. 现状摘要之外的四个前提

### 3.1 「今天在哪儿调模型」的完整清单（§2.1 的证据）

AI 预评审里与"取模型"直接有关的符号（都可在 `packages/forgejo-toolkit/src/` 下搜索）：

| 关注点         | 符号                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 取模型清单     | `aiPreReviewModels.ts` 的 `queryAiPreReviewChatModels` / `uniqueAiPreReviewModels`                                                |
| 模型身份       | 同上文件的 `aiPreReviewModelIdentity` / `aiPreReviewModelKey` / `maxInputTokensOf`                                                |
| 设置与解析     | `aiPreReviewSettings.ts` 的 `AI_PRE_REVIEW_MODEL_SETTING` / `parseAiPreReviewModelSelector` / `matchesAiPreReviewModelSelector`   |
| 一次运行       | `aiPreReview.ts` 的 `runAiPreReview` / `gatherPreReviewRequest`                                                                   |
| 发请求         | 同上文件的 `requestPreReviewComments`（搬进接缝的那一处 `sendRequest`，见下方注）                                                 |
| 预算           | 同上文件的 `validateChosenAiPreReviewModel` / `preparePrompt` / `countRequestTokens` / `countTokens`                              |
| 错误分类       | 同上文件的 `classifyModelError` / `isCancellation` / `reportCancelled`                                                            |
| 无模型时的报告 | 同上文件的 `listAiPreReviewModels` / `reportNoChatModel`                                                                          |
| 重试上限       | 同上文件的 `AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL`（同一模型最多 2 次）                                                            |
| 答案从哪条流取 | 同上文件的 `readResponseCandidates` / `pickResponseCandidate` / `classifyResponsePart`                                            |
| 设置页那一行   | `aiPreReviewModels.ts` 的 `listAiPreReviewChatModelChoices`；`webview/src/views/Settings.vue` 的 `settings.aiPreReviewModel` 一段 |

**注**：`requestPreReviewComments` 不是 `model.sendRequest` 的**唯一**调用点——debug 探测的 `sendProbeRequest` 是
第二条，且**故意留在接缝之外**：它的一种形状刻意发两条 `User` 消息，接缝的"合成一条"（§5.2）会把它拍平，而它的
同意文案也是自己的（说的是一句平凡提问，不是预评审）。

**关键读数**：`requestPreReviewComments` 返回的不是字符串，而是**候选流数组**
（`readResponseCandidates` 产出 `{ kind: 'text' | 'reasoning' | 'text-projection', text }`），由调用方的 JSON
契约**逐条**仲裁（`pickResponseCandidate`），两股候选**绝不拼接**。这不是实现细节，而是接缝必须保住的语义。

### 3.2 逐功能目的地设置的先例

`TODO.md` 的同一节当时把"PR 描述生成 / Issue 分诊 / 通知摘要"这三条都列作 `vscode.lm` 试点。现在的情形是：PR 描述
生成已经交付，它与其他 AI 功能一样由 §8.4 的 `selectedModelFor(feature)` 取模型；另外两条尚未落地，`TODO.md` 里各自
的条目也已写明它们按同一个选择点接。有了两条传输，"哪个功能用哪个
provider / 模型"就必须是一个显式的、可见的设置，而不是各自模块里的隐含默认。这一条在 §8.4 落地成两层：**一条默认
目的地**（`aiDefaultProvider` + `aiDefaultModel`，用户配一次、所有功能照用）加**逐功能覆盖**
（`aiModelBindings`，某个功能要更强或更私密的模型时才写一条）。

### 3.3 「默认」这个词在本仓库的确切含义

`forgejoToolkit.aiPreReview` 默认 `false`，关闭时"命令拒绝，且不向模型供应商发出任何内容"；提示词范围默认
`ask`，`ask` 是**问题**而不是答案，读不到就按 `ask` 处理（fail-closed）。本文沿用同一纪律：新增的开关默认值
必须落在"什么都不发"的一侧——§8.3 的 `aiTransport` 默认 `auto` 即此意。**唯一的例外是全局 AI 开关**
`forgejoToolkit.aiEnabled`：它默认**开**，而且它是本文唯一一个"读不出来就读作允许"的设置；方向为什么反过来，
理由写在 §8.3。

---

## 4. 接缝：一道接口，两个实现

### 4.1 形状从哪儿来（三处硬约束）

1. **取消**：`runAiPreReview` 在 `vscode.window.withProgress(… cancellable: true)` 里跑，token 一路传到
   `sendRequest`；接缝必须收 token，并在流读取时也能停（`readResponseStreamParts` 的 `checkCancelled`）。
2. **预算先于请求**：`validateChosenAiPreReviewModel` 与 `preparePrompt` 都在**第一次 HTTP 请求之前**用
   `model.countTokens` 量文本。接缝必须暴露"量一段文本要多少 token"和"输入上限是多少"，否则这条纪律塌掉。
3. **候选流**：见 §3.1 的读数。接缝按偏好返回候选（文本、推理），两股都没带文本时把 `text` 投影作为**第三条**
   候选返回；只返回一条也合法。

### 4.2 提议的接口（`packages/forgejo-toolkit/src/ai/transport.ts`）

```ts
/** 接缝里的一个模型，等价于今天 `aiPreReviewModelIdentity` 的读数。 */
export interface AiModelInfo {
  /** `vscode.lm` 的 vendor，或 provider id。 */
  vendor: string;
  id: string;
  family?: string;
  /** 显示名；空串表示没有名字，调用方自己兜底。 */
  name: string;
  /**
   * 输入预算（token）。`vscode.lm` 用模型的 `maxInputTokens`；直连端点在拿到
   * `/models` 或响应头之前**量不出来**，此时为 `undefined`，调用方按保守的字符
   * 上限处理并在日志里说明依据（§13 问题 3）。
   */
  maxInputTokens?: number;
}

/** 会话历史里的一个角色。空历史在接缝上合法。 */
export interface AiMessage {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * 一段文本的 token 数；`undefined` 表示这个模型量不出来。
 * 抛异常与 `undefined` 不同：抛异常意味着测量本身失败（键环、进程），
 * `undefined` 意味着"这个模型没有 tokenizer"，调用方对两者的处置不同（§13 问题 3）。
 */
export type AiTokenCounter = (text: string, signal?: AbortSignal) => Promise<number | undefined>;

/**
 * 一次请求的产物。
 *
 * `parts` 是**候选流**，与今天的 `readResponseCandidates` 一一对应，顺序即偏好：
 * 文本候选在前、推理候选在后，`text` 投影垫底（只在两股都没带文本时才读）。
 * 第三个 `'text-projection'` 必须在接缝上看得见，不能折进 `'text'`：调试行、诊断
 * dump 与探测判词都靠它说出"答案来自哪条流"（§5.4），折进去就是可见的行为变化，
 * 而阶段 1 的验收口径正是现有测试一行不改（§11.1）。
 *
 * 工具调用、图片、`usage` 等 part 在接缝上**不出现**：今天的 AI 预评审对它们
 * 的分类就是"忽略"（`classifyResponsePart` 的 `data` 分支），将来要用是另一次
 * 设计（§12）。
 */
export interface AiCompletionResult {
  /** 产生这次回答的模型（诊断、面板头、日志都要说清楚是谁答的）。 */
  model: AiModelInfo;
  /** 最少一条，按偏好排列。 */
  parts: Array<{ kind: 'text' | 'reasoning' | 'text-projection'; text: string }>;
  /** 这次请求真正用哪条流作为"传输层日志"的碎片清单；不保证存在。 */
  fragments?: readonly string[];
  /**
   * 端点**自己说**它撞到了输出上限（`finish_reason: 'length'`）时为真，即这份回答已知不完整（§6.4 第 5 条、
   * §9.2）；接口原先没有承接这个读数的成员，而把它做成抛异常会丢掉 `vscode.lm` 在同一情形下照样返回的那半份
   * 回答——那是 §11.3 不许出现的传输间差异。`undefined` / `false` 只表示"端点没说、或说的是别的"，不是对答案
   * 完不完整的猜测。
   */
  truncated?: boolean;
}

/** 一次请求。 */
export interface AiCompletionRequest {
  /**
   * 指令块。`vscode.lm` 的实现必须把它并进**唯一一条** `User` 消息（§5.1 的
   * 现状事实），OpenAI 实现把它放在 `system` 消息里（§6.3）；接缝本身不定
   * 哪一边——但**两边都不许把它丢掉**。
   */
  system: string;
  /** 会话历史与本次输入。今天的调用点是单条 `User`，接缝不改变这一点。 */
  messages: readonly AiMessage[];
  signal?: AbortSignal;
  /**
   * 这次请求"为什么问"的一句话，交给传输层。`vscode.lm` 把它原样当
   * `sendRequest` 的 `justification`（编辑器自己那句同意对话框文案），所以它是
   * 句子而不是 token，且**不参与协议**；§5.3 那句文案不动，正是这样实现的。
   */
  purpose: string;
}

/**
 * 一个模型传输。
 *
 * `listModels()` 只做查找，**不发送任何内容**——这是"回答模态框之前什么都不发"
 * 能成立的前提（§7.2）。`countTokens` 同理。
 */
export interface AiModelTransport {
  /** 稳定标识，用于日志与诊断：`'vscode.lm'` 或 `'openai-compatible:<providerId>'`。 */
  readonly id: string;
  /**
   * 这个传输**是否可用于任何一次请求**；`false` 时附上给用户看的原因。没有语言
   * 模型 API、或列出模型时抛了异常，都在这里答。"编辑器一个模型都没提供"**不**在
   * 这里答——那是列表自己的读数，由功能层报告（空列表与列出失败是两句不同的话）。
   */
  availability(signal?: AbortSignal): Promise<{ usable: true } | { usable: false; reason: string }>;
  /**
   * 可用的模型，顺序即编辑器的顺序，不做排序或偏好（§9.1）。
   *
   * 它与 `availability()` 是两次独立的查找，现行调用点在正常路径上先问前者再问
   * 它，因此比搬迁前多一次 `selectChatModels()`（两次都只查找、不发送内容）。唯一
   * 可观察的差别是 provider 在两次之间改了答案：那时按"没有可用模型"报告，而不是
   * 按"列出失败"报告。
   */
  listModels(signal?: AbortSignal): Promise<AiModelInfo[]>;
  /** 见上：量不出来是 `undefined`，测量失败是抛。 */
  countTokens(model: AiModelInfo, text: string, signal?: AbortSignal): Promise<number | undefined>;
  complete(model: AiModelInfo, request: AiCompletionRequest): Promise<AiCompletionResult>;
}
```

### 4.3 这个形状**不**包含什么（每条都对应一处被否掉的方案）

| 没放进接缝的东西                  | 为什么                                                                                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxOutputTokens` / `temperature` | 端点之间的默认值语义差别很大（`max_tokens` 必填与否、`temperature` 是否支持）；接缝不发这些字段，全用端点自己的默认值，并用 §6.4 第 5 条、§9.2 的检查兜住"输出被截断" |
| 工具面（`tools` / `toolMode`）    | 今天的调用点不传工具（`requestPreReviewComments` 只传 `justification`），而"工具调用"是划为下一档质量的独立立项，见 `FEATURES.md` 的「预评审按需索取文件」条目（§12） |
| 推理内容的重试或修补              | 今天的规则是"两股候选各自过契约、绝不拼接、绝不修补"（§3.1）；接缝把它原样保留                                                                                        |
| 一次请求内的自动重试              | 今天的重试是**功能层**的（同一模型最多 2 次，`AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL`），且只在"答案不合契约"时发生。接缝不重试，见 §2.5 与 §6.5                        |
| 一个"费用/用量"回调               | §12 明确不做 token 计费统计（这条原先是 `TODO.md` 的条目，该条目已随交付移除）                                                                                        |

---

## 5. 实现一：`VscodeLmTransport`（零行为变化）

### 5.1 搬迁而不是重写

`VscodeLmTransport` 就是把今天的代码搬进一个新文件，一行逻辑都不改：

| 今天的位置                                                                                              | 搬进之后的位置                                       |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `aiPreReviewModels.ts` 的 `queryAiPreReviewChatModels` / `uniqueAiPreReviewModels` / `maxInputTokensOf` | `listModels()` / `availability()` 的实现体           |
| `aiPreReview.ts` 的 `requestPreReviewComments`                                                          | `complete()` 的实现体（含 `sendRequest` 与响应读取） |
| `aiPreReview.ts` 的 `countTokens` / `countRequestTokens`                                                | `countTokens()` 的实现体                             |

与实现对齐的两点说明：`queryAiPreReviewChatModels` / `uniqueAiPreReviewModels` / `maxInputTokensOf` 的 **helper
本身留在 `aiPreReviewModels.ts`**（设置页的模型选择器 `listAiPreReviewChatModelChoices` 同样用它们），搬进
`listModels()` / `availability()` 的是它们的调用与那三个分支，而"没有可用模型"那句仍归功能层的
`reportNoChatModel`；`complete()` 只搬了 `sendRequest` 与响应读取，**错误分类仍留在功能层**——接缝的
`complete()` 没有失败分支，它只把自己观察到的取消抛成 `AbortError`，其余交给原有的 `classifyModelError` /
`isCancellation`（§6.5 对第二种传输的处置与此一致）。

**行为等价性的判据**（阶段 1 的验收口径，§11）：`aiPreReview.test.ts` **一行都不改**地通过。该套件已经钉住了今天
的每一条边角——候选流的三种来源、`$mid` 信封的识别、单消费者、取消、`NoPermissions` 的处理、重试上限、debug 下的
碎片与 part 日志、模型探测（`probeAiPreReviewChatModels`）。它是本次重构唯一可信的等价性证明。

### 5.2 两条必须原样保留的现状事实

1. **没有 system 角色**。`@types/vscode` 1.102.0 的 `LanguageModelChatMessageRole` 只有 `User` 与 `Assistant`，
   `LanguageModelChatMessage` 只有 `User` / `Assistant` 两个工厂；今天的做法是把指令块与正文拼成**一条**
   `User` 消息（`buildAiPreReviewPromptMessages` → `aiPreReviewPromptText`），并且这个决定有理由（一条消息没有
   "被角色转换丢掉的那一半"，预算量的也正是真正发出去的那段文本）。`VscodeLmTransport` **继续这样做**：
   接口上的 `system` 与 `messages` 在实现体里拼成同一条 `User` 消息。
2. **`modelOptions` 不发**。API 文档写明它 provider-specific（"need to be looked up in the respective
   documentation"），今天的代码刻意不发；接缝的 `AiCompletionRequest` 里也没有它。

### 5.3 `justification` 的文案要跟着目的地走

`requestPreReviewComments` 给 `sendRequest` 传的 `justification` 是 `vscode.l10n.t(...)` 的一句
说明，其中已经写了"送什么"（搬迁后这句作为接缝请求的 `purpose` 传下去，由 `vscode.lm` 实现原样交给
`sendRequest`，§4.2）。**它不提目的地**（`vscode.lm` 的对话框由编辑器自己管）。这句文案不动，改的是
§7.1 那个模态框——两处不能互相冒充。

### 5.4 现有的"候选流"如何映射到接缝

- 文本候选：`readResponseCandidates` 里 `collector.textParts.join('')` → `parts[0].kind === 'text'`。
- 推理候选：`collector.reasoningParts.join('')` → `parts[1].kind === 'reasoning'`。
- `text` 投影：这是**编辑器 API 的兜底**，也是**第三条候选**（`parts[].kind === 'text-projection'`，只在两股
  都没有文本时才读）。它必须自己占一个 kind，不能折进 `'text'`：今天的 `notes: [answer stream: …]`、
  `responseCandidateSelectionLogLine` 与探测判词都靠它说出答案来自哪一条流，折进去是可见的行为变化，而阶段 1
  的验收口径是现有测试一行不改（§11.1）。所以"答案来自哪条流"这句话仍由**功能层**在契约仲裁之后写
  （`AiCompletionResult.fragments` 是另一件事：它记的是传输层日志的碎片），接缝的实现体不另写一行。

### 5.5 不许发生的事

`VscodeLmTransport` 不得因为"另一个传输可用"而改变任何行为：它列模型时不看 provider 设置，量 token 时不看
provider 设置，不重试、不换模型、不换路。**传输之间没有回退**这条纪律，一半就落在这一节的实现里。

---

## 6. 实现二：`OpenAiCompatibleTransport`

### 6.1 覆盖哪些端点

**保证覆盖**（阶段 2 的测试对象，MSW mock 就跑这一族）：

| 形态         | 说明                                                             |
| ------------ | ---------------------------------------------------------------- |
| 本机 server  | Ollama（自带 `/v1`）、LM Studio、llama.cpp server、vLLM、LocalAI |
| 自建网关     | LiteLLM、one-api 等 OpenAI 兼容代理                              |
| 托管 gateway | OpenRouter、Together、Groq、DeepSeek、Gemini 的 OpenAI 兼容端点  |
| Azure OpenAI | 靠自定义 header（`api-key`）与 `api-version` 查询参数（§8.5）    |

**协议面**：`POST <base>/chat/completions`（`Authorization: Bearer <key>` 或自定义认证头）、
`GET <base>/models`（能力探测与模型列表，best-effort，§9.1）。

**不覆盖**：见 §6.7。

### 6.2 base URL 怎么拼（这是最容易出错的一处）

- 用户填的 base URL **按原样使用**，只去尾部 `/`；**不自动补 `/v1`**，因为 Azure 的 URL 与"自建网关的
  `/openai/v1`"都会被补错。
- 预设（Ollama `http://localhost:11434/v1`、LM Studio `http://localhost:1234/v1` 等）**只是预填**，写进
  设置里就是普通字符串——预设不是新传输，也不是白名单。
- 完整路径 = `base + '/chat/completions'`。Azure 的 `api-version` 作为查询参数附加，且只在用户配置了它时附加。
- **拒绝**非 `http:` / `https:` 的 scheme（照实例配置的 `isHttpUrl` 纪律，`file:` / `data:` / `javascript:`
  一律不接）；**拒绝**带 userinfo 的 URL（照 `hasUrlUserinfo` 纪律——凭据属于密钥字段，不属于 URL）。
- `http://`（非 TLS）允许但**显著警告**（§10.2），因为"本机 / 内网不出网"正是这条传输存在的理由之一。

### 6.3 请求映射

- `system` → `messages[0] = { role: 'system', content: system }`。
- `messages` → 依次追加 `{ role, content }`。
- **不发** `temperature` / `top_p` / `max_tokens` / `response_format` / `tools`：各端默认值语义不同，发了就是
  在赌某家的默认值；§6.4 第 5 条、§9.2 的截断检查兜住"输出被提前截断"这类失败。
- **不发 `stream_options`**：`include_usage` 不是所有端都认，而用量统计本来就是非目标。

### 6.4 流式（SSE）与聚合

请求带 `stream: true`，响应按 SSE 逐行解析：

1. 按行切；空行是事件分隔，`:` 开头是注释（忽略）。
2. `data: <payload>`；`data: [DONE]` 结束流。
3. JSON 解析失败的行**跳过并计数**（不整场失败）；计数非零时在 debug 日志里说清跳过了几行。
4. `choices[0].delta.content` 追加到**文本候选**；`choices[0].delta.reasoning_content`（DeepSeek 系等）或
   `delta.reasoning`（部分网关）追加到**推理候选**。两者互不拼接。
5. `choices[0].finish_reason` 记下来：`length` 表示被截断，这在已知"契约是 JSON"的功能里是一个**明确的失败
   信号**（§9.2 的降级说明要用它）。它落在接缝上的名字是 `AiCompletionResult.truncated`（§4.2）：功能层读这
   一个成员就能报"回答被截断"，不必自己去看协议字段。**已落地（2026-10-05）**：`src/aiPreReview.ts` 的
   `reportContractFailures` 在契约失败时读它，在原有那句之后补一句"回答被端点自己的输出上限截断"与两条出路
   （§9.2）；这条读数也随该次尝试写进 debug 诊断 dump。`vscode.lm` 不设这个读数，编辑器那条路的报告不变。
6. 流结束后把两股候选各自 `join('')`，产出 `parts`。
7. **非流式兜底**：`stream: true` 未被接受的端（少见）若返回一个完整 JSON 的 `choices[0].message.content`，
   实现体必须能识别并当作文本候选（这也是阶段 2 的一条测试）。

`fragments` = 文本候选收到的片段序列（与今天 `textParts` 的角色一致）。

### 6.5 取消、超时与错误

- **取消**：`AbortSignal` 传给 `fetch`；`signal.aborted` 后立刻停止读流并抛一个**可识别为取消**的错误。功能层
  沿用今天的 `isCancellation` 口径（按 `name` / `code` / 消息判断，不做 `instanceof`），所以取消的处置不变：
  "写了一半的草稿"不会出现。
- **超时**：复用 `shared/request` 的既有语义，**不另起一套**。三条事实要照抄：
  - `API_REQUEST_TIMEOUT_MS`（30 s）是"没人设过上限时"的默认，**不是天花板**；
  - `requestSignalFor` 用 `AbortSignal.any` 合并"调用方的"与"客户端级的"信号；
  - 长流式响应在共享层**没有** idle watchdog（只有工件下载那一条路径有，见 `downloadActionArtifactToFile`）。
    流式回答因此显式采用**空闲看门狗**（"多久没有新字节就中止"），阈值由 `forgejoToolkit.aiModelRequestTimeoutMs`
    派生；这是本文唯一的**新**超时语义，理由写在 §8.6。
- **错误面**：`shared/request` 的客户端把**任何**非 2xx 都变成
  `` `Forgejo API error ${status}: ${detail}` `` 的 `RequestError`——对模型端点这句话是错的（它不是 Forgejo）。
  所以传输层**必须**把 `RequestError` 重新渲染成模型端点自己的错误面：

  | 情况                               | 用户看到的话（要点）                                                         |
  | ---------------------------------- | ---------------------------------------------------------------------------- |
  | 连接被拒 / DNS 失败 / 代理拒绝     | 点名 base URL 与"可达性"，并提示这可能是代理（`getProxyFetch` 存在时加一句） |
  | 401 / 403                          | 点名 provider，说"密钥被拒绝"，**不打印密钥**（含长度也不打）                |
  | 404                                | "这个地址没有 `/chat/completions`"，提示 base URL 通常要带 `/v1`             |
  | 429                                | "端点限流"，**不自动重试**（§6.6）                                           |
  | 5xx                                | 原样带上服务端响应体的**有界**摘录（照 `aiPreReviewAnswerExcerpt` 的纪律）   |
  | 200 但响应不是 JSON / 无 `choices` | "端点返回了看不懂的响应"，带 type 与长度，不带正文                           |

  日志里**绝不出现** API 密钥与自定义 header 的 value；URL 里若带 userinfo（已被 §6.2 拒绝，此处只是双保险）
  走 `redactUrlUserinfo`。

### 6.6 重试

**传输层不重试。** 理由：

- 本仓库的请求层今天**没有**重试（可搜索 `packages/forgejo-toolkit/src/api/` 确认），引入重试是新的可靠性语义，
  属于要单独定的事，不是"接缝的顺带产物"；
- 模型请求不幂等（一次重试 = 一次新计费、一次新延迟），429 上的重试策略更是每家的语义都不同；
- 今天已有的重试是**功能层**的、只在"答案不合契约"时发生（同一模型最多 2 次），它不因传输而改变。

所以那条待办（已随交付从 `TODO.md` 移除）原先写的"复用 `shared/request` 已有的代理 / 超时 / **重试** / dispatcher"
这句，**重试那一项在本仓库尚不存在**——那句措辞当时已按本节纠正；本文的处置是"传输层不重试 + 记录这个偏差"，见
§13 问题 4（是否要在共享层补一个受限重试，是需要单独裁决的事）。

### 6.7 保证的 vs 尽力而为的「OpenAI 兼容」子集

| 能力                                                   | 级别     | 说明                                                                 |
| ------------------------------------------------------ | -------- | -------------------------------------------------------------------- |
| `POST /chat/completions` + `stream:true` 的 `data:` 行 | 保证     | MSW 测试覆盖                                                         |
| `delta.content`                                        | 保证     | 唯一的答案通道                                                       |
| `delta.reasoning_content` / `delta.reasoning`          | 尽力     | 有就当推理候选；没有就只剩文本候选（承接今天的语义）                 |
| `GET /models`                                          | 尽力     | 返回空或 404 时不算失败：模型名由用户手工填（§9.1）                  |
| 非流式 `message.content` 兜底                          | 保证     | 响应不是 SSE 时必须能读                                              |
| `api-key` + `api-version`（Azure）                     | 保证     | 靠自定义 header 机制，不需要新协议（§8.5）                           |
| `tools` / `tool_choice`                                | **不做** | 接缝里就没有（§4.3），见 `FEATURES.md` 的「预评审按需索取文件」条目  |
| `response_format: json_schema`                         | **不做** | 端点支持率参差；今天的契约靠"解析并校验"，本来就是这么设计的（§9.2） |
| `logprobs` / `usage` / `stream_options`                | **不做** | 非目标                                                               |
| 多模态 part（图片 / 音频）                             | **不做** | 功能层不产生它们                                                     |

### 6.8 为什么 Anthropic 的 Messages API 不在范围内

它的**协议形状不同**，不是"多一个头"能接上的：

1. `system` 是**顶层参数**，不是 `messages` 里的一条；
2. 请求与响应用 **content blocks**（`[{type:'text',text:…}]`），不是字符串；
3. SSE 的**事件名**不同（`content_block_delta` / `message_delta` 等），`data:` 行里没有 `choices`；
4. `max_tokens` **必填**——而接缝刻意不带它（§4.3），所以它不能假装成"同一协议的另一种门牌"。

结论：**除非出现实际诉求，不做**。要做就是**第三个实现**（`AnthropicMessagesTransport`），共用本文的接缝、
设置面、同意面与导出规则；这正好是"一道接缝两个实现"这个设计要换来的东西。它不进阶段 2，也不进 §12 的
非目标清单之外的现在时。

### 6.9 为什么不采用现成的 npm 客户端

**决定：不引入任何现成的 OpenAI / SSE 客户端，流由本实现自己读。** 这次比较是把本仓自己的实现
（`packages/forgejo-toolkit/src/ai/openAiCompatibleTransport.ts`）与几个现实候选对着读出来的：官方客户端
`openai@7.27.0`，AI SDK 一侧的 `ai@7.0.127` 配 `@ai-sdk/openai@4.0.83` / `@ai-sdk/openai-compatible@3.0.62`，
以及只做 SSE 的 `eventsource-parser@4.1.1`、`eventsource@5.1.2`、`@microsoft/fetch-event-source@2.0.1`、
`sse.js@2.8.0`，另有 `ollama@0.6.4` 与 `openai-fetch@3.4.2`。**比较方式是读已发布的包，不是装进来跑**：下面这些
行为断言都出自这些包随包发布的源码（`package.json` 与 `dist` / `lib`），本文没有为此新增依赖。结论也不是"包比
自己写差"：它们不比本实现差在 HTTP 上，差在**这道接缝的这些决定**上。

**官方 `openai` 客户端会回退三处已经测过的行为。** 一行畸形的 `data:` 会让它抛 `SyntaxError` 并结束整条流
（`core/streaming.mjs` 的 `Could not parse message into JSON` 分支），而 §6.4 第 3 条要求跳过并计数；端点忽略
`stream: true`、回一个普通 JSON 体时它一个字都取不到，而 §6.4 第 7 条要求把同一个体读作文本候选；它默认重试
（`maxRetries` 默认 2，流式补全也在内），§6.6 明确拒绝。它还把流式响应体留在**没有超时**的状态——计时器在响应头
到达时就清掉了——所以空闲看门狗照样得自己写；此外它带的是自己的一套错误类型（`APIError` 一族），§6.5 那张错误表
要按第二个错误词汇整个重建一遍。

**第二条理由是密钥边界。** 官方客户端日志脱敏认的是一张固定的头名清单（`internal/utils/log.mjs` 的
`sensitiveHeaderNames`：`authorization`、`api-key`、`x-api-key`、`cookie` 等），所以用户在 §8.5 里声明的自定义头
（它的 value 存在 `SecretStorage` 里）会**原样**印进 debug 日志；而这份日志还能被一个环境变量打开
（`OPENAI_LOG`，见 `client.mjs` 的 `readEnv`），扩展对此一无所知。AI SDK 那一侧则把**完整请求 URL** 放进错误对象
（`@ai-sdk/provider-utils` 的 `APICallError.url`），而查询串里承载的正是存进密钥存储的 `api-version`（§8.5）——
本实现反而要专门把查询串从日志里剪掉（`openAiEndpointDisplayUrl`）。

**AI SDK 唯一会让人犹豫的能力，这里已经实现了。** 它把推理内容做成独立通道，而接缝的推理候选（§4.2、§6.4
第 4 条）做的正是这件事。反过来看它的短处：坏块在它那里变成流里的 error 事件、整份回答就此结束
（`@ai-sdk/openai-compatible` 把 `{ type: 'error', … }` 塞进流里），本实现跳过并计数；端点忽略 `stream: true` 时它
没有"把同一个体当完整回答读"的兜底；它默认两次重试；它还会按自己的范围带进另一个 `undici` 大版本
（`@ai-sdk/provider-utils@5.0.53` 声明 `undici: ^7.29.0`，而本仓依赖的是 `undici@^8.11.2`）。

**体积也不可忽略。** 扩展宿主入口整份约 1 MB，而官方客户端的主入口静态可达 **218 个模块**、约 1.2 MB 未压缩
ESM，`package.json` 里没有 `sideEffects` 字段，所以"用不到的部分会被摇掉"不能当作前提。

**唯一站得住的部分采用——只换 SSE 解析器——也一并否掉了。** 它换掉的只是字段语法那一小段：本实现的
`applySseLine` 约四十行，整个文件一千行出头；看门狗、不重试、密钥纪律、两股候选流、非流式兜底与代理接线一处都
不动。而且换成按规范分帧的解析器会**静默丢掉今天答得上来的事件**：`eventsource-parser` 把同一个事件里连续的
`data:` 行用换行拼成一条，本实现逐行独立解析——端点漏掉两条 `data:` 之间的空行时，今天两条各自成候选，换掉之后
被并成一条解析不了的 payload，两条一起丢。所以这一处的结论是**自己读**，代价就是上面那四十行。

---

## 7. 同意与外发

### 7.1 那个一次性问题的措辞必须学会端点

现状（`askAiPreReviewPromptScope` 的 `message`）是：

> …the chat model you chose belongs to the "{0}" provider…

`{0}` 现在是 `aiPreReviewModelIdentity(chosen).vendor`。**直连时这句会变成谎话**：真实目的是一台 IP / 域名。改成：

- 走 `vscode.lm`：`{0}` = 模型的 vendor，句子不变（保持今天逐字不变）。
- 走直连：`{0}` = **provider 的显示名**，并追加一句"实际地址是 `<base URL>`"。

两处新的 l10n 字符串（`bundle.l10n.json` 与 `bundle.l10n.zh-cn.json` 成对新增）：

| 键（建议名）                                                                      | 用途               |
| --------------------------------------------------------------------------------- | ------------------ |
| `The chat model you chose belongs to the "{0}" provider.`（现有键，不改）         | `vscode.lm` 路径   |
| `The AI pre-review would send this to the provider you configured, "{0}" at {1}.` | 直连路径的目的地句 |

**判据**：句子里必须同时出现**显示名**与**地址**，缺一个都不算说清目的地。地址走 `redactUrlUserinfo` 渲染（双保
险；§6.2 已经拒绝带凭据的 URL）。

### 7.2 硬规则：答案之前什么都不发

这条今天**已经**成立，且是**结构性的**：`runAiPreReview` 里 `resolveAiPreReviewPromptScope` 返回 `undefined`
就直接返回，后面才建客户端；`askAiPreReviewPromptScope` 的 `undefined` 覆盖"取消按钮 / 关闭 / Escape"三种
"没回答"（"an unanswered consent question is not consent"）。

新增的两条路**必须**保持这个顺序，且 `listModels()` / `countTokens()` / "测试连接"都属于**不发送内容**的读操作
（§4.2）。**测试连接是唯一需要特别说明的一条**：它会给端点发一个请求（§8.7），因此它**不得**被任何自动路径
调用，也**不得**被当作"已经同意出网"的证据。

### 7.3 「配置好了」不等于「同意出网」

四个独立的事实，任何两个都不能互相推断：

| 事实             | 存在哪                                                 | 谁写的                         |
| ---------------- | ------------------------------------------------------ | ------------------------------ |
| AI 面是开的      | `forgejoToolkit.aiEnabled`（默认开）                   | 用户（设置页或手工编辑）       |
| 端点已配置       | `forgejoToolkit.aiProviders`                           | 用户（设置页或手工编辑）       |
| 密钥已存         | `SecretStorage`                                        | 用户（设置页输入）             |
| **同意发送内容** | `forgejoToolkit.aiPreReviewPromptScope` 的 stated 取值 | 用户在模态框里回答后由宿主写回 |

第四个为空（`ask`）时，前三个齐备也不发。这条今天是 `ask` 的 fail-closed 读法（
`aiPreReviewPromptScopeSettingValue`），本文不改它，只把它**推广到两条传输**。

功能自己的开关（`forgejoToolkit.aiPreReview`、`forgejoToolkit.prDescription`）不在这张表里，因为它是**另一个
问题**：它说"这个功能是开的"，不问"内容去哪儿"。一次运行因此按 **全局开关 → 功能开关 → 取模型 → 那次外发同意**
的次序被判：全局开关说"完全不要用 AI"，功能开关说"这个功能要跑"，模型选择点说"这次用哪条路、哪个模型"，而同意
模态框才决定内容是否离开本机、离开多少。

### 7.4 配置导入不得静默启用出网

见 §10.3。要点：导入**只写非密字段**，**不写** `aiEnabled` / `aiPreReview` / `aiPreReviewPromptScope` /
`prDescription` / `prDescriptionPromptScope` / `aiTransport` 这几个"会改变出网语义"的键。

### 7.5 两条传输之间没有自动回退

- 选择了直连，直连失败 → **失败**。不悄悄改用 `vscode.lm`。
- 选择了 `vscode.lm`，没有可用模型 → **报告没有模型并给出两条路**（§9.3）。不悄悄改用直连。
- 一个 provider 不可达 / 鉴权失败 → 报错。**不换**另一个 provider（不做负载均衡，§12）。
- 术语上这与 `ai-prereview.md` 已经定下的"扩展不挑、不换、不轮换"（§2 第 8 条）是同一条纪律，只是从"模型之间"
  扩展到"传输之间"。

### 7.6 第二个功能的同意面：自己的值，同一套纪律

**已交付（2026-10-06）**：PR 描述生成本文档 §7.1–§7.3 的同意纪律照用（先问再读、取消即零请求零写入、写回全局
设置、配置好的端点不是同意），但**不复用** `forgejoToolkit.aiPreReviewPromptScope` 这个值：本功能有自己的
`forgejoToolkit.prDescriptionPromptScope`，取值为 `ask` / `commits-only` / `commits-and-files`。三条理由与逐条
否掉的方案见 [`ai-pr-description.md`](./ai-pr-description.md) §3（一句话：预评审的取值在这条路上指向不同的字节，
而同意必须逐功能回答）。这一节只登记那条边界，本功能自己的设计不在这里展开。

---

## 8. 设置与密钥面

### 8.1 provider 的形状

一个 provider 是一个**普通对象**，存在一个数组设置里（照实例列表的先例：`forgejoToolkit.instances` 存在
`globalState`，而这里要能被用户直接编辑与导入导出，所以放 settings）：

```jsonc
{
  "id": "ollama-local", // 校验过的字符集（照 pathSegmentSchema 的纪律）
  "name": "Ollama (this machine)", // 显示名，必填，模态框与设置页都用它
  "baseUrl": "http://localhost:11434/v1",
  "models": [{ "id": "qwen3:8b", "name": "Qwen3 8B" }],
  "auth": "bearer", // 'bearer' | 'api-key-header' | 'none'
  "headers": [{ "name": "api-version", "valueSecret": true }], // value **不在**这里，§8.2
}
```

- `headers[].value` **永远不在这里**。数组里只留下名字和一个"值在密钥存储里"的标记。
- `auth: 'api-key-header'` 时的头名固定为 `api-key`（Azure 的写法）；其他自定义头走 `headers`。
- `models` 是"这个端点上有哪些模型"的**声明**，不是白名单：模型 id 是自由文本，`/models` 只用来预填（§9.1）。
- **没有 `localOnly`**：逐端点的"仅本机"承诺曾在这里，2026-10-06 连同全局策略一起移除，理由见 §8.8。写入它的
  `settings.json` 里那一条会被读取器**丢弃**（`parseAiProviderConfig` 只重建它认识的字段）。

### 8.2 哪里放什么（settings vs secret）

| 数据                                                         | 位置                                                                                | 理由                                         |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------- |
| provider id / 显示名 / base URL                              | settings（`forgejoToolkit.aiProviders`）                                            | 非密；要能导入导出、要被用户看见             |
| 模型列表（id + 显示名）                                      | settings                                                                            | 非密                                         |
| **默认目的地**（端点 id + 模型名）                           | settings（`forgejoToolkit.aiDefaultProvider` 与 `forgejoToolkit.aiDefaultModel`）   | 非密；必须是用户可见可改的，且是主路径       |
| 逐功能覆盖（`{ feature, providerId, modelId }`）             | settings（`forgejoToolkit.aiModelBindings`）                                        | 非密；必须是用户可见可改的                   |
| **全局 AI 开关**                                             | settings（`forgejoToolkit.aiEnabled`）                                              | 非密；它管的是"允不允许用 AI"                |
| 传输选择                                                     | settings（`forgejoToolkit.aiTransport`）                                            | 非密                                         |
| 超时                                                         | settings（`forgejoToolkit.aiModelRequestTimeoutMs`）                                | 非密                                         |
| **API 密钥**                                                 | **`SecretStorage`**，键 `forgejoToolkit.aiProviderKey.<providerId>`                 | 照实例 token 的纪律（`TOKEN_SECRET_PREFIX`） |
| **自定义 header 的 value**（含 `Authorization` / `api-key`） | **`SecretStorage`**，键 `forgejoToolkit.aiProviderHeader.<providerId>.<headerName>` | 见下                                         |

**为什么自定义 header 的 value 也要进密钥存储**：原先 `TODO.md` 里那条待办（已随交付移除）把这条写得很直白——
"请求头里常常就是认证信息（`Authorization` / `api-key`），不能只保护'API 密钥'这一个字段"。一个只保护独立密钥
字段、却把 `Authorization` 明文写进 `settings.json` 的实现，等于把纪律绕过去了。

**header 名要校验**：键里的 `<headerName>` 是该字段作分隔符的 `.` 会歧义，所以 header 名照实例 id / 路径段的
纪律校验（`^[A-Za-z0-9_-]+$`）；不合法的名字在设置页就拒绝。

### 8.3 具体的设置 id 与默认值

| 设置 id                                  | 类型    | 默认值  | `scope`   | 语义                                                                                                         |
| ---------------------------------------- | ------- | ------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| `forgejoToolkit.aiEnabled`               | boolean | `true`  | `machine` | **整个 AI 面的总开关**：关掉它，没有任何 AI 功能会运行，也不向任何模型取答案（编辑器提供的与已配置的都不问） |
| `forgejoToolkit.aiProviders`             | array   | `[]`    | `machine` | 已配置的 provider 列表；**空数组 = 没有直连目的地**                                                          |
| `forgejoToolkit.aiTransport`             | string  | `auto`  | `machine` | `auto` / `vscode-lm` / `openai-compatible`，见 §8.4                                                          |
| `forgejoToolkit.aiDefaultProvider`       | string  | `""`    | `machine` | 默认目的地的端点 id；空 = 没有默认目的地（§8.4）                                                             |
| `forgejoToolkit.aiDefaultModel`          | string  | `""`    | `machine` | 向默认端点请求的模型名；空 = 没有默认目的地（§8.4）                                                          |
| `forgejoToolkit.aiModelBindings`         | array   | `[]`    | `machine` | 逐功能覆盖（`{ feature, providerId, modelId }`）                                                             |
| `forgejoToolkit.aiModelRequestTimeoutMs` | number  | `30000` | `machine` | 空闲看门狗窗口与单次请求上限（§6.5、§8.6）                                                                   |

**三层分工（2026-10-06 维护者裁决，本节是它的住处）**：

1. **全局开关** `forgejoToolkit.aiEnabled` 说"**完全不要用 AI**"。它是唯一一个把编辑器自己提供的模型也一起关掉的
   开关：关掉之后 `selectedModelFor(feature)` 在任何分支之前就答 `ai-off`（§8.4 的次序表第 0 行），所以没有哪条
   路能"绕过它照跑"。
2. **逐功能开关**（`forgejoToolkit.aiPreReview`、`forgejoToolkit.prDescription`）说"**这个功能是开的**"，各自的
   默认值不变（都默认关），并且仍然是各自功能的第一道判断。
3. **那次运行自己的同意询问**（`aiPreReviewPromptScope` 等）才是**外发同意**：它决定内容是否离开本机、离开多少。
   前两层都不替它回答。

**为什么默认是"开"（本节唯一一个与其余开关方向相反的读者）**：`aiEnabled` 的默认值必须是 `true`，因为移除那两条
旧开关时，一个本来能在编辑器模型上正常工作的配置不能因为"多了一个默认关的开关"而静默失效；它管的也不是某一条出网
路径，而是"要不要用 AI"这件事本身。读取纪律因此反过来：**只有显式的 `false` 才算关**，读设置抛异常时读作**开**
（`aiEnabledSettingValue`）。这条反向读法是安全的，因为"读成开"本身**不发任何内容**——在它和一次真实请求之间还
有功能开关、取模型与那次同意询问三层。

**`scope: "machine"` 就是"只允许用户级"的实现方式**：`machine` 作用域的设置**不能**在工作区 / 远程 / 文件夹级
被覆盖（`application` 也只允许用户级，但会阻止 Settings UI 的同步，对一个可能含密钥的配置不合适；密钥本来就不
在这些设置里，但 provider 列表里的 base URL 也算半个秘密）。工作区级配置能把内容指向一个未知地址，正是必须堵住
的：`package.json` 里不写 `scope` 的默认是 `window`，**可以被 `.vscode/settings.json` 覆盖**。

**读者纪律**：照 `aiPreReviewSettings.ts` 与 `mcpWriteSettings.ts` 的既有写法——读设置抛异常时读作"未配置"，
只有显式 `true` 才算开（fail-closed 方向必须是不发）。`aiEnabled` 是上面写明的唯一例外。

**被移除的两条设置**：`forgejoToolkit.aiProvidersEnabled`（"允许向已配置的端点发请求"，默认关）与
`forgejoToolkit.aiLocalOnly`（"仅允许本地端点"，默认关）连同整套地址策略已删除。理由与替代见 §8.8。

### 8.4 `aiTransport` 与 `selectedModelFor(feature)`

**默认与覆盖的关系（2026-10-06 维护者裁决，本节是它的住处）**：目的地由**一条默认值**加**逐功能覆盖**两层
组成，默认值是主路径，覆盖是可选的例外。

- **默认值**是 `forgejoToolkit.aiDefaultProvider` + `forgejoToolkit.aiDefaultModel` 这一对**平铺字符串**。选它而
  不是往 `aiModelBindings` 里塞一条 `feature: "default"` 的伪条目，理由是"feature 这个字段只能有一种含义"：覆盖
  存在的意义就是"这个功能不走默认值"，所以默认值本身不能长得像一条覆盖。两个平铺键也是最小的诚实形状——与绑定
  用同一套读取与校验，`settings.json` 里就是一句"哪个端点 + 哪个模型"，导入导出不必为新容器加规则。
- **一半不算默认值**。只有端点 id 没有模型、或只有模型没有端点 id，都读作"没有默认值"：直连路径**不许自己推出
  一个模型**，所以它不能把"某个端点上的某个模型"解释出来。这一条让用户手改 `settings.json` 时不会得到一个
  半生效的默认值。
- **覆盖优先，且只对写了它的那个功能优先**。一条覆盖就是用户为某一个功能点名了端点与模型（"这次评审值一个更强
  或更私密的模型"），所以它对那个功能压过默认值，对别的功能不产生任何影响。
- **默认值只在直连那一路里说话**。它排在 `aiTransport` 的显式选择（规则 2、3）之后：`vscode-lm` 就是"别问端点了"，
  所以它不去读默认值。`openai-compatible` 与 `auto` 的端点那一半都读它。
- **`auto` 与默认值**：`auto` 先问编辑器有没有可用模型（规则 4），只有在编辑器提供不了模型时才去看默认端点
  （规则 5）。也就是说 `auto` 下的默认端点是**退路**，而 `openai-compatible` 下它是**唯一那条路**。
- **兼容性**：没有配置默认值、也没有覆盖时，行为与这组设置出现**之前完全一样**——仍是"恰好一个可读端点且它
  声明了模型"那条规则（规则 5 的旧读法，见下），所以升级后既有配置的运行方式不变；既有的逐功能绑定也照旧生效，
  只是现在它们在语义上叫覆盖。

| 次序 | 条件                                                         | 结果                                                       |
| ---- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| 0    | `forgejoToolkit.aiEnabled` 是 `false`                        | 明确失败（`ai-off`）：两条路都不问，也不看功能开关（§8.3） |
| 1    | `bindings` 里有这个 feature 的覆盖                           | 直连（用覆盖里的 provider + model）                        |
| 2    | 无覆盖且 `aiTransport === 'vscode-lm'`                       | `vscode.lm`                                                |
| 3    | 无覆盖且 `aiTransport === 'openai-compatible'`               | 直连；没有可用 provider / 密钥时**失败**（不回退）         |
| 4    | 无覆盖且 `aiTransport === 'auto'`，且 `vscode.lm` 有可用模型 | `vscode.lm`                                                |
| 5    | 无覆盖且 `aiTransport === 'auto'`，`vscode.lm` 没有可用模型  | 直连，**仅当**能定出一个目的地                             |
| 6    | 以上都不成立                                                 | 明确失败：报告"没有可用模型"并给出两条路（§9.3）           |

**规则 3 与规则 5 里的"能定出一个目的地"按固定次序读**（`selectDirectWithoutBinding`）：

1. 配了**完整**的默认值（两半都在）→ 用**它**，并像覆盖一样校验：端点必须在 `aiProviders` 里能读到，端点必须
   可用（URL、密钥）；任何一条不过就**点名失败**，绝不"就近找一个端点"，也绝不改走编辑器那条路。
2. **没配默认值**→ 沿用这组设置出现之前的老规则：**恰好一个**端点能读出来、且它**声明了至少一个模型**，用
   **它声明的第一个**模型。多于一个端点、有条目读不出来、端点没声明模型——都是"说不清把内容送给谁"的歧义，
   照旧失败而不猜（`bind`）。

- **`auto` 的选择必须是可解释的**：每次运行在 debug 日志里写一行"这次走 `<transportId>`，因为 `<reason>`"。
- 覆盖缺一个 provider 所指（provider 被删、id 写错）时**失败并点名**，不"就近找一个"（照
  `reportAiPreReviewModelRefusal` 的纪律）；默认值指向一个不存在的端点时**同样如此**，只是句子换成点名
  `forgejoToolkit.aiDefaultProvider` 与那个 id。两处的失败**都不回退到另一层**：覆盖坏掉不会改用默认值，默认值
  坏掉不会改用"唯一那个端点"——否则用户刚点名的那条路会静默地变成另一条。
- 覆盖是一个**数组**而不是对象：`settings.json` 手编时数组的合并语义比深层对象可预测，也与实例列表一致；默认值
  不是数组，它是**一条**目的地，所以用两个平铺键而不是再开一个数组。

### 8.5 自定义 header 与认证方式

- `auth: 'bearer'` → `Authorization: Bearer <secret>`；`'api-key-header'` → `api-key: <secret>`；`'none'` → 不带认证头
  （本机 server 常这样）。
- 其他头（`api-version`、自建网关的私有头）走 `headers`，value 从 §8.2 的密钥存储按名字取。
- **冲突规则**：`headers` 里出现 `Authorization` / `api-key` 时，以 `auth` 的写法为准并在设置页指出这一点（一个
  静默覆盖会让"我配的头没生效"变成无法诊断的谜题）。
- **头名不合法**（含空格、冒号、非 ASCII）在设置页拒绝，理由写清。

### 8.6 为什么需要一个新的超时设置

`shared/request` 的默认超时（`API_REQUEST_TIMEOUT_MS`，30 s）是**总时长**上限，而一次模型回答动辄几十秒到几分钟。
把它当模型超时会**把正常回答掐断**，而完全不设上限又会让一个不响应的端点挂住窗口（今天的
`downloadActionArtifactToFile` 就是为同类问题采用空闲看门狗的先例）。所以：

- 空闲看门狗窗口 = `aiModelRequestTimeoutMs`（默认 30 s，即"多久没有新字节就中止"）；
- 同时给整个请求一个**更宽**的上限（默认取该值的 10 倍），避免一个持续吐字节但永不结束的流把窗口占住；
- 两个数都写进 debug 日志，用户改设置后不必猜。

### 8.7 「测试连接」怎么做

一个新命令 + 设置页里每个 provider 一个按钮（照 `testConnection` 的既有先例，见
`src/webview/connectionTest.ts`）：

1. **先校验**：全局 AI 开关、id 字符集、URL 合法性与 scheme、必需字段齐不齐。任何一条不过就在**本地**
   失败，一个字节都不发。
2. 发 `GET <base>/models`（best-effort）：能拿到就列出模型数并**预填**模型列表；404 / 空数组不算失败，改发
   一条**最小**的 `POST /chat/completions`（`max_tokens` 之类不发，§6.3），问一个固定的一字回答。
   **这一步是唯一会给端点发内容的自动动作**，且它由一次显式的用户点击触发。
3. 报告：HTTP 状态、耗时、模型数 / 回答的首部**有界**摘录、以及**这次请求发到了哪个地址**（`redactUrlUserinfo`
   渲染的 base URL）。**绝不**回显密钥或任何 header 的 value。
4. 失败按 §6.5 的错误面分类给出可行动的话（"地址里通常要带 `/v1`"这一条尤其重要）。

**全局 AI 开关也管这个探针**（2026-10-06 的裁决）：关掉 `aiEnabled` 时，点击的「测试连接」与设置页的自动探测都在
本地被拒、一个字节都不发，句子点名 `forgejoToolkit.aiEnabled`。理由不是"探针也算一次 AI 功能调用"（它不是），而是
**探针会把已存的凭据呈现给端点**：一个说"完全不要用 AI"的开关，不该在它关着的时候还替用户把一个 API 密钥发到一个
模型端点上。代价是"关掉 AI 之后不能再用这个按钮验证端点"，而那正是"把 AI 关掉"这个动作的含义——要验证，把开关打
开；配置本身没有被清掉（§8.3）。

### 8.8 已移除：「仅本地」约束与"允许向已配置的端点发请求"

**2026-10-06 维护者裁决：两条设置连同它们的整套实现被删除，位置由 §8.3 的全局 AI 开关接替。** 这一节保留它们为什么
不值得留，因为这是决定的一部分，而不是一次清理。

**被删掉的两条设置**：

- `forgejoToolkit.aiProvidersEnabled`（"允许向已配置的端点发请求"，默认关）——直连那条路的第二道闸门。
- `forgejoToolkit.aiLocalOnly`（"仅允许本地端点"，默认关）——只允许 `localhost` / 回环 / `.local` / 私有网段的
  `baseUrl`；逐端点的 `localOnly` 承诺、`isLocalAiEndpointHost` 的私有网段判定、设置页上被它拒绝的行与地址提示、
  导出/导入里的 `localOnly` 字段与导入预览里那一行、以及它们各自的测试，都随它一起删除。

**为什么删 `aiProvidersEnabled`**：维护者的理由是"**配置端点这个动作本身就已经表达了你要用它**"——配一条端点、存
一个密钥是显式动作，不想用就把它删掉；再加一道默认关的闸门，只会让一个刚配好端点的用户面对一个"我什么都没做错，
功能却说没模型"的状态，而那道闸门自己的文案还得解释"配置不等于允许"。移除它之后，"什么都不发"这个保证并没有变弱：
它由 §8.3 的三层分工承担——功能开关仍然默认关，取模型仍然要有人点名目的地，而**那次外发同意**仍然是唯一的"内容可
以出去"的记录处（§7.2、§7.3）。

**为什么删「仅本地」**：维护者的理由是"**这条规则不值它的重量**"。一个真的需要代码留在某个网络里的用户，手边有的是
更强的办法——一个网关，或者一张根本不连出去的网；而客户端这一侧只能检查**用户自己填的地址字符串**，既不能解析
DNS（§13 问题 5），也不得不自己去猜"什么叫本地"（回环？私有网段？`.local`？），猜错的方向恰好是"以为拦住了而其实
没有"。于是这条"看起来像安全措施、实际上只是一次地址猜测"的规则被整体删除，而不是保留成一道默认关的闸门。

**替代它的是什么**：一句更简单也更诚实的话——**你要发到哪里，就配哪个地址**。地址写在
`forgejoToolkit.aiProviders[].baseUrl` 里、由用户自己填、在设置页与同意模态框里都被原样显示（§7.1），
`http://`（非 TLS）仍然会被显著警告（§6.2、§10.2）。想要"只发本机"的用户把本机地址填进去即可；想要更强保证的用户
用网关或断网，那是扩展做不到、也不该假装做到的事。

**升级路径**：两个键从 manifest 里消失之后，`settings.json` 里遗留下来的值**不会被读、也不会报错**——读取器不存在
了，手写的值就是一条谁都不看的普通数据（VS Code 只会在设置界面把它标成未知设置）。同理，provider 条目上遗留的
`localOnly` 字段会被 `parseAiProviderConfig` 丢弃，与它丢弃一个手写的 header `value` 是同一条纪律：读设置时只重建
自己认识的字段。

**随之移除的还有 `AGENTS.md` 的那条例外**：「Code content」一节曾为"定义网络策略的地址模式"（回环与私有网段）写明
例外，好让上面那套判定能在源码与 fixture 里写出自己的定义域。策略没有了，例外也随之撤回——仓库里不再有任何依赖它的
地方（这次改动核对了这一点：`isLocalAiEndpointHost` 与它的两个测试是唯一的用户）。

### 8.9 NLS 条目（**本阶段不动 NLS 文件**）

选择：**本阶段只写名字、不编辑 `package.nls.json` / `package.nls.zh-cn.json`**（两者必须同步改，等到阶段 1 落地
设置与文案时一起做）。阶段 1 必须新增的键（英文 / 中文成对）：

| 键                                                                             | 说明                               |
| ------------------------------------------------------------------------------ | ---------------------------------- |
| `config.aiProviders.title` / `.description`                                    | provider 列表                      |
| `config.aiEnabled.title` / `.description`                                      | 全局 AI 开关（默认开，2026-10-06） |
| `config.aiTransport.title` / `.description`                                    | 传输选择                           |
| `config.aiTransport.enumDescriptions.auto` / `.vscodeLm` / `.openAiCompatible` | 三个取值各自说清走哪条路           |
| `config.aiModelBindings.title` / `.description`                                | 逐功能绑定                         |
| `config.aiModelRequestTimeoutMs.title` / `.description`                        | 超时                               |
| `config.aiDefaultProvider.title` / `.description`                              | 默认端点（2026-10-06 新增）        |
| `config.aiDefaultModel.title` / `.description`                                 | 默认模型（2026-10-06 新增）        |
| `command.aiTestProvider.title`                                                 | 「测试连接」                       |

**两条会被测试拦住的既有约定**（不改就是红的）：

1. `src/webview/__tests__/i18nParity.test.ts` 的 "gives the AI pre-review and the MCP write settings a name from the
   pair" 把**带 `title` 的设置**钉成一个精确列表。新增的每一条带 `title` 的设置都必须同时加进该列表，否则测试
   失败——这是好事：它保证新设置的名字来自 nls 对而不是从键名推出来的英文。
2. 同一文件的 "resolves every %placeholder% the manifest uses in both nls files"：manifest 里出现的每个
   `%…%` 都必须在**两个** nls 文件里有值。

---

## 9. 能力探测与降级

### 9.1 判断能力，不判断品牌

| 问题                         | 怎么答                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| 编辑器有语言模型 API 吗      | `vscode.lm` 存在且 `selectChatModels` 是函数（照 `queryAiPreReviewChatModels` 的读法）          |
| 编辑器提供了模型吗           | `selectChatModels()` 返回**非空**（照 `uniqueAiPreReviewModels` 去重后的长度）                  |
| 端点上有哪些模型             | `GET /models` 成功时用它**预填**；失败就用用户填的 `models`（`models` 是声明，不是白名单）      |
| 端点支持工具调用 / JSON 模式 | **不做探测**：接缝里没有工具（§4.3），JSON 契约一直靠"解析并校验"（§9.2）                       |
| 这个编辑器是哪个 fork        | `vscode.env.appName` / `uriScheme` / `appHost` / `remoteName`，**只进诊断输出**，不参与任何分支 |

**关于"没装 Copilot 的原版 VS Code 同样返回空"**：所以品牌判断既不可靠也无必要——一个装了 Copilot 但未登录的
VS Code 与一个 VSCodium 在能力上完全一样。**本文不引入任何按品牌的出网语义**（"检测到 fork 就启用直连"是明令
禁止的）。

### 9.2 端点做不到的事，怎么降级

| 能力缺口                              | 谁受影响                  | 处置                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 不支持 `stream: true`                 | AI 预评审（它按流读答案） | 能读非流式完整响应（§6.4 第 7 条）；读不出就明确失败，**不换路**                                                                                                                                                                                                                                                                                                                  |
| 输出被 `finish_reason: 'length'` 截断 | AI 预评审的 JSON 契约     | **已落地（2026-10-05）**：这个读数经接缝的 `AiCompletionResult.truncated`（§4.2）一路带到 `src/aiPreReview.ts` 的 `reportContractFailures`，契约失败时**在原有那句之外**再报一句"回答被端点自己的输出上限截断"，并给出两条出路——提高端点侧配置的输出上限 / 换一个在指令内作答的模型。只在这一条失败路径上报：`vscode.lm` 不报 `finish_reason`，编辑器那条路的报告因此一个字都不变 |
| 不返回合规 JSON                       | AI 预评审                 | 沿用今天的处置：同一模型最多重试 2 次，然后按契约失败报告并计数（§3.1）                                                                                                                                                                                                                                                                                                           |
| 端点无鉴权 / 鉴权方式不同             | 所有直连功能              | §8.5 的 `auth` + 自定义头；`none` 合法                                                                                                                                                                                                                                                                                                                                            |
| 端点上模型列表为空                    | 设置页的模型下拉          | 允许手工填模型 id；列表为空**不是**失败（`/models` 只是尽力而为）                                                                                                                                                                                                                                                                                                                 |
| 工具调用 / agent 循环                 | 未来功能                  | **不出现**该功能，并直说"这个端点不支持"（§12）                                                                                                                                                                                                                                                                                                                                   |

**底线**：任何能力缺口都不得让功能"悄悄换一种行为"（例如本来会校验锚点的功能变成不校验）。

### 9.3 设置面在"没有可用模型"时必须说什么

今天的设置页只有一行模型下拉，空列表时给一句 `reason`（`listAiPreReviewChatModelChoices`）。**没有可用模型是
最常见的一种状态**（VSCodium），所以这一行要升级成一个明确的区块：

1. **直说**：现在这个编辑器没有提供任何聊天模型（`vscode.lm` 存在但列表为空 / 根本不存在 API），AI 功能因此
   不可用。
2. **给出两条路，各自可点**：
   - 装一个贡献语言模型的扩展并登录（不点名 Copilot——`vscode.lm` 接的是**所有**这样的扩展）；
   - 配一个 OpenAI 兼容端点（地址 / 模型 / 密钥 / 测试连接），并说明这条在 VSCodium 这类编辑器上是唯一的路。
3. **在用户做出选择之前，功能保持关闭**：不因为是 fork 就替用户打开任何开关（全局 AI 开关默认是开的，那是为了让
   这次移除不改变既有配置，不是"因为编辑器像某个 fork 就替用户放行"），也不预填任何默认端点。
4. 让这条路**显眼**（提示与入口顶到前面），而不是悄悄启用它。
5. **全局开关关着时，这一区块要说的是那件事**：`capability` 的 `ai-off` 代码带着的句子说明"AI 被关掉了、什么都没
   发"，页面在它后面重复一遍开关那一段的说明（该说的话与"怎么打开"在 §8.3 的那一层里），而不是继续推荐两条在这里
   都修不好问题的路。

---

## 10. 导出与导入

### 10.1 非密字段进导出 JSON

导出格式（`version: 3`，`viewProvider._buildExportData` 现在发的是 `version: 2`）新增一个 `ai` 段：

```jsonc
{
  "version": 3,
  "instances": [...],
  "settings": {...},           // 今天的 ExportSettings，key 集合不动
  "ai": {
    "providers": [{ "id", "name", "baseUrl", "models": [...], "auth", "headers": [{"name"}] }],
    "bindings": [{ "feature", "providerId", "modelId" }],
    "transport": "auto"
  }
}
```

- `settings` 里的既有字段集合**不动**：`ExportSettings` 是 webview 与宿主共享的类型，`sanitizeImportedSettings`
  也逐字段白名单校验（`sanitizeImportedSettings` 的纪律：未知字段**丢弃**而不是猜）。`ai` 段同样要有一个
  `sanitizeImportedAiConfig`，逐字段校验（id 字符集、URL 合法性与 scheme、auth 取值、模型条目形状）。
- **不导出** `aiEnabled` / `aiPreReview` / `aiPreReviewPromptScope` / `prDescription` /
  `prDescriptionPromptScope`：它们是"出网语义"的开关，导入它们等于让一个文件改变另一台机器的隐私姿态（§7.4）。
- 导入预览**必须**展示 AI 段：哪些 provider、地址是什么、有没有冲突（id 相同则改名 / 保留 / 替换，照既有实例
  预览的三选一）。

### 10.2 密钥与自定义 header 的 value 只进加密导出

- 加密路径不变：`_promptExportPassword` → `_encryptExportData`（AES-256-GCM，PBKDF2 100k 轮），整体加密。
- **未加密导出**时：
  - 导出结果里**明确说"未包含密钥"**（`instancesExported` 的 reply 或写入文件后的提示都要说）；
  - `ai.providers[].headers[].valueSecret: true` 保留，让接收方知道"这里有一个值，但你没拿到"；
  - 导入这样的文件**不报错**：provider 导入成功但"无密钥"，运行时报"该 provider 没有密钥"，并指向
    **用户级**设置页（不指向导入的文件，密钥从来不在文件里）。
- 明文导出**可以**包含非密字段（地址、模型列表），这与实例 token 的既有取舍一致。

### 10.3 导入不得静默启用出网

硬规则，四条**都**要做到：

1. 导入**不写** `aiEnabled` / `aiPreReview` / `aiPreReviewPromptScope` / `prDescription` /
   `prDescriptionPromptScope` / `aiTransport`。规则的说法是"**导入永不打开全局开关或任何功能开关**"：一个文件可以
   带来端点、模型声明与逐功能覆盖，但"要不要用 AI""这个功能开不开"永远只有本机用户能回答。它**也不关**它们——文件
   里写着 `aiEnabled: false` 同样被忽略，因为一台机器的工作配置不该被一个文件走回头路。
2. 导入后第一次真正要发内容时，用户仍要自己走一遍那个一次性模态框（§7.1–§7.2）。
3. `http://` 非 TLS 端点在**导入预览**里显著警告（不只是运行时），因为导入动作本身就是"把内容指向某个地址"。
4. 导入后各功能仍要**优雅失败**：不可达 / 鉴权失败就报错，**不回退到别的 provider，也不偷偷改用 `vscode.lm`**
   （§7.5）。

---

## 11. 分阶段落地计划

### 11.1 阶段 1 — 抽接缝（`VscodeLmTransport`），零行为变化

**做什么**：新增 `src/ai/transport.ts`（§4.2 的接口）、`src/ai/vscodeLmTransport.ts`（§5 的搬迁），把
`gatherPreReviewRequest` / `requestPreReviewComments` / `validateChosenAiPreReviewModel` / `preparePrompt` 改成
对着接缝写。设置面的类型与读取器（`ai/modelSettings.ts`）与 `package.json`、NLS 一起留到阶段 2（§8.9），
这样阶段 1 只抽接缝，diff 里没有一行用户可见文案。

**必须证明**：

1. `src/__tests__/aiPreReview.test.ts` **一行不改**通过（等价性的唯一可信证据，§5.1）。
2. `src/__tests__/aiPreReviewDiagnostics.test.ts`、`aiPreReviewBrief.test.ts`、`aiPreReviewPanel.test.ts`
   同样不改通过。
3. `pnpm check` 干净。
4. 一个**新的**小测试：接缝的两个实现里，`VscodeLmTransport` 的 `complete()` 不与任何 provider 设置交互
   （把一个 provider 配置塞进 mock 设置，断言行为与没有它时逐个相同）——这是 §5.5 的机制化。

### 11.2 阶段 2 — `OpenAiCompatibleTransport` + 设置面 + 同意面

**做什么**：§6 的实现、§8 的设置与密钥、§7.1 的模态框措辞、§8.7 的测试连接、§9.3 的设置页区块、§8.9 的 NLS
对、`i18nParity.test.ts` 的列表更新。

**必须证明**（MSW 起一个 mock 的 OpenAI 兼容端点，覆盖流式与错误分支）：

1. SSE 的正常流：多个 `data:` 块 → 片段按序聚合成文本候选；`[DONE]` 终止。
2. 坏行被跳过并计数，整场不失败。
3. 非流式兜底：一个完整 JSON 的 `message.content` 被当作文本候选。
4. `reasoning_content` 变成推理候选，且**不与**文本候选拼接。
5. `finish_reason: 'length'` 被识别并报告为截断。
6. 取消：abort 后立刻停流、抛可识别为取消的错误、**零**草稿写入。
7. 错误面：401 / 403 / 404 / 429 / 5xx / 连接被拒 / 200-非 JSON 各自的话（§6.5 的表）。**断言日志与错误里没有
   密钥与 header value**。
8. 超时：空闲看门狗在"无新字节"后中止，且**不**把正常的长回答掐断（一个持续吐字节的假端点必须活到最后）。
9. 非 HTTPS：`http://` 端点可用但有显著警告；`file:` / 带 userinfo 的 URL 被拒。
10. 无回退：直连失败时**零** `vscode.lm` 调用（反之亦然）——两个方向各一条测试。
11. 同意：`scope` 还是 `ask` 时，直连路径的**零**请求（断言 MSW 的 unhandled 记录为空）。

### 11.3 阶段 3 — 把 AI 预评审正式接上直连

**做什么**：`selectedModelFor('aiPreReview')` 接进 `runAiPreReview`，端点上没有 tokenizer 时的预算策略
（§13 问题 3），面板头与日志里的"模型"改说"传输 + provider + 模型"。

**必须证明**：同一份 fixture 的 PR，在 `vscode.lm` 与直连两条路上都**跑完整条流程**（读到答案、过契约、过锚点
校验、落草稿），并且两条路的失败处置逐条对应 §11.2 的第 6–10 条。

### 11.4 阶段 4 — 导出/导入与其余 AI 功能

**做什么**：§10 的 `version: 3` 与 `ai` 段、导入预览的冲突三选一、`sanitizeImportedAiConfig`；此后新功能
（PR 描述生成 / Issue 分诊 / 通知摘要）直接按 `selectedModelFor(feature)` 接。

**必须证明**：导出-导入往返（非密字段无损；密钥不在明文导出里；加密导出能带密钥；导入后**不**启用出网）；
一个新功能的接线只用接缝、不新增第二条取模型的路径。

**落地记录（2026-10-06）**：

- 实现：`src/webview/aiConfigImport.ts`（导出的读、文件 `ai` 段的逐字段重建、导入预览的冲突与不可用判定、
  以及写入）与 `src/webview/instanceImport.ts` 的 `readExportDataFromUri`；导出侧在
  `viewProvider._buildExportData` / `_encryptExportData`，预览与确认在 `_previewImportInstances` /
  `_importInstances`。
- 载荷：`version: 3`，顶层新增 `ai: { providers, bindings, transport }`（`localOnly` 曾在里面，2026-10-06 随
  §8.8 的移除一起删掉）；**加密时**才在 `ai` 里多一个 `secrets: { keys, headerValues }`，与实例 token 走同一个
  加密包裹（AES-256-GCM / PBKDF2 100k）。`settings` 的既有字段集合一个字没动，`version: 1` / `2` 的文件照旧可导入
  （读取按字段白名单，不看版本号）。
- **不导出**的键与 §7.4 一致：`aiEnabled` / `aiPreReview` / `aiPreReviewPromptScope` /
  `prDescription` / `prDescriptionPromptScope`。四条硬规则各有测试：不写这些键、不写 `aiTransport`（预览里显示，
  不应用）、`http://` 在预览里就警告、导入后各功能仍按端点自己的错误失败而不回退；`applyAiImport` 的两条测试分别
  断言"文件说 `aiEnabled: false` 也不写它"与"文件说 `aiEnabled: true` 也不写它"（同一个键的两个方向都不动，因为
  它管的是**要不要用 AI**，不是配置）。
- 一处对本文的收窄：**导入走既有的导入预览**（`previewImportInstances` → `importInstances`）。文件选择器的
  直连导入（`importInstances` 不带 `ids`）不应用 `ai` 段——它没有预览面可以把"要写哪些端点、密钥有没有随文件
  来"讲清楚，而 webview 的导入按钮走的始终是预览那条路，所以这不是用户可见的缺口。
- §11.4 的第二句（新功能按 `selectedModelFor(feature)` 接）此后已经有了一个对象：PR 描述生成按同一个选择点接线
  （2026-10-06，`docs/design/ai-pr-description.md`），本次不新增第二条取模型的路径；Issue 分诊与通知摘要仍在
  `FEATURES.md` 的「未完成」里，落地时同样直接接这道接缝即可。

### 11.5 什么证据会推翻整份设计

- 若 BYOK 事实上经 `vscode.lm` 暴露（§13 问题 1），直连的价值排序要重排（阶段 3 的优先级可能要降）；
- 若"两股候选流"在真实直连端点上的行为与 `vscode.lm` 差到需要功能层分支，那么接缝的形状（§4.2）需要重开；
- 若 MSW 无法覆盖 SSE 的流式（§13 问题 2），阶段 2 的验收口径必须换载体，而**不能**降级成"只测聚合函数"。

---

## 12. 非目标

| 不做                                                | 为什么                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 为每家写一套原生 SDK（Anthropic / Gemini 原生协议） | §6.8；要做就是第三个实现，共用同一道接缝                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 让 MCP 侧去调用模型                                 | 架构上刻意非目标：MCP server 是纯工具/提示面，不做任何 LLM 调用（见 mcp-server.md 的「Security model」一节）                                                                                                                                                                                                                                                                                                                                                  |
| 两条传输之间的自动回退                              | §7.5；"失败即失败"是硬要求                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 多个 provider 之间的自动回退或负载均衡              | 同上；给定 provider 不可达就报错                                                                                                                                                                                                                                                                                                                                                                                                                              |
| token 计费 / 用量统计                               | 明确不做；接缝里也没有用量回调（§4.3）                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 模型 / 供应商预设市场                               | 预设只是预填（§6.2），不是一个市场，也没有中心索引                                                                                                                                                                                                                                                                                                                                                                                                            |
| 为常见本地服务预填地址                              | **已决定不做（2026-10-06）**：`TODO.md` 的 P4 条目曾把它列为端点配置面的第一项，落地时判定它属于上一条已被否掉的"预设"，而不是 §8.1 的端点形状——地址栏里贴一个 URL 是显式动作，而"我们替你猜这台机器上跑的是哪个服务"要在设置页维护一份不断漂移的默认值表（端口、`/v1` 后缀、同名服务的不同发行版），猜错时发出的第一个请求指向一个用户没配过的地址。模型列表的自动探测（§9.1）已经覆盖了它真正想要的那半个价值：地址与凭据填好之后，`/models` 会把模型行补上 |
| 工具调用与 agent 循环                               | `FEATURES.md` 的「预评审按需索取文件」条目划为下一档质量的独立立项；接缝里没有工具面（§4.3）                                                                                                                                                                                                                                                                                                                                                                  |
| 把密钥放进 settings                                 | §8.2；硬要求                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 按编辑器品牌改变出网语义                            | §9.1；品牌只进诊断                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 在非用户级作用域配置 provider                       | §8.3；`scope: "machine"`                                                                                                                                                                                                                                                                                                                                                                                                                                      |

---

## 13. 开放问题（实现必须回答）

1. **BYOK 是否经 `vscode.lm` 暴露？** VS Code 自带的"在 Copilot 里添加 Anthropic / OpenAI / Gemini / Ollama
   密钥"若不暴露，直连就是 VSCodium 用户唯一的活路（本文的排序因此把它放在前面）；若暴露，价值排序要重排。
   **核实方式**：在装了 Copilot 的 VS Code 上把 BYOK 的 Ollama 配好，跑
   `forgejoToolkit.aiPreReviewProbeChatModels`（debug 下可见），看 `selectChatModels()` 是否列出那个模型。
   **这是动手前唯一必须先答的问题**——它不影响接缝的形状，但影响阶段 3 是否还该排在这个位置。
2. **MSW 能不能覆盖流式？** 现有套件用 `msw/node` 的进程内拦截（`src/test/mocks/server.ts`），而 mock **只在非
   生产构建里存在**（`FORGEJO_TOOLKIT_INCLUDE_MOCKS`）。SSE 的 `ReadableStream` 响应能不能被 MSW 稳定地分块
   吐出，是本设计里**最大的技术未知**。备选：`undici` 起一个真实的本机 HTTP server（`tools/ui-review/` 的 dev
   host 需要同一件事，见下条）。
3. **端点没有 tokenizer 时，预算怎么给？——已裁决（阶段 3）。** 三个候选里取 **(a) 保守估算**，并把它与 (c) 的
   "预算未知"合起来用；**(b) 不采用**：`/tokenize` 只有 llama.cpp / vLLM 有，不是协议的一部分，为一个非协议扩展
   新增一条请求路径不划算。裁决有三条，实现里各有对应的常量与判词：
   - **测量**：`countTokens` 回答 `undefined` **且**该模型未声明 `maxInputTokens` 时，按 **2 个 UTF-8 字节 =
     1 token** 估算并向上取整（`estimateAiPreReviewTokens`，常量 `AI_PRE_REVIEW_ESTIMATED_BYTES_PER_TOKEN`）。
     "4 字符 ≈ 1 token"是英文散文的经验值，而本功能的提示词是代码、JSON、路径与 diff 标记；改用 **UTF-8 字节**
     计数还顺带覆盖了非 ASCII 文本（一个汉字 3 字节），而按 JS 的 `text.length`（UTF-16 码元）会把它算成 1。
   - **预算**：模型自己声明的 `maxInputTokens` 优先；直连端点**声明不了**（`AiProviderModelDeclaration` 只有
     id 与 name），此时用**假定的** `AI_PRE_REVIEW_ASSUMED_INPUT_TOKENS = 32768`。方向由两种错误的代价决定：
     假定得**比端点小**会把端点本来放得下的文件从提示词里剪掉——用户看不见的质量损失；假定得**比某台小上下文
     本机服务大**只会让它用自己的错误拒掉这次请求，正是 §9.2 要的"响亮地失败"。所以预算这一半取宽松值，测量
     那一半取保守值，不变量是**宁可少发、不可超发**。
   - **第三种状态**：模型**声明了**预算却回答"量不出来"是实现自相矛盾，不是"这条传输没有 tokenizer"，此时保持接缝
     之前的读法——不做比较，并在日志与 dump 里说明（`AiPreReviewBudgetMode` 的 `'unmeasured'`；`'measured'`
     是普通路径，`'estimated'` 是上面那条）。

   **边距的依据：已实测（2026-10-05）——问题 3 至此不只是裁决。** 拿扩展自己写进 debug 诊断 dump 的预评审提示词
   原文，直连一个 DeepSeek 端点（模型 `deepseek-flash`）发一次带用量回传的请求，四个样本的实测密度如下（"策略估值"即
   `ceil(UTF-8 字节 / 2)`）：

   | 样本                    | UTF-8 字节 | 实测 prompt tokens | 字节/token | 策略估值 `ceil(字节/2)` | 策略高估 |
   | ----------------------- | ---------- | ------------------ | ---------- | ----------------------- | -------- |
   | 扩展自己的预评审提示词  | 1437       | 402                | **3.575**  | 719                     | 1.79×    |
   | 纯中文散文              | 504        | 132                | 3.818      | 252                     | 1.91×    |
   | 英文技术散文            | 514        | 132                | 3.894      | 257                     | 1.95×    |
   | 代码、JSON、路径与 diff | 361        | 147                | **2.456**  | 181                     | 1.23×    |

   真实密度是 **2.456–3.894 字节/token**（随内容而定），常量按 2 字节/token 算，等于把同一段文本的预算占用估高
   **1.23–1.95 倍**（对扩展自己的提示词是 1.79 倍）。错误方向因此明确，也正是这条策略的根据：常量**低估可用的余量**，
   而不是超发——最坏只是提前剪掉端点本来放得下的内容，绝不越过端点声明的预算，保守在安全的那一侧。四个样本里最不保守的
   是**代码、JSON、路径与 diff**（2.456 字节/token、高估 1.23 倍），恰是本功能提示词的主要成分，余量在那里最薄，但仍
   在保守一侧。**假定值在这里不构成限制**：该端点报出的上下文窗口是 **1,048,576** tokens、最大输出 393,216（接缝里读
   不到它——`AiProviderModelDeclaration` 只有 id 与 name），所以假定的 32768 从未绑定（产生该样本的那次运行约用 486 个
   估算 token）；让它无害的不是 32768 这个数字，而是真实窗口远大于假定值——假定只有在服务确实很小时才是限制。
   **已知残余风险**：字节级 BPE 的严格上界是"1 字节 = 1 token"，四个样本都没走到那一步，但病态输入仍可能逼近它，那时
   2 字节/token 会低估一半；这条不掩盖也不静默——超长请求会被端点用自己的错误拒掉，是明确失败。

4. **共享层要不要补一个受限重试？** §6.6 的处置是"传输层不重试"，而 `TODO.md` 那条待办（已随交付移除）的措辞
   曾假定重试已经存在，那句措辞当时已按 §6.6 纠正。要么在 `shared/request` 补一个只对幂等 GET 生效的重试，要么
   把措辞改成"代理 / 超时 / dispatcher"（后者已经做过，剩下的是前者）。这是需要单独裁决的事，本文只记录偏差。
5. **「仅本地」的判定要不要看解析后的 IP？——问题已不存在（2026-10-06）。** 这条规则连同它的判定整体移除（§8.8），
   所以"要不要把 DNS 也算进去"不再有对象。它留下的那条经验仍然成立，并且是移除它的理由之一：一个只看配置字符串的
   客户端侧检查既不能解析主机名，也不得不自己去猜"什么叫本地"，猜错的方向恰好是"以为拦住了而其实没有"。
6. **`aiModelBindings` 的 feature id 从哪来？** 现在有两个功能（AI 预评审与 PR 描述生成）。合法值就是
   `src/ai/modelSettings.ts` 的 `AI_FEATURES`，新功能落地时再扩——"未知 feature 值"的读法已经定死（**忽略**该条目，
   保留其余功能的绑定，见 `aiModelBindingsSettingValue`），并有测试。
7. **设置页要不要显示 provider 的"最近一次使用"**？它与 `KNOWN_ISSUES` 无关，但会让隐私审查更容易（"过去 24
   小时这个端点被用过"）。**建议不做**：又多一份落盘的状态，且当时那条待办（已随交付移除）也没要它。

## 14. 风险

| 风险                                                      | 影响                                            | 处置                                                                                                 |
| --------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **MSW 覆盖不了 SSE**（§13 问题 2）                        | 阶段 2 的"流式与错误分支"验收口径失效           | §11.5：换载体（真实本机 server），**不**降级成只测聚合函数                                           |
| **`tools/ui-review/` 的 dev host 需要长出一台 mock 端点** | UI 走查里"配 provider"这条路无法端到端走查      | §15：要么让 dev host 起一个本机 SSE server，要么把 MSW handler 扩到模型端点；两条路都要在阶段 2 前定 |
| 用户在设置页**看不到**"这次会发到哪个地址"                | 隐私事故（说好的"说清目的地"落空）              | §9.3 的区块 + §7.1 的模态框都把地址顶到前面；§8.7 的测试连接报告里也带地址                           |
| 明文导出**看起来**包含了一切                              | 密钥/header 值进了一个会被分享的文件            | §10.2：未加密导出必须**明说"未包含密钥"**，且 `valueSecret` 标记保留                                 |
| 直连端点的错误面被渲染成 `Forgejo API error …`            | 用户去查 Forgejo 而不是端点，诊断方向全错       | §6.5 的错误面重渲染，且有测试（§11.2 第 7 条）                                                       |
| `scope` 忘了写，provider 能被工作区级覆盖                 | 一个仓库的 `.vscode/settings.json` 决定内容去哪 | §8.3 的 `scope: "machine"`；实现时要有一条测试读 `package.json` 断言之                               |
| 两条路行为"看起来一样、细节不同"                          | 用户无法解释同一功能为何时好时坏                | §11.3 的"两条路跑完整条流程"；差异只允许出现在 §6.7 的表里                                           |
| 未知的 feature / provider 绑定被"就近解析"                | 内容发到用户没点名的地址（正是设置存在的理由）  | §8.4：缺哪一条就点名失败，不猜（照 `reportAiPreReviewModelRefusal`）                                 |

---

## 15. `tools/ui-review/` 要长什么

现状：dev host 的"mock API"是**进程内** MSW（`src/test/mocks/`），`apiMode.ts` 用 mock-only 的字面量探测构建里
有没有它，并且**没有**任何"起一个 HTTP 服务"的能力。直连端点的走查需要**一台真实的 HTTP 端点**（MSW 拦不住
一个我们自己发起的、指向 `http://127.0.0.1:<port>` 的请求吗？能拦住——但那样走查验证的就不是"真能连上本机
Ollama"这件事了）。所以 harness 要长的是：

1. 一个可选中启动的**本机 SSE mock server**（一个 `.mjs`，绑 `127.0.0.1:0`，实现 `/v1/models` 与
   `/v1/chat/completions` 的流式与非流式两种回答，带可切换的错误模式）；
2. 一个把它的地址写进隔离 profile 的 `forgejoToolkit.aiProviders` 的启动步骤；
3. 一个**不走 MSW** 的说明（否则两套拦截会互相遮蔽），以及走查清单里"配 provider → 测试连接 → 跑一次预评审 →
   在 Out 里看目的地"这条路径。
4. **上面三条已落地（2026-10-05）**：`tools/ui-review/src/aiMockServer.ts` 就是那台本机 SSE server，
   `aiMockRun.ts` 管状态文件、detached 子进程与"只杀自己认得的 pid"的停止逻辑，`aiMock.ts` 是它的命令行
   （`serve` / `url` / `requests` / `stop`）。`launch --ai-mock`（`dual launch --ai-mock` 同）先起端点、再把它实际绑到的
   端口写进隔离 profile 的 `forgejoToolkit.aiProviders`，连同 `aiTransport` 与
   `aiPreReview` 的逐功能绑定（`aiModelBindings` 的一条覆盖：按 §8.4 的次序它压过默认值，所以 harness 的种子不必
   跟着 `aiDefaultProvider` / `aiDefaultModel` 改写）；**不写任何密钥**（端点 `auth: "none"`，需要鉴权的端点才需要，而密钥只进
   `SecretStorage`），也**不写** `forgejoToolkit.aiPreReviewPromptScope`——它的默认 `ask` 正是走查里唯一必须由人回答的
   一步。两处与上面措辞不同，按实现记录：① 写成 **TypeScript**（`.ts`）而不是 `.mjs`，因为 harness 本来就用 `tsx`
   直接跑 TS、`pnpm check` 也覆盖它；② 第 3 条的"不走 MSW"已实测：带 MSW 拦截器时，指向回环 SSE 端点的请求被**放行**
   （四个 body chunk 在 183 ms 内分别到达，不是缓冲后一次给出），MSW 只打印一句
   `intercepted a request without a matching request handler`——所以本地端点模式**不需要** `--real-api`，Forgejo 那套
   fixture 原样留着。走查本身仍有前置：构建必须**同时**含传输与 AI 预评审的接线，否则设置页没有 AI 段、预评审也到不了
   端点；这条前置与完整步骤写在 `tools/ui-review/README.md` 的 "The local AI endpoint" 一节里。

---

## 16. 事实核对清单

**引用一律以符号名与标题为准**（行号会随在途改动漂移）。写作时为 HEAD `9e1ffede`。

| 断言                                                                                                                                                                   | 位置（符号 / 标题）                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 取模型清单、去重、身份、输入预算                                                                                                                                       | `packages/forgejo-toolkit/src/aiPreReviewModels.ts` 的 `queryAiPreReviewChatModels` / `uniqueAiPreReviewModels` / `aiPreReviewModelIdentity` / `aiPreReviewModelKey` / `maxInputTokensOf`                                                                                                                         |
| 设置页的模型选择（列表、`reason`、可存值）                                                                                                                             | 同上文件的 `listAiPreReviewChatModelChoices` / `isStorableAiPreReviewModelSettingValue`；`packages/shared/src/webview/messages.ts` 的 `AiPreReviewChatModelOption`                                                                                                                                                |
| 模型设置的取值形态与解析                                                                                                                                               | `src/aiPreReviewSettings.ts` 的 `AI_PRE_REVIEW_MODEL_SETTING` / `parseAiPreReviewModelSelector` / `matchesAiPreReviewModelSelector` / `AI_PRE_REVIEW_MODEL_SELECTOR_FORMS`                                                                                                                                        |
| 设置读取的 fail-closed 先例，以及唯一一个反向的读者                                                                                                                    | `src/aiPreReviewSettings.ts` 的 `readBooleanSwitch` / `aiPreReviewPromptScopeSettingValue` / `aiPreReviewModelSettingValue`；`src/mcpWriteSettings.ts` 的 `enabledMcpWriteTools`；**反向的那一个**是 `src/ai/modelSettings.ts` 的 `aiEnabledSettingValue`（只有显式 `false` 才算关，§8.3）                        |
| 一次运行的顺序（开关 → 模型 → 范围 → 语言 → 预算 → 请求）                                                                                                              | `src/aiPreReview.ts` 的 `runAiPreReview`                                                                                                                                                                                                                                                                          |
| `sendRequest` 的调用点之一（另一处是探测，见 §3.1）与 `justification`                                                                                                  | 同上文件的 `requestPreReviewComments`                                                                                                                                                                                                                                                                             |
| 取消的 token 来源                                                                                                                                                      | 同上文件的 `runAiPreReview`（`vscode.window.withProgress({ location: Notification, cancellable: true })`）                                                                                                                                                                                                        |
| 请求前的两级预算                                                                                                                                                       | 同上文件的 `validateChosenAiPreReviewModel` / `preparePrompt` / `countRequestTokens` / `countTokens`                                                                                                                                                                                                              |
| 同一模型最多 2 次（只在契约失败时）                                                                                                                                    | 同上文件的 `AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL` / `gatherPreReviewRequest`                                                                                                                                                                                                                                      |
| 错误分类与取消判定（按 `code`/`name`，不做 `instanceof`）                                                                                                              | 同上文件的 `classifyModelError` / `isCancellation` / `reportCancelled`                                                                                                                                                                                                                                            |
| 没有模型时的两个报告                                                                                                                                                   | 同上文件的 `listAiPreReviewModels` / `reportNoChatModel`                                                                                                                                                                                                                                                          |
| 答案从候选流取：分类、两股候选、绝不拼接                                                                                                                               | 同上文件的 `classifyResponsePart` / `readResponseStreamParts` / `readResponseCandidates` / `pickResponseCandidate`；`AiPreReviewResponseCandidate`                                                                                                                                                                |
| RPC 信封（`$mid`）的实测与"未知即 data"                                                                                                                                | 同上文件的 `RPC_TEXT_PART_MIDS` / `RPC_REASONING_PART_MIDS` / `RPC_DATA_PART_MIDS` / `responsePartKind`                                                                                                                                                                                                           |
| 单条 `User` 消息（没有 system 角色）与"预算量的就是发出去的那段文本"                                                                                                   | `src/aiPreReviewBrief.ts` 的 `buildAiPreReviewPromptMessages` / `aiPreReviewPromptText` / `AiPreReviewPromptMessage`                                                                                                                                                                                              |
| 有界摘录纪律（≤200 字符）                                                                                                                                              | 同上文件的 `aiPreReviewAnswerExcerpt` / `AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH`                                                                                                                                                                                                                                     |
| 一次性模态框的措辞（含"belongs to the \"{0}\" provider"）与四个按钮                                                                                                    | `src/aiPreReview.ts` 的 `askAiPreReviewPromptScope` / `AI_PRE_REVIEW_SCOPE_BUTTON_*` / `resolveAiPreReviewPromptScope`                                                                                                                                                                                            |
| `vscode.lm` 的类型面（角色只有 User/Assistant、无 System 工厂、`justification`、`modelOptions` 是 provider-specific、错误码 `NoPermissions` / `Blocked` / `NotFound`） | `node_modules/@types/vscode/index.d.ts` 1.102.0 的 `LanguageModelChatMessageRole` / `LanguageModelChatMessage` / `LanguageModelChatRequestOptions` / `LanguageModelError`                                                                                                                                         |
| 引擎底线                                                                                                                                                               | `packages/forgejo-toolkit/package.json` 的 `engines.vscode`（`^1.102.0`）；`@types/vscode` 为 `~1.102.0`                                                                                                                                                                                                          |
| 品牌字段在本仓库一次都没被读过                                                                                                                                         | 可搜索确认：`packages/` 下无 `appName` / `uriScheme` / `appHost` 命中                                                                                                                                                                                                                                             |
| `SecretStorage` 的既有用法与键前缀                                                                                                                                     | `src/config.ts` 的 `TOKEN_SECRET_PREFIX` / `_tokenSecretKey` / `init`（`secrets.onDidChange` / `secrets.get` / `secrets.store` / `secrets.delete`）                                                                                                                                                               |
| 共享请求层：薄客户端、无内建超时、`mergeHeaders`、`RequestError` 的 `Forgejo API error <status>`                                                                       | `packages/shared/src/request/index.ts` 的 `client` / `mergeHeaders` / `RequestError` / `nonJsonSuccessBodyError`；`RequestConfig.responseType` 的 `'stream'`                                                                                                                                                      |
| 超时合并与"默认不是天花板"                                                                                                                                             | `src/api/client.ts` 的 `API_REQUEST_TIMEOUT_MS` / `combineRequestSignals` / `requestSignalFor` / `withAbortSignal`                                                                                                                                                                                                |
| 代理 dispatcher 对与 activation 时装一次                                                                                                                               | 同上文件的 `setDefaultRequestDispatcher` / `withDispatcher`；`src/api/proxy.ts` 的 `createProxyDispatcher` / `getProxyFetch` / `normalizeProxyUrl` / `resolveProxyUrl`；`src/extension.ts` 的 activation 调用                                                                                                     |
| 共享请求层**没有**重试                                                                                                                                                 | 可搜索确认：`src/api/` 下无 `retry` / `backoff` / `maxAttempts` 命中                                                                                                                                                                                                                                              |
| 空闲看门狗的先例（工件下载）                                                                                                                                           | `src/api/client.ts` 的 `downloadActionArtifactToFile`（`API_DOWNLOAD_TIMEOUT_MS` / `stalledError` / `resetIdleWatchdog`）                                                                                                                                                                                         |
| 请求层的 SSE 能力                                                                                                                                                      | `RequestConfig.responseType` 的 `'stream'`（共享客户端把 `response.body` 原样交给调用方）                                                                                                                                                                                                                         |
| 非 2xx 一律变成 `RequestError`（所以模型端点要重渲染错误面）                                                                                                           | `packages/shared/src/request/index.ts` 的 `client`（`if (!response.ok) throw requestErrorFor(...)`）                                                                                                                                                                                                              |
| URL / scheme / userinfo 的校验纪律                                                                                                                                     | `src/webview/connectionTest.ts` 的 `isHttpUrl`；`src/webview/instanceImport.ts` 的 `sanitizeImportedInstances`（`isHttpUrl` + `!hasUrlUserinfo`）；`src/utils/redactUrlUserinfo.ts` 的 `redactUrlUserinfo` / `hasUrlUserinfo`                                                                                     |
| 实例配置的导出/导入（`version: 2`、加密才带 token、原子写）                                                                                                            | `src/webview/viewProvider.ts` 的 `_exportInstances` / `_copyInstancesToClipboard` / `_buildExportData` / `_promptExportPassword` / `_encryptExportData` / `_previewImportInstances`；`src/webview/instanceImport.ts` 的 `ExportData` / `readExportDataFromUri` / `decryptExportData` / `sanitizeImportedSettings` |
| 导入预览不带 token（结构化排除）                                                                                                                                       | `src/webview/instanceImport.ts` 的 `stripInstanceTokens` / `computeImportTokenConflicts`；`packages/shared/src/webview/messages.ts` 的 `ImportPreviewInstance`（`token?: never`）                                                                                                                                 |
| 「测试连接」的既有先例                                                                                                                                                 | `src/webview/connectionTest.ts`；`packages/shared/src/webview/messages.ts` 的 `{ command: 'testConnection'; url; token }`                                                                                                                                                                                         |
| 新设置必须进 `i18nParity.test.ts` 的名单                                                                                                                               | `src/webview/__tests__/i18nParity.test.ts` 的 "gives the AI pre-review and the MCP write settings a name from the pair" / "resolves every %placeholder% the manifest uses in both nls files"                                                                                                                      |
| manifest 设置面与两份 nls 对                                                                                                                                           | `packages/forgejo-toolkit/package.json` 的 `contributes.configuration`；`package.nls.json` / `package.nls.zh-cn.json`；`l10n/bundle.l10n.json` / `bundle.l10n.zh-cn.json`                                                                                                                                         |
| MSW 是进程内拦截，且 mock 只在非生产构建里存在                                                                                                                         | `src/test/mocks/server.ts` 的 `mockServer` / `handleUnhandledRequest` / `startMockServer`；`src/test/mocks/handlers.ts`；`rolldown.config.mjs` 的 `FORGEJO_TOOLKIT_INCLUDE_MOCKS`                                                                                                                                 |
| `@types/vscode` 的整模块 mock 里**没有** `lm`（"没有语言模型 API"是测试的默认环境）                                                                                    | `src/__tests__/extension-setup.ts`；`src/__tests__/aiPreReview.test.ts` 顶部对该套件自建 mock 的说明                                                                                                                                                                                                              |
| 宿主侧用 `vscode.lm` 而不是 MCP sampling 的方向                                                                                                                        | [`../architecture/mcp-server.md`](../architecture/mcp-server.md) 的「Security model」一节末段                                                                                                                                                                                                                     |
| 扩展已上架 Open VSX（没有 Copilot 的编辑器是真实受众）                                                                                                                 | `README.md` 的「Open VSX」一节；`FAQ.md` 的「Can I use it on VSCodium or another VS Code fork?」一节                                                                                                                                                                                                              |
| dev host 的 API 模式判定与"mock 只在非生产构建里"                                                                                                                      | `tools/ui-review/src/apiMode.ts` 的 `MOCK_BUILD_MARKERS` / `detectMockBuild` / `requireApiMode`；`tools/ui-review/README.md` 的「Mock-backed runs and the real-API opt-in」一节                                                                                                                                   |
| 禁止在诊断载荷里出现凭据的既有守卫                                                                                                                                     | `src/__tests__/leasePollingGuards.test.ts` 的 "names no secret surface and no instance token in the modules that build it"                                                                                                                                                                                        |
