# AI 模型传输的接缝与第二种实现（OpenAI 兼容端点）

- 状态：**设计已定稿；接缝与第二种传输连同它的设置面已实施，webview 那一半也已实施（2026-10-04，未在真实编辑器里走查），
  接进 AI 预评审的端到端接线与导出/导入未开工**（本文只写决定与理由）。阶段划分与每阶段的验收口径见 §11；动手前需要确认的未知见 §13；
  已核实的事实见 §16。

- 适用范围：**宿主侧 AI 功能取用一个模型的那一步**。当前已交付的只有 AI 预评审（draft-only，见
  [`ai-prereview.md`](./ai-prereview.md)），本文用它的调用点来定接缝的形状。不含 MCP 工具面、不含自动提交 /
  自动 approve、不含 webview 里的任何模型调用（`vscode.lm` 只在扩展宿主可用）。

- 本文**不是**任务清单：待办与上下文在 `TODO.md` 的「P4 AI 接入 OpenAI 兼容端点（可选的第二种模型传输，默认仍走
  `vscode.lm`）」条目，该条目是本项工作的唯一待办记录，本文只承担"定了什么、为什么、否掉了什么"。

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
  **它没有重试**（§6.6，这是本文明确纠正 `TODO.md` 那一条措辞的一处）。
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
（阶段 3）。**默认仍是 `vscode.lm`，直连默认关闭**——直连需要"端点 + 密钥 + 出网同意"三件齐备。

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

### 3.2 逐功能绑定的先例

`TODO.md` 的同一节里，"PR 描述生成 / Issue 分诊 / 通知摘要"都是 `vscode.lm` 试点。有了两条传输，"哪个功能用哪个
provider / 模型"就必须是一个显式的、可见的设置，而不是各自模块里的隐含默认（§8.4）。

### 3.3 「默认」这个词在本仓库的确切含义

`forgejoToolkit.aiPreReview` 默认 `false`，关闭时"命令拒绝，且不向模型供应商发出任何内容"；提示词范围默认
`ask`，`ask` 是**问题**而不是答案，读不到就按 `ask` 处理（fail-closed）。本文沿用同一纪律：新增的开关默认值
必须落在"什么都不发"的一侧，见 §8.3 的 `aiTransport` 与 §9.3 的 `aiProvidersEnabled`。

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
| 工具面（`tools` / `toolMode`）    | 今天的调用点不传工具（`requestPreReviewComments` 只传 `justification`），而"工具调用"是 `TODO.md` 里明确划为下一档质量的独立立项（§12）                               |
| 推理内容的重试或修补              | 今天的规则是"两股候选各自过契约、绝不拼接、绝不修补"（§3.1）；接缝把它原样保留                                                                                        |
| 一次请求内的自动重试              | 今天的重试是**功能层**的（同一模型最多 2 次，`AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL`），且只在"答案不合契约"时发生。接缝不重试，见 §2.5 与 §6.5                        |
| 一个"费用/用量"回调               | `TODO.md` 明确不做 token 计费统计（§12）                                                                                                                              |

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
- 预设（Ollama `http://127.0.0.1:11434/v1`、LM Studio `http://127.0.0.1:1234/v1` 等）**只是预填**，写进
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
   一个成员就能报"回答被截断"，不必自己去看协议字段。
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

所以 `TODO.md` 里"复用 `shared/request` 已有的代理 / 超时 / **重试** / dispatcher"这句，**重试那一项在本仓库
尚不存在**；本文的处置是"传输层不重试 + 记录这个偏差"，见 §13 问题 4（是否要在共享层补一个受限重试，是需要单独裁决
的事）。

### 6.7 保证的 vs 尽力而为的「OpenAI 兼容」子集

| 能力                                                   | 级别     | 说明                                                                 |
| ------------------------------------------------------ | -------- | -------------------------------------------------------------------- |
| `POST /chat/completions` + `stream:true` 的 `data:` 行 | 保证     | MSW 测试覆盖                                                         |
| `delta.content`                                        | 保证     | 唯一的答案通道                                                       |
| `delta.reasoning_content` / `delta.reasoning`          | 尽力     | 有就当推理候选；没有就只剩文本候选（承接今天的语义）                 |
| `GET /models`                                          | 尽力     | 返回空或 404 时不算失败：模型名由用户手工填（§9.1）                  |
| 非流式 `message.content` 兜底                          | 保证     | 响应不是 SSE 时必须能读                                              |
| `api-key` + `api-version`（Azure）                     | 保证     | 靠自定义 header 机制，不需要新协议（§8.5）                           |
| `tools` / `tool_choice`                                | **不做** | 接缝里就没有（§4.3），属下一档质量                                   |
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

三个独立的事实，任何两个都不能互相推断：

| 事实             | 存在哪                                                 | 谁写的                         |
| ---------------- | ------------------------------------------------------ | ------------------------------ |
| 端点已配置       | `forgejoToolkit.aiProviders`                           | 用户（设置页或手工编辑）       |
| 密钥已存         | `SecretStorage`                                        | 用户（设置页输入）             |
| **同意发送内容** | `forgejoToolkit.aiPreReviewPromptScope` 的 stated 取值 | 用户在模态框里回答后由宿主写回 |

第三个为空（`ask`）时，**前两个齐备也不发**。这条今天是 `ask` 的 fail-closed 读法（
`aiPreReviewPromptScopeSettingValue`），本文不改它，只把它**推广到两条传输**。

### 7.4 配置导入不得静默启用出网

见 §10.3。要点：导入**只写非密字段**，**不写** `aiPreReview` / `aiPreReviewPromptScope` /
`aiProvidersEnabled` / `aiTransport` 这几个"会改变出网语义"的键。

### 7.5 两条传输之间没有自动回退

- 选择了直连，直连失败 → **失败**。不悄悄改用 `vscode.lm`。
- 选择了 `vscode.lm`，没有可用模型 → **报告没有模型并给出两条路**（§9.3）。不悄悄改用直连。
- 一个 provider 不可达 / 鉴权失败 → 报错。**不换**另一个 provider（不做负载均衡，§12）。
- 术语上这与 `ai-prereview.md` 已经定下的"扩展不挑、不换、不轮换"（§2 第 8 条）是同一条纪律，只是从"模型之间"
  扩展到"传输之间"。

---

## 8. 设置与密钥面

### 8.1 provider 的形状

一个 provider 是一个**普通对象**，存在一个数组设置里（照实例列表的先例：`forgejoToolkit.instances` 存在
`globalState`，而这里要能被用户直接编辑与导入导出，所以放 settings）：

```jsonc
{
  "id": "ollama-local", // 校验过的字符集（照 pathSegmentSchema 的纪律）
  "name": "Ollama (this machine)", // 显示名，必填，模态框与设置页都用它
  "baseUrl": "http://127.0.0.1:11434/v1",
  "models": [{ "id": "qwen3:8b", "name": "Qwen3 8B" }],
  "auth": "bearer", // 'bearer' | 'api-key-header' | 'none'
  "headers": [{ "name": "api-version", "valueSecret": true }], // value **不在**这里，§8.2
  "localOnly": false,
}
```

- `headers[].value` **永远不在这里**。数组里只留下名字和一个"值在密钥存储里"的标记。
- `auth: 'api-key-header'` 时的头名固定为 `api-key`（Azure 的写法）；其他自定义头走 `headers`。
- `models` 是"这个端点上有哪些模型"的**声明**，不是白名单：模型 id 是自由文本，`/models` 只用来预填（§9.1）。

### 8.2 哪里放什么（settings vs secret）

| 数据                                                         | 位置                                                                                | 理由                                         |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------- |
| provider id / 显示名 / base URL                              | settings（`forgejoToolkit.aiProviders`）                                            | 非密；要能导入导出、要被用户看见             |
| 模型列表（id + 显示名）                                      | settings                                                                            | 非密                                         |
| 逐功能绑定                                                   | settings（`forgejoToolkit.aiModelBindings`）                                        | 非密；必须是用户可见可改的                   |
| 「仅本地」策略                                               | settings（`forgejoToolkit.aiLocalOnly`）                                            | 非密；策略不是密钥                           |
| 总线开关                                                     | settings（`forgejoToolkit.aiProvidersEnabled`）                                     | 非密；它管的是"允不允许出网"                 |
| 传输选择                                                     | settings（`forgejoToolkit.aiTransport`）                                            | 非密                                         |
| 超时                                                         | settings（`forgejoToolkit.aiModelRequestTimeoutMs`）                                | 非密                                         |
| **API 密钥**                                                 | **`SecretStorage`**，键 `forgejoToolkit.aiProviderKey.<providerId>`                 | 照实例 token 的纪律（`TOKEN_SECRET_PREFIX`） |
| **自定义 header 的 value**（含 `Authorization` / `api-key`） | **`SecretStorage`**，键 `forgejoToolkit.aiProviderHeader.<providerId>.<headerName>` | 见下                                         |

**为什么自定义 header 的 value 也要进密钥存储**：`TODO.md` 的同一节把这条写得很直白——"请求头里常常就是认证
信息（`Authorization` / `api-key`），不能只保护'API 密钥'这一个字段"。一个只保护独立密钥字段、却把
`Authorization` 明文写进 `settings.json` 的实现，等于把纪律绕过去了。

**header 名要校验**：键里的 `<headerName>` 是该字段作分隔符的 `.` 会歧义，所以 header 名照实例 id / 路径段的
纪律校验（`^[A-Za-z0-9_-]+$`）；不合法的名字在设置页就拒绝。

### 8.3 具体的设置 id 与默认值

| 设置 id                                  | 类型    | 默认值  | `scope`   | 语义（决定默认值落在"什么都不发"一侧）                 |
| ---------------------------------------- | ------- | ------- | --------- | ------------------------------------------------------ |
| `forgejoToolkit.aiProviders`             | array   | `[]`    | `machine` | 已配置的 provider 列表；**空数组 = 没有直连目的地**    |
| `forgejoToolkit.aiProvidersEnabled`      | boolean | `false` | `machine` | 是否允许任何 AI 功能通过直连发内容（"第二条独立闸门"） |
| `forgejoToolkit.aiTransport`             | string  | `auto`  | `machine` | `auto` / `vscode-lm` / `openai-compatible`，见 §8.4    |
| `forgejoToolkit.aiModelBindings`         | array   | `[]`    | `machine` | 逐功能绑定（`{ feature, providerId, modelId }`）       |
| `forgejoToolkit.aiLocalOnly`             | boolean | `false` | `machine` | 拒绝非 localhost / 内网的 `baseUrl`（§8.8）            |
| `forgejoToolkit.aiModelRequestTimeoutMs` | number  | `30000` | `machine` | 空闲看门狗窗口与单次请求上限（§6.5、§8.6）             |

**`scope: "machine"` 就是"只允许用户级"的实现方式**：`machine` 作用域的设置**不能**在工作区 / 远程 / 文件夹级
被覆盖（`application` 也只允许用户级，但会阻止 Settings UI 的同步，对一个可能含密钥的配置不合适；密钥本来就不
在这些设置里，但 provider 列表里的 base URL 也算半个秘密）。工作区级配置能把内容指向一个未知地址，正是必须堵住
的：`package.json` 里不写 `scope` 的默认是 `window`，**可以被 `.vscode/settings.json` 覆盖**。

**读者纪律**：照 `aiPreReviewSettings.ts` 与 `mcpWriteSettings.ts` 的既有写法——读设置抛异常时读作"未配置"，
只有显式 `true` 才算开（fail-closed 方向必须是不发）。

### 8.4 `aiTransport` 与 `selectedModelFor(feature)`

| 次序 | 条件                                                         | 结果                                                                          |
| ---- | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 1    | `bindings` 里有这个 feature 的绑定                           | 直连（用绑定里的 provider + model）                                           |
| 2    | 无绑定且 `aiTransport === 'vscode-lm'`                       | `vscode.lm`                                                                   |
| 3    | 无绑定且 `aiTransport === 'openai-compatible'`               | 直连；没有可用 provider / 密钥时**失败**（不回退）                            |
| 4    | 无绑定且 `aiTransport === 'auto'`，且 `vscode.lm` 有可用模型 | `vscode.lm`                                                                   |
| 5    | 无绑定且 `aiTransport === 'auto'`，`vscode.lm` 没有可用模型  | 直连，**仅当** `aiProvidersEnabled` 为真、providers 非空且能定出一个 provider |
| 6    | 以上都不成立                                                 | 明确失败：报告"没有可用模型"并给出两条路（§9.3）                              |

- **`auto` 的选择必须是可解释的**：每次运行在 debug 日志里写一行"这次走 `<transportId>`，因为 `<reason>`"。
- 绑定缺一个 provider 所指（provider 被删、id 写错）时**失败并点名**，不"就近找一个"（照
  `reportAiPreReviewModelRefusal` 的纪律）。
- 绑定是一个**数组**而不是对象：`settings.json` 手编时数组的合并语义比深层对象可预测，也与实例列表一致。

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

1. **先校验**：id 字符集、URL 合法性与 scheme、`apiLocalOnly` 策略、必需字段齐不齐。任何一条不过就在**本地**
   失败，一个字节都不发。
2. 发 `GET <base>/models`（best-effort）：能拿到就列出模型数并**预填**模型列表；404 / 空数组不算失败，改发
   一条**最小**的 `POST /chat/completions`（`max_tokens` 之类不发，§6.3），问一个固定的一字回答。
   **这一步是唯一会给端点发内容的自动动作**，且它由一次显式的用户点击触发。
3. 报告：HTTP 状态、耗时、模型数 / 回答的首部**有界**摘录、以及**这次请求发到了哪个地址**（`redactUrlUserinfo`
   渲染的 base URL）。**绝不**回显密钥或任何 header 的 value。
4. 失败按 §6.5 的错误面分类给出可行动的话（"地址里通常要带 `/v1`"这一条尤其重要）。

### 8.8 「仅本地」约束

- `aiLocalOnly: true` 时，端点主机名必须落在：`localhost`、`127.0.0.0/8`、`::1`、`.local` 后缀、以及私有网段
  （`10/8`、`172.16/12`、`192.168/16`、`fc00::/7`）——照 `resolveProxyUrl` 那种"能读就读、读不动就不放行"的写法，
  **解析失败视为不本地**。
- 违反时：设置页标红、运行前拒绝并点名该 provider 与策略设置；**不静默降级**成"还是发出去吧"。
- 这条**不**用"能不能连通"来判断，只看配置的地址——DNS 重绑定不是本文的威胁模型（§13 问题 5）。

上面列的网段、`isLocalAiEndpointHost` 里的 `127.` / `10.` / `172.16–31.` / `192.168.` / `fc00::` 前缀，以及它
的测试为每一段各取的一个代表地址（回环、`10/8`、`192.168/16`），都是**这条策略的定义域本身**，而不是某个具体地
址——策略说的就是"落在这几段里算本地"，离开这些字面量无从表述。测试用它们只为逐段跑通这个判定，没有别的用途，
`AGENTS.md` 的「Code content」一节也为此写明了例外。

### 8.9 NLS 条目（**本阶段不动 NLS 文件**）

选择：**本阶段只写名字、不编辑 `package.nls.json` / `package.nls.zh-cn.json`**（两者必须同步改，等到阶段 1 落地
设置与文案时一起做）。阶段 1 必须新增的键（英文 / 中文成对）：

| 键                                                                             | 说明                     |
| ------------------------------------------------------------------------------ | ------------------------ |
| `config.aiProviders.title` / `.description`                                    | provider 列表            |
| `config.aiProvidersEnabled.title` / `.description`                             | 直连总开关（默认关）     |
| `config.aiTransport.title` / `.description`                                    | 传输选择                 |
| `config.aiTransport.enumDescriptions.auto` / `.vscodeLm` / `.openAiCompatible` | 三个取值各自说清走哪条路 |
| `config.aiModelBindings.title` / `.description`                                | 逐功能绑定               |
| `config.aiLocalOnly.title` / `.description`                                    | 仅本地策略               |
| `config.aiModelRequestTimeoutMs.title` / `.description`                        | 超时                     |
| `command.aiTestProvider.title`                                                 | 「测试连接」             |

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

| 能力缺口                              | 谁受影响                  | 处置                                                                                                                     |
| ------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 不支持 `stream: true`                 | AI 预评审（它按流读答案） | 能读非流式完整响应（§6.4 第 7 条）；读不出就明确失败，**不换路**                                                         |
| 输出被 `finish_reason: 'length'` 截断 | AI 预评审的 JSON 契约     | 明确报"回答被截断"（这个读数在接缝上是 `AiCompletionResult.truncated`，§4.2），并建议提高端点侧输出上限 / 换更听话的模型 |
| 不返回合规 JSON                       | AI 预评审                 | 沿用今天的处置：同一模型最多重试 2 次，然后按契约失败报告并计数（§3.1）                                                  |
| 端点无鉴权 / 鉴权方式不同             | 所有直连功能              | §8.5 的 `auth` + 自定义头；`none` 合法                                                                                   |
| 端点上模型列表为空                    | 设置页的模型下拉          | 允许手工填模型 id；列表为空**不是**失败（`/models` 只是尽力而为）                                                        |
| 工具调用 / agent 循环                 | 未来功能                  | **不出现**该功能，并直说"这个端点不支持"（§12）                                                                          |

**底线**：任何能力缺口都不得让功能"悄悄换一种行为"（例如本来会校验锚点的功能变成不校验）。

### 9.3 设置面在"没有可用模型"时必须说什么

今天的设置页只有一行模型下拉，空列表时给一句 `reason`（`listAiPreReviewChatModelChoices`）。**没有可用模型是
最常见的一种状态**（VSCodium），所以这一行要升级成一个明确的区块：

1. **直说**：现在这个编辑器没有提供任何聊天模型（`vscode.lm` 存在但列表为空 / 根本不存在 API），AI 功能因此
   不可用。
2. **给出两条路，各自可点**：
   - 装一个贡献语言模型的扩展并登录（不点名 Copilot——`vscode.lm` 接的是**所有**这样的扩展）；
   - 配一个 OpenAI 兼容端点（地址 / 模型 / 密钥 / 测试连接），并说明这条在 VSCodium 这类编辑器上是唯一的路。
3. **在用户做出选择之前，功能保持关闭**：不因为是 fork 就把 `aiProvidersEnabled` 打开，也不预填任何默认端点。
4. 让这条路**显眼**（提示与入口顶到前面），而不是悄悄启用它。

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
    "providers": [{ "id", "name", "baseUrl", "models": [...], "auth", "headers": [{"name"}], "localOnly" }],
    "bindings": [{ "feature", "providerId", "modelId" }],
    "transport": "auto",
    "localOnly": false
  }
}
```

- `settings` 里的既有字段集合**不动**：`ExportSettings` 是 webview 与宿主共享的类型，`sanitizeImportedSettings`
  也逐字段白名单校验（`sanitizeImportedSettings` 的纪律：未知字段**丢弃**而不是猜）。`ai` 段同样要有一个
  `sanitizeImportedAiConfig`，逐字段校验（id 字符集、URL 合法性与 scheme、auth 取值、模型条目形状）。
- **不导出** `aiProvidersEnabled` / `aiPreReview` / `aiPreReviewPromptScope`：它们是"出网语义"的开关，导入它们
  等于让一个文件改变另一台机器的隐私姿态（§7.4）。
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

1. 导入**不写** `aiProvidersEnabled` / `aiPreReview` / `aiPreReviewPromptScope` / `aiTransport`。
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

### 11.5 什么证据会推翻整份设计

- 若 BYOK 事实上经 `vscode.lm` 暴露（§13 问题 1），直连的价值排序要重排（阶段 3 的优先级可能要降）；
- 若"两股候选流"在真实直连端点上的行为与 `vscode.lm` 差到需要功能层分支，那么接缝的形状（§4.2）需要重开；
- 若 MSW 无法覆盖 SSE 的流式（§13 问题 2），阶段 2 的验收口径必须换载体，而**不能**降级成"只测聚合函数"。

---

## 12. 非目标

| 不做                                                | 为什么                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 为每家写一套原生 SDK（Anthropic / Gemini 原生协议） | §6.8；要做就是第三个实现，共用同一道接缝                                                                     |
| 让 MCP 侧去调用模型                                 | 架构上刻意非目标：MCP server 是纯工具/提示面，不做任何 LLM 调用（见 mcp-server.md 的「Security model」一节） |
| 两条传输之间的自动回退                              | §7.5；"失败即失败"是硬要求                                                                                   |
| 多个 provider 之间的自动回退或负载均衡              | 同上；给定 provider 不可达就报错                                                                             |
| token 计费 / 用量统计                               | `TODO.md` 明确不做；接缝里也没有用量回调（§4.3）                                                             |
| 模型 / 供应商预设市场                               | 预设只是预填（§6.2），不是一个市场，也没有中心索引                                                           |
| 工具调用与 agent 循环                               | `TODO.md` 划为「下一档质量」的独立立项；接缝里没有工具面（§4.3）                                             |
| 把密钥放进 settings                                 | §8.2；硬要求                                                                                                 |
| 按编辑器品牌改变出网语义                            | §9.1；品牌只进诊断                                                                                           |
| 在非用户级作用域配置 provider                       | §8.3；`scope: "machine"`                                                                                     |

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
3. **端点没有 tokenizer 时，预算怎么给？** 三个候选：(a) 保守的字符 → token 比（例如 4 字符 = 1 token）加安全
   边距；(b) 用端点自己的 `/tokenize`（只有 llama.cpp / vLLM 有，不是协议的一部分）；(c) 干脆按
   `maxInputTokens` 未知处理，只在明显过大时拒绝。**建议 (a)**，但边距取多少要实测（同一份 brief 在 Ollama 与
   某个托管端点上分别量一次）。
4. **共享层要不要补一个受限重试？** §6.6 的处置是"传输层不重试"，`TODO.md` 的措辞则假定重试已经存在。要么在
   `shared/request` 补一个只对幂等 GET 生效的重试，要么把 TODO 的措辞改成"代理 / 超时 / dispatcher"。这是需要
   单独裁决的事，本文只记录偏差。
5. **「仅本地」的判定要不要看解析后的 IP？** §8.8 只看配置的地址。若要把 DNS 也算进去，就要在每次请求前解析
   主机名，代价是一个额外的网络往返与一个新的失败面。建议不做（威胁模型不同）。
6. **`aiModelBindings` 的 feature id 从哪来？** 现在只有一个功能（AI 预评审）。建议先只有 `'aiPreReview'` 一个
   合法值，新功能落地时再扩——但"未知 feature 值"的读法（忽略 / 拒绝）要在实现时定死，并测出来。
7. **设置页要不要显示 provider 的"最近一次使用"**？它与 `KNOWN_ISSUES` 无关，但会让隐私审查更容易（"过去 24
   小时这个端点被用过"）。**建议不做**：又多一份落盘的状态，且 `TODO.md` 没要它。

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

---

## 16. 事实核对清单

**引用一律以符号名与标题为准**（行号会随在途改动漂移）。写作时为 HEAD `9e1ffede`。

| 断言                                                                                                                                                                   | 位置（符号 / 标题）                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 取模型清单、去重、身份、输入预算                                                                                                                                       | `packages/forgejo-toolkit/src/aiPreReviewModels.ts` 的 `queryAiPreReviewChatModels` / `uniqueAiPreReviewModels` / `aiPreReviewModelIdentity` / `aiPreReviewModelKey` / `maxInputTokensOf`                                                                                                                         |
| 设置页的模型选择（列表、`reason`、可存值）                                                                                                                             | 同上文件的 `listAiPreReviewChatModelChoices` / `isStorableAiPreReviewModelSettingValue`；`packages/shared/src/webview/messages.ts` 的 `AiPreReviewChatModelOption`                                                                                                                                                |
| 模型设置的取值形态与解析                                                                                                                                               | `src/aiPreReviewSettings.ts` 的 `AI_PRE_REVIEW_MODEL_SETTING` / `parseAiPreReviewModelSelector` / `matchesAiPreReviewModelSelector` / `AI_PRE_REVIEW_MODEL_SELECTOR_FORMS`                                                                                                                                        |
| 设置读取的 fail-closed 先例                                                                                                                                            | 同上文件的 `readBooleanSwitch` / `aiPreReviewPromptScopeSettingValue` / `aiPreReviewModelSettingValue`；`src/mcpWriteSettings.ts` 的 `enabledMcpWriteTools`                                                                                                                                                       |
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
