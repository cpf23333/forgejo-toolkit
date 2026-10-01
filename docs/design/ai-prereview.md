# AI 预评审（draft-only）

- 状态：**设计已定稿；阶段 0–4 已交付**（2026-09-29 写作，2026-09-29 实现）。§10 的四个阶段
  在同一次改动里落地，§13 的全部八个问题也已由维护者裁决并改写进下面的正文；本文只记录
  **决定了什么、为什么、否掉了什么**，仍未做的部分（要不要「只评当前文件」的开关等）记在
  `TODO.md` 的「AI 预评审（draft-only）剩余决定」条目里（设计文档只指向跟踪条目，不持有待办项的唯一副本）。
  与既有两份记录不同，本文写作时**没有**任何「已交付」段落，读到时请按"计划"而非"现状"理解；
  状态与交付记录见 `docs/design/README.md` 的索引行与 `FEATURES.md` 的 **已完成** 一节。
- 状态修正（2026-10-01，维护者裁决）：**"谁来选模型"这一块改过一次**——空设置不再表示"自动选择"，
  扩展也不再在模型之间轮换。**以「交付后的修正（2026-10-01，维护者裁决：否决任何形式的自动选择）」
  那一节为准**；本文其余各处被它推翻的文字已就地标为删除线，保留原文与理由，便于核对否掉了什么。
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
- 交付后的修正（2026-10-01，第二次 UI 验证：选到模型、读到 PR、进度与模型调用都跑通了，但
  **4/4 次运行都落在"回答无法解析"这一支**，多选确认清单因此从未出现、落草稿那一半仍未验证）：
  ① 契约失败不再共用一句"不是约定的 JSON 对象"，而是分成**空回答**、**不是 JSON**、**JSON 形状
  不对（点名是哪个字段：顶层 / `comments`）**三种，各有一条用户消息与一行日志；被问模型的
  `vendor` / `family` / `id` 写进日志，回答本身只留一条 **debug 级、有界**的形状描述（长度、是否
  以 `{` 开头、首行前 60 字符），**不写回答、不写简报、不写 diff**（§7.2）；② 契约失败改为
  **换下一个可用候选重试**（第五次排查后改为**先问同一个模型两次**，见下一条）：每次运行最多问 3 个
  模型、只对契约失败重试，成功的
  那个照常进入 §5 的确认清单，全部失败的提示点名每个模型与它失败的方式并写出这个上限（§6.4、
  §6.5、§7.2）；③ 尝试顺序改为**本窗口内曾给出合规回答的模型优先**（新近者在前），其余仍按输入
  预算降序——`@types/vscode` 1.102 没有"用户最近选用的模型"这类信号，证据见 §7.2 与 §9.1。
  预算逻辑、开关语义与"失败时不发不写"都不变。
- 交付后的修正（2026-10-01，第三次排查：维护者机器上 `vscode.lm.selectChatModels()` 提供的三个模型
  （`vendor` 全是 `deepseek`）对真实请求都回了**退化回答**——长度 5–10 字符，首行是 `comments[]` 与
  `{"":}`，形状像回答的碎片，既不是拒绝也不是中途截断——解析照旧正确拒绝，于是确认清单与"落草稿"
  那一半在真机上仍未被跑到）：① 新增**只在 `forgejoToolkit.debug` 打开时**存在的诊断 dump
  （`src/aiPreReviewDiagnostics.ts`，文件写在 `context.logUri` 下的 `ai-pre-review-diagnostics.log`）：
  每次模型调用一节，写明被问模型的 `vendor`/`family`/`id`、请求与回答各自的 ISO 时间戳与耗时、
  **原样发出的每条消息（role + 文本，指令那一半在内）**与**完整原始回答**，外加一节 run 头（目标、
  两个开关、被提供的模型及其 `maxInputTokens`、尝试上限、请求形态）。默认路径一个字都不变：debug 关闭时
  这个 sink 连文件路径都没有，~~输出通道里仍然只有那条**有界形状描述**~~（**2026-10-01 修正：契约失败时
  输出通道还带一条有界摘录，见本文开头那条修正**），debug 打开时多一行**文件路径**、以及回答的**碎片
  清单与小结**（**2026-10-01 第八次修正，见本文开头那条**：一行一个碎片、一行两个总数与拼接结果的
  有界开头，只有 debug 打开时才有，见下同）
  （§7.2、§9.6）；② 新增 `forgejoToolkit.aiPreReviewProbeChatModels` 命令：在
  `contributes.menus.commandPalette` 里以 `config.forgejoToolkit.debug` 把关，处理体再查一次功能开关与
  debug，向**每一个**被提供的模型各问三种形态的同一句废话（单条 `User` 无指令 / 两条 `User` 即旧形态 /
  单条 `User` 含指令即新形态），把问句与回答写进同一个文件，用来把"我们的请求不对"与"这些模型根本
  答不了"分开；③ 请求形态由**两条 `User` 消息**改为**一条 `User` 消息**（指令在前、请求在后），API
  依据见 §9.1，代价与理由见 §7.2；预算因此按**真正发出的那一段文本**计一次，不再把两半的
  `countTokens` 相加。
- 交付后的修正（2026-10-01，第五次排查：用只读诊断把"请求形态不对"与"这些模型答不了"分开，结论是**都不对**，
  真正的原因是提供者**按次**不稳定）：`forgejoToolkit.debug` 打开后用诊断 dump 里的探测命令对维护者机器上
  `selectChatModels()` 提供的 **12 个**聊天模型各问 3 种形态（共 **36 次**调用）——只有 **6/36** 有返回，且这 6 次
  全是字面量 `{}`（本身就是契约违规，没有 `comments` 数组），其余是**零长度流**，另有一次 `comments }` 碎片；
  旧的两条 `User` 形态与新的单条 `User` 形态**各自既有成功也有失败**，所以**形态不是变量**，第三次排查关于"两半
  合成一条"的结论到此被证据否定为"不是这台机器上的原因"（合成一条本身仍是正确的简化，保留）。随后一次真实运行
  **3/3 全失败**，回答是 5–10 字符的碎片，而同一位 `deepseek` 提供者在别的运行里能答——即**同一个模型有时能答、
  有时答不出**，失败是**每次调用**的性质，与发出去的内容无关。于是这一条：① 契约失败改为**先问同一个模型**
  （同一模型、同一条提示词，最多 2 次），用尽后才换下一个候选；② 两个上限各自命名并相乘——
  `AI_PRE_REVIEW_MAX_MODELS_PER_RUN = 3`（不同模型）与 `AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL = 2`（每模型次数），
  所以一次运行**最多 6 次模型调用**（`AI_PRE_REVIEW_MAX_MODEL_CALLS = 3 × 2`）；③ 硬失败仍然一律不重试（模型调用
  报错 / 同意被拒 / 取消），合法 JSON 但锚点全被丢弃也照旧不重试；④ 用户消息按实际花费报数——"共发出 N 次模型
  调用（最多 3 个不同模型、每个最多问 2 次，因此每次运行最多 6 次调用）"+ 每个模型被问了几次、每次失败在哪；
  ⑤ 运行在后来某次尝试上成功时，日志写明**是哪个模型、在第几次尝试**（`... did, on attempt 2 of 2 for that model
(2 call(s) spent this run)`）——这句就是"重试救回了一个不稳定的提供者"的证据行；⑥ 诊断 dump 的每次调用块里
  标出"这是这个模型的第几次询问、也是整次运行的第几次调用"（`attempt 1/2 for this model (call 1/6 of the run)`），
  所以同一个模型被问两次时两块可区分；探测命令本身一行不改（它按"模型 × 形态"各写一块，与运行的重试无关）。
  代价记在这里：最坏情况的调用数是原来的两倍（3 → 6），换来的是"按次不稳定"这类失败在一次运行内被吸收；
  这两个数字（3、2）是本文的**唯一**上限声明处，用户消息与 dump 的 run 头都引用它们。
  **这一段已被 2026-10-01 的维护者裁决推翻**（见下一条）：上限只剩"每个模型 2 次"，跨模型的那一半连同
  "不同模型最多 3 个"一起删掉了。
- 交付后的修正（2026-10-01，**维护者裁决：否决任何形式的自动选择**——扩展不得替用户挑模型，也不得在模型
  之间轮换；必须**列出可用模型、让用户选、然后一直用这一个**）。这一条推翻**紧接其后的"第四次排查"那条的
  核心机制**（该条原文与理由保留在下面，便于核对"否掉了什么"），也推翻本文此前两处决定，原始文字同样
  保留在原处（见 §6.4、§6.5、§7.2 的删除线段落）：
  ① **被推翻的**：空设置 = 自动选择（按输入预算降序取第一个装得下的，一个都装不下时退回预算最大者）；
  契约失败时**换下一个候选模型**（不同模型最多 3 个 × 每个 2 次 = 最多 6 次调用）；尝试顺序按**本窗口内
  曾给出合规回答**的模型优先；没配置时弹一次 QuickPick 并**按窗口记住**（不落盘）。推翻的理由是维护者的
  要求本身，而不是新测量：探测证据（12 个模型 × 3 种形态 = 36 次调用，只有 6 次有返回且全是 `{}`；随后
  一次真实运行 3/3 全是 5–10 字符碎片，见本文开头第五条）**仍然成立**，但它支持的是"同一个模型可以再问
  一次"，不是"扩展可以自己换模型"——后者是替用户做选择，而用户的选择才是这段设计的正当性来源。
  ② **选择的唯一来源是设置**：`forgejoToolkit.aiPreReviewModel` 就是那个选择，写入方式是**普通的全局
  配置更新**（`ConfigurationTarget.Global`），所以设置界面里能看到它、也能手改它；扩展不再保留任何竞争性
  的存储——没有窗口记忆、没有"本窗口曾答对"的顺序、没有预算排序、没有"退回预算最大者"。
  ③ **空设置 = 问，而不是猜**：运行时弹出 QuickPick，列出 `vscode.lm.selectChatModels()` 提供的**每一个**
  模型（不是"装得下指令的那些"，按预算过滤本身就是替用户筛），每行给出显示名、`vendor/family`（含 `id`）、
  `maxInputTokens` 与**简报会发给哪个提供者**；选中后写进设置（写 `vendor/id`，因为 family 可能被两个模型
  共享，写 family 会让下一次运行匹配到另一个模型——那正是"静默替换"），并用于本次运行；**取消 = 运行取消**，
  零模型调用、零请求、什么都没创建、设置一个字都不写。
  ④ **新增命令 `forgejoToolkit.aiPreReviewChooseModel`**（调色板里可直接调用，不受功能开关把关：选模型是
  配置，不发任何内容）：列出、询问、写入。运行在"配置的模型不再可用"时用它指路——本 API 版本的 `MessageItem`
  只有标题、挂不上命令，所以提示里写命令标题与命令 id。
  ⑤ **留下的只有校验，且绝不替换**：配置的取值解析不了、或没有命中任何被提供模型时**拒绝**并列清单；
  选定的模型装不下**固定指令提示词**时按两个数字拒绝（点名模型：需要多少 / 可用多少），分词器量不出来时
  单独拒绝；请求装不下时同样给出两个数字与"关掉 `aiPreReviewIncludeDiff` / 换一个预算更大的模型"两条出路。
  没有任何一条路径会把运行换到另一个模型上——运行中唯一能改变模型的事情是用户自己改设置。
  ⑥ **有界重试只作用于选定的那一个模型**：同一模型、同一条提示词，最多 `AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL = 2`
  次，所以一次运行最多 **2 次模型调用**；`AI_PRE_REVIEW_MAX_MODELS_PER_RUN` 与 `AI_PRE_REVIEW_MAX_MODEL_CALLS`
  两个常量删除，"不同模型最多 3 个 / 最多 6 次调用"的消息口径随之删除，失败消息改为报出实际调用数、该模型
  被问了几次、每次失败在哪。硬失败 / 同意被拒 / 取消 / 合法 JSON 但锚点全丢仍然一律不重试。
  ⑦ 文档与门面同步：`FEATURES.md` 的能力条目改为"由用户选择模型"（含"空设置每次都问"与"选定后固定"），
  `.changeset/ai-pre-review.md` 与两份 `CHANGELOG` 同步改写，本记录 §6/§7/§9/§12 已改。
- 交付后的修正（2026-10-01，**同一个选择现在有三个入口**：扩展自己的设置页、命令
  `forgejoToolkit.aiPreReviewChooseModel`、以及 `forgejoToolkit.aiPreReviewModel` 这个设置字段本身。
  三者写的是同一个值、同一个作用域（全局配置），所以不存在"哪一个才算数"的问题；设置页那一行只是把
  命令里的那份列表搬到用户找设置的地方）。
  ① **设置页里的下拉**：`settings.aiPreReviewModel` 一行渲染一个 `vscode-single-select`，选项来自新的
  请求/回复对（webview 发 `getAiPreReviewChatModels`，宿主回 `aiPreReviewChatModels`），每项给出显示名、
  `vendor/family`、`id`、`maxInputTokens` 与**该模型会被写成的取值**（`vendor/id` 优先，与 QuickPick
  相同），注释行写明**简报会发给哪个提供者**（这一行的隐私含义与 QuickPick 的 `detail` 一致）；另有
  **刷新**按钮（模型集合会随运行环境变化：签入一个提供者、装上一个扩展），以及一个明确的
  "每次运行都询问（不保存模型）"项——空设置本来就是那个含义，不给它一个选项，用户就没法从界面上回到默认。
  ② **降级必须说清楚**：`vscode.lm` 不存在、`selectChatModels()` 抛错、或一个模型都没有时，回复带
  `reason`（宿主用 `vscode.l10n.t` 写好的整句，而不是 webview 再翻一遍），设置页把它显示在空列表的位置——
  一个空下拉加一句解释，好过一个空下拉。取值命中不了任何被提供模型时同样在那一行写明当前配置值。
  ③ **写入**走 `setAiPreReviewChatModel` → `writeAiPreReviewModelSetting`，即与 QuickPick 完全相同的
  **普通全局配置更新**；宿主先用 `isStorableAiPreReviewModelSettingValue` 校验形态再写（webview 是不可信
  输入，且这是用户设置，写进去的只能是一个语义上跑得起来的取值或空串）。写失败时回复带 `error`，设置页
  把下拉恢复成真正存着的那个值并把错误显示在旁边，而不是让界面停在一个没写进去的选择上。
  ④ **为什么 manifest 字段不能做成下拉**：模型列表只存在于运行时
  （`vscode.lm.selectChatModels()`），而 `contributes.configuration` 是静态声明，VS Code 无法为它渲染
  动态枚举，所以 `forgejoToolkit.aiPreReviewModel` 只能保持自由文本、只能手填；"选择"因此必须有自己的
  运行时 UI，这正是前两个入口存在的原因，而设置页那一行是第三个。
  ⑤ **三个入口都不发模型调用**，也都不受 `forgejoToolkit.aiPreReview` 开关把关：选模型是配置，不是使用
  （列表本身不碰任何提供者）。宿主侧的实现放在新模块 `src/aiPreReviewModels.ts`：一个被提供模型的读取、
  命名、去重与"设置能不能写它"是同一个答案，运行侧（`src/aiPreReview.ts`）与设置页
  （`src/webview/viewProvider.ts`）共用它，而后者不能 import 前者（会成环）。
- 交付后的修正（2026-10-01，第四次排查：真机上被提供的模型对真实请求都回退化回答，而默认路径按
  设计不保留回答正文，于是"到底该问谁"在默认路径上无法回答；同时按 `@types/vscode` 1.102 逐条核对，
  确认**不存在**"用户在聊天选择器里选了哪个模型"这类读数，证据见 §9.1）：**把选谁交给用户**——
  **（核心机制已被上一条裁决推翻：取值不再传给 `selectChatModels` 作选择器、不再有窗口记忆、不再有
  "空 = 自动选择"；原文保留在下面，只有"设置是用户的选择"这一条被继承下来。）**
  ① 新增窗口级设置 `forgejoToolkit.aiPreReviewModel`（字符串，默认空 = 自动选择），取值用
  `LanguageModelChatSelector` 自己的词汇：`vendor/family` 或 `vendor/id`，可带可选的 `@version` 后缀
  （例 `deepseek/deepseek-flash`）；解析只放宽大小写与首尾空格，**其余一律不猜**：取值解析不了、或没有
  命中任何被提供的模型时，运行**直接拒绝**，提示写明配置的值并列出**每个**被提供模型及其
  `vendor/family`（family 与 id 不同时另列 `id`）与 `maxInputTokens`，让用户能改对；解析出的选择器
  **同时**传给 `selectChatModels(selector)` 并用于过滤与排序返回值（命中的排最前），所以"提供者不认
  选择器"也不会把设置变成空操作。② 没配置取值、且能装下指令的候选多于一个时，运行先弹一次 QuickPick
  问用哪个模型：每项写明显示名、`vendor/family`、`id` 与 `maxInputTokens`，并**明确点出简报会发给哪个
  提供者**（这个设置的隐私含义就在这里）；选择**按窗口记住**（模块级、不落盘，与"曾答对"的记忆同一
  形态），只有一个候选项时不问，用户取消时按 §6.4 的取消口径处理：什么都没发、什么都没建。③ 两条路
  怎么合：配置的模型同时也是被提供的模型 → 它排第一且不弹窗；配置了但没命中 → 拒绝并列清单；跑成功
  之后本窗口记住"哪个模型真的按契约回答了"，下次没配置时可复用那条记忆而不再问（每次运行都问一遍是
  噪声，理由见 §7.2 的"窗口记忆"）。默认路径（设置为空、只有一个候选）与 §6.4 的重试上限都不变。
- 交付后的修正（2026-10-01，**开关关掉时动作不再出现在菜单里**；同一次改掉一个能漏到界面上的 i18n 键）：
  ① `forgejoToolkit.aiPreReviewPullRequest` 的两个菜单贡献（`editor/context` 与 `editor/title`）此前只由既有的
  `forgejoToolkit.inPullRequestDiff` 把关，于是开关关掉时**编辑器标题栏按钮与右键菜单项仍然出现**，点下去才被
  命令拒绝——维护者看到的正是这个。两个 `when` 现在都写成
  `forgejoToolkit.inPullRequestDiff && config.forgejoToolkit.aiPreReview`（`config.<setting>` 是 VS Code 自己
  维护的标准上下文键），这才与 §7.3 ③「关闭时本功能完全不出现在菜单里」一致。**运行时那条拒绝照旧保留**：
  上下文键回答的只是"要不要显示这个入口"，它不是闸门——直接调用命令仍然拒绝、仍然不发不建（§2 第 3 条）。
  `commandPalette` 里那条 `when: false` 不变（命令仍不出现在面板里），
  `forgejoToolkit.aiPreReviewChooseModel` 也不受影响：选模型是配置、不发任何内容，它的入口本来就不受开关把关（§7.2）。
  测试：`src/__tests__/aiPreReview.test.ts` 新增一条，逐个断言两个菜单项的 `when` 必须同时要求开关、面板那条仍是
  `false`，并断言没有任何菜单项给选模型的命令加 `when`。
  ② 状态检查面板的汇总行用 `dashboard.detail.checksState.${statusChecks.state}` 现场拼键，而
  `statusChecks.state` 是**服务端 combined status 的原样透传**（`src/api/client.ts` 把 `combinedStatus.state`
  直接放进去，类型只是 `state?: string`），所以 `en.json` / `zh.json` 里没写的取值会把原始键
  `dashboard.detail.checksState.xxx` 印在界面上。同一个文件的 `statusStateLabel()` 早就是"查出来的值等于键本身
  就退回 `dashboard.detail.checksState.unknown`"这一种机制（合并阻碍行用它），模板现在也走同一个函数，不再有
  第二种拼键方式：未知状态显示本地化的「未知」而不是原始键。测试：新的
  `webview/src/views/__tests__/PullRequestDetail.checksStateLabel.test.ts`（七种已知状态 × 两种语言各显示自己的
  文案，一个未列出的 `expected` 必须显示 unknown 且绝不出现原始键），外加
  `src/webview/__tests__/i18nParity.test.ts` 里新的一条把七种状态钉死的用例——既有的"每个字面量键都存在"那条
  只读单引号字面量，**看不到模板字面量拼出来的键**，这正是这个缺陷溜过去的原因，所以那条钉死的用例必须存在。
  ③ 同一个形状还在探测命令上：`forgejoToolkit.aiPreReviewProbeChatModels` 的调色板条目此前只由
  `config.forgejoToolkit.debug` 把关（§9.6），而处理体要求**两个**条件，所以 debug 打开、开关关掉时它是
  "出现了但保证被拒绝"。它的 `when` 现在同样写成
  `config.forgejoToolkit.debug && config.forgejoToolkit.aiPreReview`——入口与处理体的要求一致，
  处理体自己那两次检查（debug、开关）**一个字都不改**，上下文键仍然只是可见性。它的测试从"钉住旧的那一个
  条件"改成"钉住两个条件的完整字符串"。
  ④ 顺着这条把**所有**带 `when` 的贡献都核了一遍（扩展只有一份 manifest：16 个命令、8 个带门槛的菜单项、
  没有 keybinding、没有 `viewsWelcome`、1 个视图），逐个对比处理体的要求。除上面两处外**没有第二处**
  "静态可得却漏在 `when` 里"的条件；剩下的拒绝都是**数据相关**、`when` 读不到的状态，因此**有意保留**：
  `copyPermalink` 在 PR 新增文件的 base 侧 / 删除文件的 head 侧（`status` 与 `isBase` 只存在于 diff URI 的
  query 里，`resourceScheme` 之外没有上下文键能表达它；拒绝时说明的是"这个链接会 404"），
  以及多根工作区里"某个文件夹已关联、被点的文件在另一个未关联文件夹"这一情形（`forgejoToolkit.hasLinkedRepo`
  是窗口级键，要表达它得新加一个按资源维护、由防抖 git 扫描支撑的键）；
  `createPrFromCurrentBranch` 的 detached HEAD、`addPullReviewComment` 在新增/删除文件的空侧
  （"Comments can only be added to lines within the pull request diff"）同理。
  它们拒绝时都点名具体原因，不是"功能没开"这种整片状态的拒绝。选模型的命令与设置页那一行不属于这一类：
  它们本来就不该被开关把关（§7.2 ⑤），现在也仍然没有被把关。
- 交付后的修正（2026-10-01，**"回答永不进输出通道"改为"成功时不写；契约违规时写有界摘录"**——维护者的
  真实故障只报了「attempt 1 of 2: 回答不是 JSON; attempt 2 of 2: 回答不是 JSON」，维护者指出"只说不是
  JSON 不好判断问题"：模型退化、回答被截断、还是我们的提示词不对，这三种在这句话里分不出来，而回答的
  形状此前只在 `forgejoToolkit.debug` 打开时才可见、完整回答同样只在 debug 的 dump 里）：
  ① **契约违规时，无论 debug 与否**，每次失败的尝试都往 `Forgejo Toolkit` 输出通道写**一行** `logger.error`：
  模型身份、这是该模型的第几次询问（`attempt n of 2 for the chosen model`）、回答的**完整字符数**，以及
  回答的**有界摘录**——最多 `AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH = 200` 个字符，再用 `JSON.stringify`
  转义成一行。退化回答往往只有几个字符（维护者见到的是 `comments[]` 与 `{"":}`），所以摘录通常就是整个
  回答；长回答被截断，**全文仍然只在 debug 的 dump 里**。**成功运行照旧一个字都不写回答正文**（这条规则
  与它的测试都保留：成功路径上的回答已经进入确认清单、会被人读到，也已经被写成草稿）。
  ② 用户消息补上这句摘录在哪儿、以及怎么拿到更多：新命令
  `forgejoToolkit.aiPreReviewOpenDiagnostics`（标题「AI Pre-Review: Open Diagnostics」／
  「AI 预评审：打开诊断文件」）把 `<logUri>/ai-pre-review-diagnostics.log` 用
  `workspace.openTextDocument` + `showTextDocument` 在编辑器里打开；文件还不存在时（`forgejoToolkit.debug`
  从未打开过）**明说**"它只在 `forgejoToolkit.debug` 打开时写入，请打开该设置并跑一次预评审或探测"，
  而不是报错或什么都不开。该命令**不受功能开关把关**（读一个本地诊断文件不发任何内容），贡献方式与选模型
  的命令同形：只加 `contributes.commands` 一条，没有带 `when` 的菜单项。失败消息里那句提示集中写在
  `diagnosticsActionHint()` 里（命令 id 只能写进文案，这个 API 版本的 `MessageItem` 挂不上命令）。
  ③ debug 下的完整请求 + 完整回答抓取**一字不改**：每节标签、`answer chars: N`、自述头与"本文件含提示词与
  模型原始输出"那句话都保留，§9.6 的探测命令也不受影响。
  ④ 前几条修正里"**不写回答**""输出通道里永远没有回答正文"这类话被本条取代：原文就地保留（删除线，
  见 §6.4、§7.2、§9.6），取而代之的规则是 **never on success; a bounded excerpt (≤200 characters,
  escaped) on a contract violation, because "not JSON" alone is undiagnosable; the full text stays in
  the debug-only diagnostics file.**（**2026-10-01 第八次修正：`never on success` 只在 debug 关闭时
  逐字成立——debug 打开时另有碎片清单与一行小结写进同一个输出通道，理由与测试见本文开头那条修正。**）
- 交付后的修正（2026-10-01，**第六次排查：回答变成"我们自己的请求被去掉标点后的乱序回声"；先证明不是我们
  累积错了，再给真机一条能把"模型不行"与"通道吃标点"分开的判据**）。
  维护者新看到的失败既不是散文也不是拒答，而是**把我们自己的请求回声回来**：schema 里的
  `path` / `line` / `side` / `extraLines` 还在，引号与逗号没了，键名与值的位置错乱，末尾是提示词措辞的
  乱序碎片（真实摘录形如 `comments{"":"/utilsre.tsline3sideheadextra":,…`）。于是有三个假设必须分开：
  **A 模型跟不上指令**（弱 / flash 模型回声提示词）、**B 供应商或流在传输中弄坏文本**（标点被吃）、
  **C 我们自己的累积丢帧或乱序**（若成立就是本扩展的真实缺陷）。
  ① **C 用测试排除，与任何模型无关。** `sendRequest` 的 `response.text` 全文只有两处消费，都是
  `for await (const chunk of response.text) { text += chunk; }`（运行路径 `requestPreReviewComments()`、
  探测路径 `sendProbeRequest()`）。`src/__tests__/aiPreReview.test.ts` 新增一组用例，用**本仓库自己的
  假流**（`createModel({ fragments })`）把一段带逗号、转义引号、字面反斜杠、`\uXXXX` 转义、em dash 与
  星际字符（`𝄞`，UTF-16 代理对）的 JSON 拆成 8 个碎片发出，碎片边界**故意落在多字节字符中间、转义序列
  中间、JSON 字符串边界上**，再断言累积结果与字面量**逐码元相等**（debug dump 的原始回答块及其字符数），
  另一条断言同一段碎片化回答在契约失败的**有界摘录**里也逐字出现。**测试通过 ⇒ 假设 C 不成立**：累积
  没有丢、没有乱序、没有重新编码，真正丢掉标点的是上游。这组用例同时是回归闸门——以后任何"顺手 decode
  一下 / 按行拼一下 / 用 `TextDecoder` 分片解"的改动都会让它变红。
  ② **A 与 B 由真机上的探测判据分开**（`forgejoToolkit.aiPreReviewProbeChatModels`，仍然只在
  `forgejoToolkit.debug` **且** `forgejoToolkit.aiPreReview` 都打开时发请求，仍然不读任何 Pull Request、
  不含任何仓库内容）：在原有三种 `Reply with exactly {} and nothing else.` 形态之外**新增第四种「回声」形态**
  （`AI_PRE_REVIEW_PROBE_ECHO_PROMPT = 'Reply with exactly {"a":"b,c\"d\\e","f":[1,2]} and nothing else.'`，
  期望答案 `AI_PRE_REVIEW_PROBE_ECHO_ANSWER = '{"a":"b,c\"d\\e","f":[1,2]}'`，本身是合法 JSON）。它**不带**
  我们的指令块，因为它要量的是"这段字能不能原样走一个来回"，不是我们的措辞；三种 `{}` 形态看不出这件事
  ——`{}` 本来就没有标点可丢。dump 里每个模型的这一块给出：请求原文、头部一行
  `a faithful answer is exactly …`、**逐字原始回答**，以及一行**布尔判词**
  `answered the echo exactly as asked: true|false`。**结论程序（怎么读）**：回声 `true` ⇒ 通道忠实、标点没丢
  ⇒ 真机上的乱码出在**模型侧**（假设 A）⇒ **推荐换一个更强的模型**（`forgejoToolkit.aiPreReviewChooseModel`
  或设置页里那一行），**契约不动、代码不动**，失败消息与有界摘录继续回答"哪个模型、第几次、多少字符"；
  回声 `false`，且原始回答是期望串**被吃掉标点后的近似拷贝** ⇒ **传输或供应商在弄坏文本**（假设 B）⇒ 按
  **供应商限制**记录（`KNOWN_ISSUES.md` / `KNOWN_ISSUES.zh.md`，点名是哪个 `vendor`），**契约不动**，下一步是
  换模型或换供应商，而不是改我们的提示词或校验；回声 `false`，且原始回答是**别的东西**（散文、`{}`、拒答、
  评论 JSON）⇒ 模型没有按指令回声，这与 A 同类（指令遵循失败），只是连"照抄一行"都做不到，若同时控制形态能答
  `{}`，就更能确定问题在**模型**而非通道；回声 `true` 而真实运行仍然乱码 ⇒ 回到 ①，下一步是拿
  `ai-pre-review-diagnostics.log` 里**同一个模型**的运行块与探测块对照（两者的请求形态不同，那就是下一个要分离
  的变量）。
  ③ **用户可见面一个字都没改**：探测仍然 debug-only 且不含任何仓库信息，三种 `{}` 形态与它们的判词、dump 的
  节格式与文件名、`forgejoToolkit.debug` / `forgejoToolkit.aiPreReview` 两道闸门、契约失败的有界摘录规则
  （≤200 字符、成功一个字都不写）全部不变。新增的只是一条**诊断形状**与它的布尔判词，所以
  `.changeset/ai-pre-review.md` 与两份 `CHANGELOG` 都**不动**：发布说明只写用户能看见的东西，一个 debug
  命令多问一句属于工程诊断，不写进发布说明。
- 交付后的修正（2026-10-01，**debug 下把回答的"碎片边界"写进输出通道——`vscode.lm` 到底回了什么，
  从此不必调试扩展宿主也能看见**）。B 支结论把"谁弄丢了标点"钉在了提供者那条路径上，可维护者手上
  只有**拼接后的回答**（dump 里逐字、失败行里有界），而**碎片边界本身**没有任何地方记下来——那恰恰是
  "提供者的碎片本来就是坏的"与"我们的累积把它弄坏了"之间唯一的分界，后者已被逐码元测试排除
  （上一节的 ①），于是这里的期望是前者，本条的用处是**让它可观测**，不是再定性一次。
  ① **每个碎片一行**：两条流循环（运行路径 `requestPreReviewComments()`、探测路径 `sendProbeRequest()`）
  现在把碎片**留在一只数组里**再交给 `logAnswerFragments()`，每个碎片写一行
  `AI pre-review: answer fragment 3 of 8 in the stream: length=12, text="…"`——序号、**该碎片的字符数**、
  以及它的文本按失败摘录那套 `JSON.stringify` 转义成一行。文本上限就是
  `AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH`（200），走的是同一个 `aiPreReviewAnswerExcerpt()`，**没有第二份
  截断逻辑**；被截断时该行追加 `, cut from N characters`，因为把截断过的碎片当成短碎片读，正好会把这条
  行想展示的边界读错。**孤立代理项按 `\ud834` 转义而不是原样打印**：把一个星际字符从中间切开时，
  原样打印会把它重新拼成一个字符，边界就看不见了。
  ② **一段流一行小结**：碎片全部写完后再写
  `AI pre-review: answer stream summary: 8 fragment(s), 62 character(s), excerpt="…"`——碎片总数、
  字符总数、以及**拼接结果的**有界转义开头（同样复用上面那个 helper），所以读的人在碎片清单旁边就能看到
  拼接后的样子，不必自己心算。
  ③ **两条路都写，成功失败都写。** 碎片清单描述的是**传输**，不是裁决：一次回答无论后来解析成功还是
  契约失败，边界都是同一件事，而 dump 里的拼接也照旧由 `diagnostics.attempt()` 写（debug 打开时它本来
  就含完整回答），所以碎片在 debug 下落在同一个文件旁边的输出通道里是**一致的**，不是新增的泄露面。
  **被取消或中途失败的流不写**：运行路径的循环在每个 chunk 之前查一次 token，取消就直接返回；提供者
  自己中断则 `for await` 抛错——两条都走不到写行的那一步，半读的流没有诚实的总数可报。这条不变式由
  "写行放在整段 `for await` 读完、且循环内那道 token 检查之后"保证，测试同时钉住取消与提供者中断两种情形。
  ④ **严格由 debug 把关，且没有任何新设置。** `logAnswerFragments()` 自己先查
  `logger.isDebugEnabled()`（与 `Logger.debug` 同一道闸门与同一个既有设置 `forgejoToolkit.debug`），
  为假时**一行都不交给 logger**；为真时经 `logger.debug` 写输出通道。**消息、toast、通知一个字都不加**：
  输出通道是这些行唯一的落点。debug 关闭时行为与今天**逐字节相同**。
  ⑤ **只写回来的，不写发出去的。** 提示词、简报、diff 都不是这个函数的入参，所以碎片行与小结行在类型上
  就带不上它们；测试直接断言这一点（固定指令、`[changed-files]` 表、diff 正文、仓库名一个都不出现）。
  ⑥ **用户可见面一个字都没改**：不新增命令、不新增设置、不改失败文案、不改 dump 格式，也不改"成功时
  输出通道没有回答正文"这条规则的**默认（debug 关闭）形态**——它在 debug 打开时被本条的碎片行取代，
  而 debug 打开时完整回答本来就已经写进 dump；因此**不新增 changeset 条目**，两份 `CHANGELOG` 也不动：
  发布说明只写用户能看见的东西，一个 debug 级别的诊断行属于工程诊断。
  ⑦ **测什么**：`src/__tests__/aiPreReview.test.ts` 新增一组用例——序号/长度/转义文本逐行相等（一次流
  两次尝试的重复形状都钉住）、小结行的两个总数与有界开头、超长碎片带 `, cut from N characters` 且整段
  `b` 串不出现、含引号/反斜杠/换行/制表符的碎片转义成一行（没有任何一行含真换行或真制表符）、星际字符
  被从中间切开时两半按 `\ud834` / `\udd1e` 转义、碎片行与小结行不含提示词/简报/diff、debug 关闭时
  **一行都没有**且没有任何消息/警告/错误文案提到碎片、取消与提供者中断两种情形各一行都不写，以及
  探测路径同样产出（每种形态一段流、各一行小结）。
  既有的"成功运行不写任何回答正文"那条用例按诚实口径改成**"debug 关闭时"**（并把 `answer fragment` /
  `answer stream summary` / 固定指令的缺席一起断言），因为碎片行在 debug 打开时**就是**回答正文，
  这是本条有意改变的唯一一条断言。
- 交付后的修正（2026-10-01，**第九次排查的第一半：把 `response.stream` 的 `part` 也写进输出通道——
  "我们读错了通道"这个假设，现在可以用真机数据回答**）。上一条把碎片边界做成可观测的，本条的动机是
  维护者提出的下一个可能：`LanguageModelChatResponse.text` 按文档只是 `stream` 里**文本 part 的投影**
  （`@types/vscode` 1.102.0 原文 "This is equivalent to filtering everything except for text parts from a
  `LanguageModelChatResponse.stream`"），那么**一个 tool-call part、或者一个 `unknown`/数据 part，可能
  带着未被弄坏的结构化输入**——如果是，那就是"改用工具通道"这种**真修**，而不是变通。于是两个流循环在
  碎片清单之后**再读一遍 `stream`**（`logResponseStreamParts`）：
  ① **每个 part 一行**：序号、**运行时类名**、长度与内容。文本 part 写文本（同一个 200 字符上限与
  `, cut from N characters`），tool-call part 写**工具名 + 整段 JSON 化的 input**（不截断：它是这次诊断
  要找的那个结构化载荷，截断正好会盖住要找的东西），其余一律写成
  `kind=unknown (<类名>, typeof=<类型>)` 加一段**有界检查**（`JSON.stringify` 的结果按同一个 200 上限
  截断，`JSON.stringify` 抛错时退到 `Object.keys`，连它都抛错时退到 `unreadable(<类型>)`——诊断本身
  绝不允许抛）。类名读的是 `constructor.name` 而不是 `instanceof`：跨 realm 的 part 会 `instanceof` 失败
  却仍然带着自己的类名，而"这是哪个类"正是这一行的全部信息量。
  ② **一段流一行小结**：按**到达顺序**统计每种 kind 的数量、文本 part 数、以及文本 part 拼起来的字符数
  ——因为 `text` 与 `stream` 是同一响应的两种投影，这一行把"我们解析的那个投影"与"我们能看见的 part"
  放在一行里可比。两边不一致时**另写一行**点名两个字符数；`stream` 与 `text` 若是**同一个被抽干的
  游标**（有的实现就是这样），小结会诚实地写 `0 part(s)` 并说 stream 没能提供 part。
  ③ **不改变解析结果**：答案仍然**只**由 `text` 累积。part 那一遍跑在答案已经拿到之后，只读 `stream`，
  所以它无法影响解析；即使读 part 抛错（提供者中途中断、`next()` 抛错），也只写一行小结说明提前结束，
  绝不把成功改成失败，也绝不把失败改成成功。取消与半读的流照上一条的规矩：一行都不写。
  ④ **两道闸门不变**：`logger.isDebugEnabled()` 先查，仍然只有 `forgejoToolkit.debug` 这一个开关、
  没有新设置、只写输出通道、消息/toast/通知一个字都不加；提示词、简报、diff 不是它的入参。
  ⑤ **测什么**：`src/__tests__/aiPreReview.test.ts` 新增 "the debug-only parts log of a response stream"
  一组——文本 part 的 kind/长度/文本逐字相等、tool-call part 写工具名与 JSON input、`unknown` part 只做
  有界检查且不抛（含一个"连字符串化都拒绝"的对象）、带类名的 `unknown` 报出类名、原始值是字符串时
  只报 `typeof`、超长检查按 200 上限截断并带 `, cut from N characters`、含引号/反斜杠/换行/制表符的
  part 转义成一行（没有任何一行含真换行或真制表符）、part 行与小结都不含提示词/简报/diff、debug 关闭时
  **一行都没有**且没有任何用户可见文案提到它、小结按 kind 计数与文本字符数相符、以及**答案为
  `{"comments":[]}` 的运行在 part 被检查之后仍然解析成它**（"解析结果不变"这条保证由用例钉住）。
  另外给假模型加了 `parts` 与 `sharedStreamCursor` 两个形状：前者一个响应两种投影、**每次读取都新建
  iterable**，后者两种投影共用一条游标，正是"读第二遍只能看到空"的那种实现。
- 排查结论（2026-10-01，**第九次排查的真机数据：part 通道里没有 tool-call，`text` 也不是"文本 part 的
  投影"——它是提供者的 token 流**）。这一段只记录**测到了什么**；上面那条是产物，结论由本条给出。
  判据：dev host（`Run Extension` 的非生产构建，扩展宿主在 23:29:07 的产物之后启动）里
  `forgejoToolkit.debug` 与 `forgejoToolkit.aiPreReview` 都打开、
  `forgejoToolkit.aiPreReviewModel = deepseek/deepseek-flash`，跑
  `forgejoToolkit.aiPreReviewProbeChatModels`（4 种形态各一次，只问这一个模型）。
  ① **part 的种类，逐字**：4 次调用一共落下 **8 组** part 行（同一次响应会分几组落下，以时间戳分组：
  20 / 68+3 / 5+61 / 79+114+115+1 条），运行时类名只出现三个——`os`（token 级）、`ln`（文本 part 级）、
  `r`（数据 part 级），全部落进 `unknown` 分支。**没有任何一个 `LanguageModelToolCallPart`**，因此
  "改用工具通道"没有可用的载荷；`unknown` 里也没有工具名或工具输入，只有下面第 ③ 条那种数据 part。
  ② **类名是 RPC 混淆过的**：这些 part 不是 `LanguageModelTextPart` 的实例，而是**跨 RPC 序列化后的
  普通对象**，形状固定为 `{"$mid":<n>,"value":…}`（`$mid` 是 VS Code RPC 信封的类型编号）。这解释
  了两件事：为什么 `stream` 里一个 `kind=text` 都没有（类名对不上），以及为什么 `text` 却仍然能产出
  字符串——**`text` 与 `stream` 在这一版编辑器/提供者上并不是同一个东西**，文档那句"等价于过滤出
  文本 part"在这里不成立。
  ③ **四次 total 只来自同一族的两种 part**：每次响应的 part 清单就是
  `N × $mid=22`（每条带 `value`）+ `N × $mid=21`（每条带 `value`）+ `2 × $mid=24`（不带 `value`，
  一条 `mimeType=usage`、一条 `mimeType=stateful_marker`）。四次的小结逐字是
  `20 part(s) (17 unknown (os, typeof=object), 1 unknown (ln, typeof=object), 2 unknown (r, typeof=object))`、
  `71 part(s) (68 unknown (os, typeof=object), 1 unknown (ln, typeof=object), 2 unknown (r, typeof=object))`、
  `66 part(s) (63 unknown (os, typeof=object), 1 unknown (ln, typeof=object), 2 unknown (r, typeof=object))`、
  `309 part(s) (291 unknown (os, typeof=object), 16 unknown (ln, typeof=object), 2 unknown (r, typeof=object))`。
  四次的 `0 text part(s) carrying 0 character(s)` 完全一样；另有**三行**不一致提示——
  `the text parts carry 0 character(s) while the accumulated answer has 2`（两次）与
  `… while the accumulated answer has 12`（一次），而**第二次调用没有这一行**：那一次 `text` 也是
  0 字符（`answer stream summary: 0 fragment(s), 0 character(s)`），两种投影**同时为空**。
  所以这四次的 `text` 字符数是 2 / 0 / 2 / 12，答案里的字符数与 part 里的文本 part 数**从来不相符**。
  ④ **`$mid=22` 是模型的整条推理文本**：把标点回声那一次（`309 part(s)`）的 291 条 `$mid=22` 的
  `value` 按到达顺序拼起来是推理内容本身——开头 `We need answer exactly specified JSON string and
nothing else. Need ensure escaping? User: Reply with exactly {\"a\":\"b,c\\\"d\\\\e\",\"f\":[1,2]}
and nothing else. …`，全长 **1055 字符**；数据 part 里那条 `usage` 解出来是
  `{"prompt_tokens":53,"completion_tokens":308,"total_tokens":361,…}`，与这条流的长度相符。
  ⑤ **`text` 投影就是这条 token 流**：同一次调用里 `aiPre-review: answer fragment` 行是 8 个碎片、
  共 12 字符 `{"":"`, `":\"`, `,c`, `d`, `e`, `f`, `1`, `2`，拼接成 `{"":",cdef12`——**与已知失败
  逐字节同形**；而 `$mid=22` 那条流里逐 token 打印出来的是推理内容（`We`, ` need`, ` answer`, …,
  末尾才轮到真正答案的 token）。**也就是说：`text` 交出来的不是最终答案，是模型的推理 token**，
  真正的答案被留在了另一股 part 上（哪一跳把 token 变成那 12 个字符，逐条 part 分不出来——可能是
  `text` 只取了其中一部分 token，也可能是提供者在投影那一跳丢了字符；两种情形下**答案都在
  `$mid=21` 里完好**，而这正是本条要回答的问题）。
  ⑥ **`$mid=21` 那 16 条才是真正的文本 part，而且拼起来是完整的**：16 个 `value` 按到达顺序拼接
  得到 **27 字符**、与探测自己声明的标准答案**逐字节相等**的 `{"a":"b,c\"d\\e","f":[1,2]}`，
  `ConvertFrom-Json` 解得开、字段是 `a` 与 `f`；同一次调用的 `usage` 与 `stateful_marker` 也都解得开。
  **而且它不是碎片化的巧合**：16 条 `$mid=21` 与 291 条 `$mid=22` 是同一响应里并行的两股——
  前者是最终文本 part，后者是推理 token。
  ⑦ **因此"读错通道"这个问题的答案是肯定的，而且方向变了**：不是"tool-call 里有完整的 input"，
  而是 **`stream` 里的文本 part（`$mid=21`）带着未被弄坏的完整答案，`text` 却把它换成了推理 token 流**
  ——这正是维护者看到的"回答变成被去掉标点、乱序的回声"的机制：文本投影丢了真正的答案，留下的是
  模型自言自语里恰好出现过的那些字符。**真修的方向是让解析改用 `stream` 里的文本 part（按到达顺序
  拼接），把 `text` 留在"没有文本 part 时"的兜底**；本条**没有**改解析，只把 data 记下来，因为改解析
  会动到契约/重试/锚点校验这一整条已经验证过的路径，需要单独一次改动。
  ⑧ **对失败的界定也跟着修正**：上一条结论把"谁弄丢了标点"钉在提供者那条共享路径上（四个模型逐字节
  相同），现在有了机制层面的解释——**"丢失"其实是取错了分歧中的一股：答案在文本 part 里完好，而
  `text` 给出的是推理 token**。所以两份 `KNOWN_ISSUES` 里那条"上游提供者限制、扩展侧无可修"的措辞
  需要按本条重写，并指向上面的真修方向；本条**不**改代码，也不新增 changeset 条目（用户可见行为
  一个字都没变）。
  ⑨ **测什么**：`src/__tests__/aiPreReview.test.ts` 的 "the debug-only parts log of a response stream"
  一组（见上一条的 ⑤），以及本节表格里新增的那一行。
- 交付后的修正（2026-10-01，**第十次：按第九次排查的真机数据改解析——回答改从响应的候选通道里取，
  由契约仲裁哪一股胜出；`text` 降为兜底**）。上一条把机制测清楚并把真修方向写了下来，本条把它实现。
  ① **机制（不再重新推导，只引用第九次排查的字节）**：`text` 在这版编辑器/提供者上**不是**
  "`stream` 里文本 part 的投影"：它交出的是 `$mid=22` 的**推理 token 流**（同一次调用里拼出
  `{"":",cdef12`，与已知失败逐字节同形），而真正的答案完好在 `$mid=21` 的**文本 part** 里
  （16 条拼起来 27 字符、逐字节等于探测自己声明的标准答案）。**没有**任何 `LanguageModelToolCallPart`
  到来，所以"改用工具通道"不是出路。响应的 part 是**跨 RPC 序列化的普通对象**，形状固定为
  `{"$mid":<n>,"value":…}`。
  ② **分类规则（两条，`$mid` 不是唯一依据）**：`classifyResponsePart` 先做**类判定**——`instanceof
LanguageModelTextPart` 归文本通道，`instanceof LanguageModelThinkingPart`（编辑器声明了才取，
  取不到就 `typeof` 检查后跳过）归推理通道，`instanceof LanguageModelToolCallPart` 归数据；类判定
  全部落空时再做**形状判定**：own `$mid` 是数字、且 `value`（若有）是字符串的信封才算 RPC part，
  然后由两个静态集合决定通道（`$mid=21` 文本、`$mid=22` 推理），`$mid=24`（`usage` /
  `stateful_marker`，没有 `value`）与**任何本版不认识的编号**一律算数据 part——不认识就**不猜**，
  答案退回 `text` 投影。所以"哪些 part 算文本"既能被真机数据钉住，又不会把编辑器内部编号当成规则；
  编号只用来解释真机看到的那两股，换一版编辑器时未知编号只会退化成兜底，不会把推理塞进答案。
  ③ **两股候选流 + 兜底**：`readResponseCandidates` 把一次响应收成按优先级排列的候选——
  `text`（文本 part）、`reasoning`（推理 part），**只有**两股都没带文本时才读 `response.text` 投影并把它
  作为 `text-projection` 候选（它同样要过契约，不被信任）。
  ④ **契约仲裁**：`pickResponseCandidate` 按优先级逐个用**调用方自己的**严格校验打分——探测是形态自己
  声明的精确字面量，运行是 JSON 契约（`parseAiPreReviewResponse`，schema 与锚点校验仍是后面的既有路径）。
  第一个通过的就是答案；文本候选过了就用文本，没过才用推理，最后才是 `text` 投影。**两股绝不拼接、绝不
  修补、绝不换模型**；一个都没过时按既有方式失败：报出失败模型、尝试次数与**实际检查过的那一股**的有界
  摘录，创建的东西是零（重试仍只针对契约失败、仍只问用户选的那一个模型、上限仍是 2 次）。
  ⑤ **单消费者规则（本次的要害）**：`stream` 与 `text` 是同一响应的两个投影，编辑器可能给两个独立
  iterator、也可能给一条被先读者抽干的游标——所以**只消费一次**：`collectResponseStreamParts` 读 `stream`
  一遍并顺手分类，`text` **仅在没有任何候选通道带文本时**才读（`readTextProjection`，一次读进局部变量），
  在候选通道已经给出答案时 `response.text` **连属性都不读**。判据由测试钉住：假模型在第二次读投影（以及
  读 `text` 属性）时直接抛错，所以"读两遍"会变成显式的测试失败而不是静默换文本。
  ⑥ **可观测性**：胜出的通道与原因由 `responseCandidateSelectionLogLine` 在 **debug** 级别写入输出通道
  （`answer stream: using the text candidate (…)` / `… the reasoning candidate (…) was used because the text
candidate did not satisfy the contract` / `no candidate satisfied the contract (preferred …)`）；探测的判词也
  点名它判的是哪一股（`… (…; from the text candidate)`）。诊断 dump 的每次调用**两股候选分别标注**并原样
  打印（`candidate N of M (text parts|reasoning parts|the text projection (fallback))` + 字符数 + marker），
  这让"两股不一致"这件事本身成为文件里的证据。debug 关闭时，part 行、碎片行、小结行与选择行**一行都不写**
  （选择行原先漏了 `isDebugEnabled()` 闸门，本次一并补上）。
  ⑦ **用户可见变化**：预评审在这类提供者上**从"必然失败"变成"能成功"**，所以本次新增 changeset 条目，
  两份 `CHANGELOG` 也加一条；两份 `KNOWN_ISSUES` 里那条"提供者删字符"按本条重写为"答案在 stream part 里、
  `text` 给的是推理流；扩展读 part 并回落 `text`"。`TODO.md` 里"让解析改用 `stream` 里的文本 part"那条
  P2 条目随之删除（已完成），该节只剩「AI 预评审（draft-only）剩余决定」那三条刻意保留的变体。
  ⑧ **测什么**（`src/__tests__/aiPreReview.test.ts`）：新增 "the candidate streams of a response and the
  contract that arbitrates them" 一组——文本 part 答案被采用且 `text` getter 一次都没被读；真机数据
  （`$mid=21` 两条拼成 27 字符字面量 + `$mid=22` 的 `{"":",cdef12`）下 echo 判词为 `true` 且它点名文本候选；
  文本候选过不了契约时才用推理候选（并有 debug 原因行）；探测同样按契约仲裁并在判词里点名通道；两股都不过时
  按既有失败路径走（2 次调用、零创建、摘录就是被检查那一股）；没有任何候选 part 时回落 `text` 投影；本版不
  认识的 `$mid` 不算候选且回落到 `text`；dump 里两股候选都带标注；debug 关闭时上述行一行都没有；外加"响应只被
  消费一次"（第二次读投影即失败）。既有保证（开关关闭不发、探测双闸门、只问被点名的那一个模型、重试上限 2、
  失败创建零、诊断 dump 记录发了什么与回了什么）由既有用例继续钉住。
- 排查结论（2026-10-01，**第六次排查的判据跑完，取的是其中的 B 支**：**传输/提供者在弄坏文本**，
  是**上游提供者限制**，扩展侧无可修之处）。这条只记录**测量到了什么、据此选了什么**；上面那条的三种
  假设与结论程序原文不动。
  ① **决定性的字节**：`forgejoToolkit.debug` 打开后，探测的第四种「标点回声」形态要求照抄 27 字符的
  字面量 `{"a":"b,c\"d\\e","f":[1,2]}`（`AI_PRE_REVIEW_PROBE_ECHO_ANSWER`），得到的回答是
  `{"":",cdef12`——**12 个字符，两次独立运行逐字节相同**。存活的 12 个字符**全部**出现在该字面量里、
  顺序不变，而 `"`、`[`、`]`、`}`、两个反斜杠、`a` 与 `b` 一个都没回来；判词因此是
  `answered the echo exactly as asked: false`。按上面那条的结论程序，原始回答是期望串被吃掉标点后的
  近似拷贝 ⇒ **B**，而不是"模型跟不上指令"。
  ② **同一条结论的第二个独立证据**：更早那次「问遍所有模型」的探测里，**某个提供者的全部四个模型返回了
  逐字节相同的退化字节**，而其它每个提供者的模型各自返回**自己的**退化字节（彼此不同，同样在两次运行
  之间逐字节相同）。相互独立的模型不可能产生同一种破坏，所以破坏发生在**那个提供者共享的那条路径**上，
  而不是任何一个模型里——单看一次回答看不出这一点，四个模型同一串字节才把它钉住。
  ③ **被排除的两侧**：我们发出去的请求文本（debug dump 逐字打印发出去的每条消息、转义完好），以及
  模型的指令遵循能力（同一个模型对平凡的 `{}` 指令答对）。**剩下的是哪一跳删的字符——VS Code 的
  language model API、提供者扩展、还是该提供者的远端端点——用这些字节分不出来**，也不该在没有证据时
  猜一个；扩展里没有任何东西能改变这条路径。
  ④ **按 B 支，代码一个字都不改**：契约（JSON + schema）、校验器（锚点、丢弃计数）与提示词
  （`AI_PRE_REVIEW_*` 常量、一条 `User` 消息）全部保持原样，**没有**"更宽松的解析"、**没有**"换另一个模型再
  试一次"（跨模型轮换早已被维护者裁决否决，见本文开头那条）、**没有**在回答残缺时落任何草稿：运行照旧报出
  失败的模型、尝试次数与有界摘录，**创建的东西是零**。因此本次不新增 changeset 条目：用户可以看见的行为
  与上一条修正记录的完全一致（失败时说清是哪一步、什么都不写），变的只是**我们对原因的判定**。
  ⑤ **记录去向**：这条限制写进 `KNOWN_ISSUES.md` / `KNOWN_ISSUES.zh.md`（同名条目，两文各有），按 B 支的
  要求**只说到"提供者"这一层，不写任何地址、token 或主机**；给用户的自查路径是上面那条已有的三个命令
  （`forgejoToolkit.aiPreReviewProbeChatModels` → `forgejoToolkit.aiPreReviewOpenDiagnostics` → 读
  `echo: one user message, punctuation-sensitive` 的判词与旁边的原始回答）。下一步是**换一个提供者的
  模型**，不是改我们的提示词或校验。
- 验收记录（2026-10-01，**AI 预评审第一次走到多选确认清单**：清单本身的行为、平台自带的"全选"控件，
  以及这一跑验证了什么）。这一条只记录**测到了什么**；正文里被它纠正的两处（§2 第 2 条、§5 第 5 条）
  已就地标为删除线并写明修正，原文保留，便于核对此前承诺过什么。
  ① **清单本身按设计工作**：什么都没预选——多选 quick pick 自己的计数是「已选 0 项」，每个复选框都是关的，
  直到用户自己勾一个——扩展也没有提供任何"全选 / 接受全部"入口，它只把通过 §8 锚点校验的候选评论交给
  picker（`confirmCandidates` 只映射 `label` 与 `candidate`，刻意不设 `picked` 字段）。
  ② **但平台层有一个扩展管不了的一键全选控件**：VS Code 自己的多选 quick pick 会渲染一个 accessible name
  为「切换所有复选框」的复选框（英文 `Toggle all checkboxes`，字符串就在 VS Code 自己的 `nls.metadata.json`
  里），它和候选清单一起出现，扩展既不能移除也不能改名。所以本文此前"没有一键接受全部""不做一键全部接受"
  这两句话**字面上不成立**（扩展侧那一半仍然成立），准确口径是：**扩展不预选任何东西、也不添加接受全部
  入口；平台的多选控件自带"切换所有复选框"，我们移除不了**。§2 第 2 条与 §5 第 5 条已按此就地改正。
  **（2026-10-02 修正）**：确认这一步已经从 QuickPick 换成扩展自己的面板，那个平台控件随之不再出现，
  所以这句话只在"当时用的是 QuickPick"这一前提下有效；现状见本文开头的 2026-10-02 那条。
  ③ **一条验证笔记（不是缺陷）**：「锚点校验失败的意见永远到不了清单」这条性质这一次**成立、但没有被实际
  走到**——模型只提了两条意见、两条都过了校验，所以没有任何候选被丢弃；它目前仍只由测试保证，还没有观察到
  过真实的丢弃。两份 `KNOWN_ISSUES` 的同名条目已补上同一口径与这条笔记。
  ④ **这一跑另外验证的**：探测再次回答 `true`；这次运行的答案来自**文本候选**（不是推理 part，也不是
  `text` 投影）；在清单上确认后恰好创建了**一条 PENDING 评审**（带它的评论），并且**没有提交任何东西**——
  §10 阶段 4 的"落草稿"这一半由此第一次在真机上被走到，此前各条修正里"确认清单与落草稿那一半仍未验证"
  的注记到此为止（原文保留在原处）。
- 交付后的修正（2026-10-02，**维护者裁决：布尔开关换成"提示词范围"，第一次运行只问一次**）。
  ① **被推翻的**：`forgejoToolkit.aiPreReviewIncludeDiff`（布尔，默认 `false`）是一个陷阱——关着的时候
  功能看起来跑通了，实际上模型只拿到 PR 标题/分支、变更文件路径与增删行数、已有意见的元数据，
  **一行代码都没有**，于是它只能就"改动的形状与规模"说话。这个开关把"要不要发代码"压成一个是非题，
  而真正的答案有量级之分（不读代码 / 只读变更行 / 读整份 diff / 连变更文件的正文一起读）。
  ② **新的设置与取值**：`forgejoToolkit.aiPreReviewPromptScope`（字符串，`enum` + `enumDescriptions`，
  两种 nls 都有），默认 `ask`，五个取值 `ask` / `metadata-only` / `changed-lines-only` / `full-diff` /
  `changed-files`。`ask` 的语义是"你还没选"，**它自己不是一个范围**：读到它时什么都不发。旧键从
  manifest 里删除（残留取值会被 VS Code 标为未知设置，见两份 `KNOWN_ISSUES`）。
  ③ **第一次运行问一次（模态框，fail-closed）**：读到 `ask` 时，运行在模型已经确定（因此能点名
  **提供者的 vendor**，与模型选择列表同一个事实）之后、在**任何 HTTP 请求与任何模型调用之前**弹一个
  `vscode.window.showInformationMessage(..., { modal: true }, ...)`，写明内容会发给谁、每个答案分别会
  发出什么（`metadata-only` 明说"模型读不到任何一行变更代码、只能对文件层面的事发表意见"），以及
  "回答之前不请求、不发送、不写入"。按钮是：**发送变更文件的完整内容（推荐）** /
  **只发送变更的行** / **只发送元数据** / **取消——什么都不发送**；关闭控件与 Esc 等价于取消。
  取消即整次运行取消：零 HTTP 请求、零模型调用、零写入（设置保持 `ask`），并给出一句说明。
  ④ **回答写进设置**：与模型选择完全相同的写法（`ConfigurationTarget.Global` 的普通配置更新），
  所以它在设置界面里看得见、能改、可审计；写失败只影响"答案记在哪里"，不影响本次运行用什么范围。
  只有**已选定**的范围会被写入——把 `ask` 写回去等于把答案变回问题。于是"问一次"是**设置**层面的
  事实：只有在用户把它清回 `ask` 时才会再问。
  ⑤ **旧值怎么处理**：旧布尔**只读一次**，而且只作为模态框里的**建议**——`true` → 建议 `full-diff`
  （那正是它当年的语义：连上下文一起发整份 diff），`false` → 建议 `metadata-only`（当年关闭时就是
  一行代码都不发）。它**不算已选定**：语义变了（`changed-lines-only` 与 `changed-files` 当年都不存在），
  所以它既不跳过那次提问，也不会被写回设置；非布尔的残留取值连建议都不给。
  （**这一条已作废**：那条建议连同读旧键的代码已于 2026-10-02 删除——功能从未发布，没有迁移要搬运，
  见本文开头最后一条修正。）
  ⑥ **四个已选定范围各自发出什么字节**：`metadata-only` = 简报（文件表 + 已有意见的元数据），
  没有 `[diff]`、没有 `[changed-file-contents]`；`changed-lines-only` = 简报 + `[diff]`，每个文件只保留
  `diff --git` / `index` / `---` / `+++` / `@@` 这些头与 `+`/`-` 行，**丢掉以空格开头的上下文行**
  （hunk 头必须留着：它是提示词里唯一说明某个 `+`/`-` 行是文件第几行的东西，丢了这个范围就没法给出
  合法的文件行号），并在 `[diff]` 下写明这是节选；`full-diff` = 简报 + 原样的整份 diff，与开关时代
  完全一致（`PR_REVIEW_DIFF_BUDGET`、`PR_REVIEW_MAX_DIFF_FILES`，超出时从末尾丢整个文件）；
  `changed-files` = `full-diff` 的全部**加上** `[changed-file-contents]`：按简报顺序、以 PR 的 head sha
  为 `ref` 逐个读取**该 PR 改动过的**文件正文（`getFileContentResult`，只取 `kind === 'file'`），受
  `AI_PRE_REVIEW_MAX_CONTENT_FILES`（20）与 `AI_PRE_REVIEW_FILE_CONTENT_BUDGET`（= `PR_REVIEW_DIFF_BUDGET`）
  约束，超出时**从末尾丢整个文件**并在提示词里写明 `truncatedBy`；唯一例外是"单个文件就超过整个预算"，
  这时把它截断保留（否则这个范围会静默退化成 `changed-lines-only`）并说明只显示了开头。
  head 在别的仓库（fork）或服务端没给 head sha 时**一个文件正文都不发**并写明原因——读默认分支会发出
  与本次评审无关的代码。四种范围都**仍然抓取 diff**（锚点校验靠它的行表），都**不发访问令牌、不发
  URL / 主机名、不发已有评论的正文**，`changed-files` 也**只读该 PR 变更过的文件**，不读仓库里其他文件。
  ⑦ **推荐项与措辞**：`changed-files` 是推荐项（排在最前，标签里写着 recommended），因为只看 hunk 内的
  几行撑不起真正的评审（hunk 之外的错误处理、同文件里的调用方与约定都看不到）；它的文案也如实说明
  "变更文件的正文会离开本机"，这是所有范围里出网内容最多的一个。`full-diff` 不进按钮：想要旧行为的
  人在模态框正文里看到"把设置改成 `full-diff`"这条出路。
  ⑧ **同时修正的一处措辞**：`confirmCandidates` 的文档注释不再写成"没有一键接受全部"——扩展仍然
  **不预选任何东西、也不贡献任何接受全部入口**，但 VS Code 自己的多选控件会渲染 `Toggle all checkboxes`
  （见 2026-10-01 的验收记录第 ② 条），准确口径写进注释与两份 `KNOWN_ISSUES`。
  ⑨ **测什么**（`src/__tests__/aiPreReview.test.ts`、`src/__tests__/aiPreReviewBrief.test.ts`、
  `src/webview/__tests__/i18nParity.test.ts`）：`ask` + 接受 → 范围被写进设置（键、值、target 三者都断言）
  且本次运行用它继续；`ask` + 取消与显式取消按钮 → 零 HTTP 请求、零模型调用、零写入、一句明确中止；
  **模态框弹出那一刻**请求数与模型调用数都是 0（在回调里断言，而不是等运行结束再看）；
  四个已选定范围各自产出预期的提示词（`changed-lines-only` 含增删行与 hunk 头、不含上下文行；
  `metadata-only` 无 `[diff]` 且不读 `/contents/`；`full-diff` 含上下文行；`changed-files` 含文件正文、
  只读了变更文件、`ref` 就是 head sha）；纯函数层面钉住文件正文的三种截断（文件数上限、预算、
  首个文件过大）与"读不到的文件单独计数"；旧布尔 `true`/`false` 只影响建议、不跳过提问、不被写回；
  枚举与每条 `enumDescriptions` 在两种 nls 里都存在且都说明了出网内容；确认清单的
  "不预选、无自建全选入口"继续钉住。
  ⑩ **文档同步**：`FEATURES.md`（能力条目改成"第一次问一次、之后记住"，并新增一条"自己决定送什么出去"）、
  两份 `CHANGELOG`（字节一致）、这条改动自己的 changeset、两份 `KNOWN_ISSUES`（旧键残留）、
  `TODO.md`（下一档质量：相关文件检索与 agentic 读取，各自是独立的大功能，理由写在条目里）。
- 交付后的修正（2026-10-02，**维护者裁决：确认这一步从 QuickPick 换成专门的 webview 面板**）。
  ① **被推翻的**：确认清单原先是一个多选 QuickPick，每条的**正文塞在 label 里**，而 VS Code 会截断
  label，`description` 没设、也没有 `tooltip`——所以用户**读不到自己正要接受的那条评论**。2026-10-01 的
  验收运行正好撞上这一点（当时记的是"清单本身按设计工作"，那句话对"不预选、无自建全选入口"成立，
  对"能读正文"不成立）。QuickPick 被**移除**，不是保留成兜底。
  ② **载体**：`src/aiPreReviewPanel.ts` 的 `AiPreReviewPanel`，一个编辑器标签页里的 `WebviewPanel`
  （`vscode.ViewColumn.Beside`，标题 l10n 为 `AI pre-review: review the proposed comments` /
  「AI 预评审：审阅候选评论」），文档是第四个 webview surface（`webview/aiPreReview.html` +
  `src/entries/aiPreReview.ts` + `src/AiPreReviewPanel.vue`，见 `webview/vite.config.mts` 的 `SURFACES`
  与 `webview/src/__tests__/entryGraph.test.ts` 的同名断言）。payload 随文档注入
  `__FORGEJO_TOOLKIT_CONFIG__.aiPreReview`（与评论编辑器的 context 同一套），所以首屏不需要往返；
  `aiPreReviewPanelPayload` 保留给"换一份 payload"的场景。
  ③ **头部（QuickPick 给不了的透明性）**：PR 身份（`owner/repo#index` + 标题）、回答的**模型及其 vendor**
  （隐私那句话继续留在屏幕上）、**本次运行实际使用的提示词范围**、通过锚点校验的条数，以及**按原因分组**
  的丢弃数（每条 `label ×count`，label 取自既有 `describeDropReason`，所以面板与运行自己的提示不会
  对同一原因用两种说法）。
  ④ **每张卡片**：锚点（`path:line`，多行时 `path:line-end`，加 `(head|base)`）作为复选框自己的 label、
  **完整正文**（`pre-wrap` 换行、可选中复制）、一个复选框，以及一个「在 diff 里打开这一行」链接——
  它复用既有的 diff 打开机制（`src/webview/diffUri.ts` 的 `buildForgejoPrDiffUri`，`viewProvider` 的
  `_buildDiffUri` 现在也走它），按 base/head 两侧的 URI 调 `vscode.diff`，再把选区落在**锚点所属那一侧**
  的文档上（head 侧的行号在 base 文档里指的是另一行）。
  ⑤ **默认状态**：一条都不勾，而且扩展**不提供任何"全部接受"控件**——这不再是"平台控件我们移除不了"
  那种说法：`Toggle all checkboxes` 属于 VS Code 自己的多选 QuickPick，本面板不使用它，所以口径回到
  最朴素的那句：**在用户自己勾之前，什么都不会被创建**。创建按钮在没有勾选时禁用并显示
  `Create 0 draft comment(s)`。
  ⑥ **动作与保证**：~~勾中的卡片以**索引**回传（`aiPreReviewPanelCreate` + `indexes`），正文/路径/行号
  一律取自宿主自己的 payload 副本，所以被篡改的 webview 消息只能"选中已经给过它的卡片"，无法凭空造出
  一条评论；~~（**2026-10-02 起这句话只对锚点成立**：回复改带正文，见本文开头那条"正文可在创建前编辑"
  的修正——webview 从此可以提议**正文文本**，由宿主逐条重校验；而路径/行号/侧/正文以外的字段仍然
  一律取自宿主自己的 payload 副本，消息里出现的锚点字段一律忽略）写仍然走既有路径（只建 PENDING 评审、
  绝不 submit），写完后宿主把结果回帖给面板
  （`aiPreReviewPanelResult`：创建数 + 失败原因），面板用状态行与「打开该 Pull Request」按钮收尾
  （`revealPullRequestDetail`：先 `_revealView()` 再打开详情，因为没有 reveal 的消息会排进一个还没解析的
  视图里）。取消按钮、Esc、关闭标签页三者等价：`{kind:'cancel'}` → 零写入、一句既有取消提示；写出
  空选择也按取消处理（防御性，因为按钮本来就禁用）。已给的答案优先于随后的关闭事件。
  ⑦ **不变的**：只问用户选定的那一个模型、严格 JSON 契约与锚点校验、从响应候选通道取答案并以
  `text` 兜底、两道闸门、失败时零创建、只在 debug 下存在的诊断、同模型重试上限 2 次。
  ⑧ **测什么**：`src/__tests__/aiPreReviewPanel.test.ts`（面板的宿主半边：一次只开一个面板、答案只认
  已提供的索引~~并按 payload 顺序去重~~（**2026-10-02 起重复索引不再是"去重"而是整批拒绝**）并按 payload
  顺序排列、取消/关标签页/空选择都等于"什么都不写"、已给的答案不被关闭事件
  改写、结果回帖、按锚点所在侧打开 diff 并落在正确行、未提供的索引或缺少 sha 或路径不安全时什么都不开、
  打开草稿动作在有/无导航宿主时的行为、~~`selectedIndexes` 的纯函数边界~~（**2026-10-02 起这条纯函数是
  `selectPanelEntries`：见本文开头那条修正**））、
  `webview/src/__tests__/AiPreReviewPanel.test.ts`（组件：头部四类事实与分组丢弃、
  完整正文与锚点、截断提示、默认零勾选且没有自建全选控件、Create 的禁用与回传索引~~、取消、~~（**2026-10-02
  起还测预填/编辑/恢复原文/上限提示与"改过的正文随 Create 回传"**）、取消、
  打开 diff、结果行与"打开该 Pull Request"、替换 payload 会清空答案状态）、以及
  `src/__tests__/aiPreReview.test.ts` 里"运行交给面板什么"的三条（payload 的字段集合、分组丢弃、
  面板取消时零创建）。`src/__tests__/aiPreReview.test.ts` 的确认步骤现在 mock `../aiPreReviewPanel`，
  因为该套件测的是**运行**对答案做了什么；面板自身的行为在上面两个套件里。
  ⑨ **文档同步**：`FEATURES.md` 新增一条「确认面板」能力条目并改掉原来那句"逐条勾选"的表述；
  两份 `KNOWN_ISSUES` 里"读不到正文 / 平台自带全选控件"那条按本次改动重写（QuickPick 已经不在，
  所以那句话不再是"扩展移除不了平台控件"，而是"面板不使用那个控件"）；本记录与 `docs/design/README.md`
  的状态列；新的 changeset；两份 `CHANGELOG`（字节一致）。
  ⑩ **一条留给文档的约束**：在本次改动之前，"确认这一步让用户逐条读过正文"这句话**不成立**，
  所以此前任何文档都不许这么写；面板落地之后它成立。这条约束本身也记在这里，免得将来有人拿
  "清单是给人逐条读的"去追认旧实现。
- 交付后的修正（2026-10-02，**维护者裁决：候选评论的正文用用户当前的语言书写**——zh-cn 编辑器上的一次
  验收运行里，模型把每条 `body` 都写成了英文：指令块整块是英文，请求里也没有任何东西携带用户的界面
  语言）。
  ① **语言在提示词里明说，不交给模型去猜**：固定指令块新增一条规则，用目标语言**自己的写法**点名
  语言——`en` → `English`，`zh` → `简体中文`（对模型来说 `简体中文` 比 `Chinese` 明确得多）。同一句
  同时画出边界：**JSON 键与所有不是散文的取值（schema 的字段名、`"head"`/`"base"`、`path`、数字）
  保持原样**，只有 `body` 是散文、用该语言写。不明说就只能靠模型从上下文推断，而这份请求里没有别的
  线索——简报是文件路径、增删行数与代码。规则在提示词里**只出现一次**：它随指令块在**每次运行开始时
  构建一次**，同一份字节同时用于 token 计数、两次尝试与诊断 dump（这三处原本就是同一份字节，这次改的
  是它的来源不再是常量）。
  ② **用哪种语言，按扩展自己的口径解析**（`src/utils/resolveLocale.ts`，与各 webview 面同一处）：
  `forgejoToolkit.locale` 明确为 `en`/`zh` 时以它为准，否则跟随 VS Code 的显示语言
  （`vscode.env.language`，`vscode.l10n` 用的也是它）。**两者只在"显式设置 vs 编辑器语言"这一种情形
  下分歧**，这里选设置：展出这些正文的确认面板、以及设置页/引导/评论编辑器都用该设置渲染，一个把
  `forgejoToolkit.locale` 设成中文、VS Code 却是英文的用户读到的候选评论就是中文，正文应当与他正在
  读的语言一致；设置缺失或为空时两者没有分歧。**意外取值兜底为英文**（`resolveLocale` 的既有规则：
  非 `zh*` 一律读作 `en`；手改出的非法取值视为"未声明"，回落到显示语言），配置读取抛错同样按"未声明"
  处理——语言是措辞的属性，绝不让它把一次运行变成失败。
  ③ **改动落点**：`aiPreReviewBrief.ts` 新增 `buildAiPreReviewSystemPrompt(language)` 与
  `aiPreReviewBodyLanguageName`，`AI_PRE_REVIEW_SYSTEM_PROMPT` 保留为 `('en')` 的结果——探测命令的
  两种"指令"形态与钉住措辞的测试仍读它（探测量的是传输形态，措辞无关），而真实运行不再读这个常量；
  `aiPreReviewPromptText` / `buildAiPreReviewPromptMessages` 改为接收指令文本本身（传递同一份字节，
  而不是按语言重新推导）；`aiPreReviewSettings.ts` 新增 `aiPreReviewCommentBodyLanguage()`
  （`getConfiguration` 抛错 → 未声明 → 显示语言）；`aiPreReview.ts` 在范围问题回答之后、模型校验之前
  把语言与指令块**定一次**，校验、预算、两次尝试与 dump 全部用这一份。指令块因此从 781 字符长到 963
  （英文）/ 960（中文），`aiPreReviewBrief.test.ts` 的上限随之从 840 提到 1000 并记录实测值。
  ④ **测什么**：指令块按语言各构建一次、只点名一种语言、规则只出现一次、非散文那半句都在
  （`aiPreReviewBrief.test.ts`）；`forgejoToolkit.locale` 优先、未设置时跟随 `vscode.env.language`、
  意外取值与抛错都回落到显示语言或英文（同文件）；运行层面在 zh 编辑器（显式设置压过英文 VS Code）与
  en 编辑器上分别断言**真正发出的字节**点名中文/英文，并断言重试的两次尝试提示词**逐字节相同**、各自
  只含一条语言规则（`aiPreReview.test.ts`）；debug dump 里存的确实是这一份字节——zh 运行下中文那句在
  文件里、英文常量整串不在（同文件的 dump 一组）。
  ⑤ **文档同步**：`FEATURES.md` 的能力条目补上正文语言；这条改动自己的 changeset；两份 `CHANGELOG`
  （字节一致）。
- 交付后的修正（2026-10-02，**旧布尔开关的遗留桥被删除**）：`aiPreReviewIncludeDiff` 的 manifest 键在
  上面"布尔换成提示词范围"那条里就已删除，但代码仍会**读**那个键、把它当作首次运行模态框里的**建议**，
  读到时还写一行 info 日志；两份 `KNOWN_ISSUES`、`FEATURES.md`、changeset 与两份 `CHANGELOG` 也仍在
  描述这条建议。
  ① **为什么删**：**这个功能本身从未发布过**——AI 预评审的整个 changeset（`.changeset/ai-pre-review.md`
  及其后续各条）都还在 `## [Unreleased]` 里，`## [0.0.1] - 2026-09-26` 一节一个字都没提它，所以那个键
  从未随任何版本发出，也就没有"已发布的旧键"需要搬运：这条建议要服务的用户不存在。它实际做的只是让每
  次读范围设置都多读一个键、让模态框多出一段没人会看到的句子。等到它可能有用的时候也已经晚了——
  `changed-lines-only` 与 `changed-files` 在写它的时候都不存在，"旧值对应哪个新范围"本来就是猜。
  ② **删掉了什么**：`aiPreReviewSettings.ts` 的 `AI_PRE_REVIEW_LEGACY_INCLUDE_DIFF_SETTING`、内部键
  常量、`legacyAiPreReviewIncludeDiffValue()` 与 `suggestedScopeFromLegacyIncludeDiff()`；
  `aiPreReview.ts` 里读旧值那段、`legacyIncludeDiffSuggestion()`、模态框正文尾部的建议句、那行 info
  日志（`askAiPreReviewPromptScope` 不再收 `suggested` 参数）；两份 l10n bundle 里那两条建议文案；
  钉住这套行为的 5 个测试（运行侧 3 个、设置侧 2 个）。
  ③ **留下的不变**：`forgejoToolkit.aiPreReviewPromptScope` 的语义、五个取值、`ask` 的 fail-closed
  行为、模态框正文（现在只有原来那一段）、写入方式与"清回 `ask` 才会再问"全部原样。**残留的旧键只会
  被 VS Code 标为未知设置**——键本来就不在 manifest 里，扩展现在也不再读它——所以两份 `KNOWN_ISSUES`
  里那条同名条目是**删除**而不是改写：其中"扩展读取残留取值给出建议"这半句不再成立，剩下"未知设置"
  那半句是 VS Code 自己的行为，不需要本扩展再声明一条平台限制。
- 交付后的修正（2026-10-02，**维护者裁决：确认面板里的正文可以在落草稿之前编辑**——此前想改一句措辞
  只有一条路：**先创建**，再回到 diff 里改；而那等于先把用户并不同意的文字写进服务端）。
  ① **可编辑的只有正文**：每张卡片原先的只读 `<pre>` 换成一个多行输入框（`textarea`，预填模型原文，
  主题 token 着色、键盘可达、无自建品牌样式）。**不可编辑**：锚点（`path` / `line` / `extraLines` /
  `side`）与复选框的含义——锚点仍由 `aiPreReviewBrief.ts` 的校验器对着 diff 的行表逐条验过，而且
  **从不来自 webview**。
  ② **每张卡片的「撤销编辑」与编辑标记**：正文一旦与模型原文逐字节不同，卡片上就出现 `Edited` 标记
  与一个「恢复模型原文」动作（点一下即恢复，不用重打），所以"哪些是模型的字、哪些是我的字"始终分得清。
  ③ **长度上限就是既有常量**：输入框的 `maxlength` 与宿主的重校验都用 `PR_REVIEW_MAX_COMMENT_LENGTH`
  ——该常量从 `mcp/tools.ts` 移到 `@cpf23333-forgejo-toolkit/shared/limits`、由 `mcp/tools.ts` 原样再导出，
  因为 webview bundle 不能进宿主的模块图，而在面板里硬抄一个数字迟早在常量变化时漂移（界面以为合法、
  宿主却拒收）。到达上限时卡片**明说**已是上限（扩展不替用户截断），超过上限则卡片给出字符数与上限并
  **禁用创建**。
  ④ **顺手修掉的一处不一致**：`aiPreReviewBrief.ts` 原先把截断公告追加在 `slice(0, 1024)` **之后**，于是
  "被截断的正文"长达 1024 + 公告（实测 1064），比常量本身还长——面板一旦按同一常量封顶，这类卡片就会
  **不改一下就没法创建**。现在截断把公告算进上限（保留的前缀相应缩短），公告里的丢弃字符数仍然精确
  （`kept.length + announced === body.length`），`AI_PRE_REVIEW_MAX_BODY_LENGTH` 的语义因此是"最终正文
  （含公告）不超过该常量"。
  ⑤ **回传的消息形状（新契约）**：`aiPreReviewPanelCreate` 不再是 `indexes: number[]`，而是
  `entries: { index: number; body: string }[]`（共享类型 `AiPreReviewPanelSelectedBody`）。
  **安全属性由此明确改变**：webview 现在可以提议**正文文本**，所以宿主必须校验它；而锚点、路径、侧、
  sha **仍然只来自宿主自己的 payload**——消息里出现的这些字段一律**忽略**（条目只读 `index` 与 `body`）。
  ⑥ **宿主的逐条重校验（`src/aiPreReviewPanel.ts` 的 `selectPanelEntries`）**：`entries` 必须是数组，
  每一项的 `index` 必须是本面板**确实提供过**的卡片索引（同一张卡被点名两次也算失败，不做"取其一"），
  `body` 必须是**字符串**、**去空白后非空**、**不超过上限**（校验只看 trim，写入用原文——两端的空白
  是用户自己的字，不替他改）。**任何一条不过就整批判定失败**：什么都不写，面板保持提问状态，并把原因
  回帖（新的宿主→webview 消息 `aiPreReviewPanelRejected`，`reason` 已是本地化整句）——原因**点名那张
  卡片**（`path:line[-end] (side)`，空正文与超限两种）。整批拒绝而不是静默部分创建，理由是"面板承诺了
  几条"正是用户盯着的东西（按钮写着 `Create N draft comment(s)`），少写一条而不说，就是这个改动要
  消灭的那种意外。
  ⑦ **正文被清空的那张卡片：拒绝整批并点名**（在"跳过它并说明"与"拒绝并点名"之间选了后者，理由同 ⑥：
  跳过会让用户勾中的卡片无声消失、创建数量少于按钮承诺的数量，而且被跳过的正是他刚刚动过的那张）。
  宿主强制这条规则，不建立在 UI 自觉上：面板自己的代码根本发不出非字符串正文或未提供的索引（那两类按
  `logger.error` 记），而空正文/超限按 debug 记，因为那是用户自己的编辑。
  ⑧ **不变的**：只问用户选定的那一个模型、严格 JSON 契约与锚点校验、从响应候选通道取答案并以 `text`
  兜底、提示词范围模态框及其 fail-closed、用户回答之前不发送任何内容、只建 PENDING 评审、**绝不
  submit**、只在 debug 下存在的诊断。
  ⑨ **测什么**：宿主侧 `src/__tests__/aiPreReviewPanel.test.ts`（未提供的索引、非字符串正文、空/纯空白
  正文、超长正文、重复索引各自一条；整批拒绝；恰好等于上限的边界；正文两端空白原样保留；"什么都没点名"
  与"被拒绝"的区分；带伪造锚点的条目只取 index/body；被拒后修好可以再次创建；`reportRejected` 的回帖）；
  `src/__tests__/aiPreReview.test.ts`（落下的草稿正文就是**用户编辑过的那一句**、锚点仍来自宿主自己的
  候选、答案里伪造的锚点字段无效）；`webview/src/__tests__/AiPreReviewPanel.test.ts`（预填、编辑标记、
  恢复原文、`maxlength` 与到达/超过上限的两种提示、空正文禁用创建并说明原因、Create 计数与回传的正文、
  拒绝行与再次创建、替换 payload 会清掉编辑）；`aiPreReviewBrief.test.ts` 的截断两条（含公告不超过上限、
  恰好等于上限则不动）。
  ⑩ **文档同步**：本条（并就地改正上面 2026-10-02「确认面板」那条里"只回传索引"的说法）、`FEATURES.md`
  的能力条目补上"可以在创建草稿之前编辑正文"、这条改动自己的 changeset、两份 `CHANGELOG`（字节一致）。
- 交付后的修正（2026-10-02，**维护者裁决：入口从"某一个文件"的右键菜单移到 Pull Request 详情页**，
  理由原话是"入口和实际作用域不匹配"）：一次运行取的是**每一个变更文件与整份 diff**（§6.1 的作用域决策），
  而入口挂在 `editor/context` 上、由 `forgejoToolkit.inPullRequestDiff` 把关，于是它出现在**某一个文件**的
  菜单里。
  ① **入口**：扩展自己的面板——`webview/src/views/PullRequestDetail.vue` 的 `.header-actions`——新增一个
  `vscode-button`（`vscode-elements` + 主题 token，无自建品牌样式），标签「AI pre-review (whole PR)」/
  「AI 预评审（整个 PR）」，tooltip 说明它评审**整个 Pull Request**，并在视图知道时给出变更文件数（文件
  列表已加载就用它的长度——和宿主读的是同一个端点；未加载时用该 PR 自己的 `changed_files`；两者都没有就
  **不报数字**，绝不写"0 个变更文件"）。它**自己什么都不发**：点击才发，渲染、悬停、导航都不发。
  ② **消息（新契约）**：webview→host 新增 `aiPreReviewPullRequest`
  （`{ instanceId, owner, repo, index }`）。只带坐标是刻意的：模型、范围、提示词、确认与草稿全在宿主侧，
  所以被改过的 webview 只能选择**评审哪个 PR**，不能影响这次运行发什么、写什么；`instanceId` 必须同行，
  因为 dashboard 是一个 webview 服务所有实例，只有宿主能把实例 id 解析成 URL 与令牌。
  ③ **宿主校验 + 同一条实现**：`src/webview/viewProvider.ts` 的 dispatch 用
  `parseWebviewPullRequestTarget`（`src/webview/repoIdentity.ts`）校验四个字段——`owner` / `repo` 走既有的
  `isSafeRepoNameSegment`（它们会被插进 API 路径），`index` 必须是正整数（与 `parseForgejoPrUri` 同一条
  规则：`Number(...)` 会接受 `'7'` 与 `true`，而"PR 0"不指名任何 PR），`instanceId` 只查非空字符串，未知 id
  交给运行自己的"实例未找到"拒绝，不在这里另发明一条规则。校验通过后调用由 `setAiPreReviewRunner` 注册
  进来的**同一个**函数：`registerAiPreReviewCommand` 把 `startAiPreReview(...)` 交给 provider，而
  `runAiPreReview` 的坐标参数从 `ForgejoPrUriParams` 收窄成 `PullRequestTarget`——两条入口共用一份实现，
  不存在第二套流程。（provider 用回调而不是 import，是因为 `src/aiPreReview.ts` 已经 import 了这个模块，
  静态依赖会成环。）
  ④ **跟随开关**：`forgejoToolkit.aiPreReview` 由宿主在 `initialState` 里以布尔量给出（与 `debug` 同形），
  并在 `onDidChangeConfiguration` 命中该键时以新的 host→webview 消息 `setAiPreReview` 推一次，所以在设置页
  里改开关后按钮也立刻隐藏/出现。**这只是"有没有这个入口"，不是门禁**：运行第一步仍然读该设置并拒绝
  （不变），所以 webview 的布尔量过期最多是多显示或少显示一个按钮——`getInitialState` 里缺失的值一律当作
  **关闭**。测试里被拒的坐标一条都不许触达 runner（那是这条路径上唯一能碰到模型或服务器的东西）。
  ⑤ **`editor/context` 贡献删除，`editor/title` 保留**：`package.json` 的 `editor/context` 不再有
  `forgejoToolkit.aiPreReviewPullRequest`；`editor/title` 那条原样保留（它是从已打开的 diff 出发的快路径，
  维护者没有要求去掉）。manifest 测试**双向**钉住：context 里不存在、title 里仍恰好一条且 `when` 不变，
  所以这条贡献不会悄悄漂回来。
  ⑥ **作用域写在每一句话里**：进度两行改为「Reading the whole pull request…」与
  「Asking the chat model to review the whole pull request ({0} changed file(s))…」（文件数要等文件列表到达
  才知道，所以只出现在第二行）；取消（知道/不知道文件数两种措辞）、"没有可用评论"、模型调用失败、预算
  失败、契约失败、指令装不下、无法度量指令这批消息全部点名"整个 Pull Request"，其中已经读到文件表的那些
  **带上本次覆盖的变更文件数**。这些数字取自这次运行自己的 brief（`gathered.brief.files.length`）与它取到
  的文件表，不是第二次读 PR——第二次读可能看到另一个 head。
  ⑦ **确认面板头部**：payload 增加 `changedFileCount`（本次覆盖）与 `changedFilesTotal`（本次取到），头部
  一行写明"本次运行覆盖整个 Pull Request：N 个变更文件"；两者不等时（brief 的文件表被行数上限、路径预算或
  客户端分页截断）改写成"覆盖了 M 个中的 N 个"，**不谎称整份都读过**。该行的渲染由面板自身的改动落地。
  ⑧ **不变的**：只问用户选定的那一个模型、严格 JSON 契约与锚点校验、从响应候选通道取答案并以 `text` 兜底、
  提示词范围模态框及其 fail-closed、用户回答之前不发送任何内容、只建 PENDING 评审、**绝不 submit**、
  只在 debug 下存在的诊断。
  ⑨ **测什么**：`src/__tests__/aiPreReview.test.ts`（manifest 双向、进度两行、取消/无可用评论/模型失败的
  措辞、面板 payload 的两个计数）；`src/webview/__tests__/viewProviderDispatch.test.ts`（合法坐标走同一个
  runner、malformed/缺字段一律拒绝且 runner 一次未被调用、未注册时不抛、`initialState` 的布尔量、配置变更
  推送）；`webview/src/views/__tests__/PullRequestDetail.aiPreReview.test.ts`（标签、三种 tooltip——文件数
  已知 / 用 `changed_files` 兜底 / 都不知道、点击发出的坐标、开关关闭时不渲染、只渲染不发消息）。
  ⑩ **文档同步**：本条（并就地改正 §4.1 与 §6.1 里"应该挂 `editor/context`"的说法）、`FEATURES.md` 的能力
  条目（入口与"作用域始终是整个 PR"）、这条改动自己的 changeset、两份 `CHANGELOG`（字节一致）。
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
2. **逐条人工确认：~~没有"一键接受全部"~~ 扩展不预选、也不自己提供"接受全部"入口。**
   **2026-10-01 验收修正：这句话此前被读成"屏幕上不存在一键全选"，那是错的**——VS Code 自己的多选
   quick pick 渲染一个 accessible name 为「切换所有复选框」的控件，扩展既不能移除也不能改名，准确口径
   见本文开头那条验收记录。模型给的每条意见都要在草稿进入待提交评审之前
   由人单独看过并确认；未确认的意见一个字都不写进实例。默认建议"全部不勾选"，
   人只勾他认可的那几条（§5）。
3. **默认关闭 + 显式开启。** 新设置 `forgejoToolkit.aiPreReview`（布尔，**默认 `false`**）：
   关闭时命令直接拒绝，且**不向模型供应商发出任何内容**（§7）。
4. **送给模型的是"预评审简报"，不是整个 diff。** 复用 `get_pr_review_brief` 的取向与预算
   （只给形状、只给被截断的正文），默认只发变更文件清单 + 每个文件增删行数 + 已有评审意见的
   元数据；~~**是否把 diff 正文本身发给供应商，是留给维护者的决定**~~ ~~**维护者已裁决：默认不送，
   要送得打开第二个窗口级开关 `forgejoToolkit.aiPreReviewIncludeDiff`**（§7.1、§13.1）~~
   **2026-10-02 起，送什么由 `forgejoToolkit.aiPreReviewPromptScope` 决定**：五个取值、默认 `ask`
   （第一次运行只问一次），那个旧布尔已从 manifest 移除、扩展也不再读它——见本文开头 2026-10-02
   那条修正（旧布尔开关的遗留桥被删除）。
5. **一次只跑一个运行，且可取消。** 同一拉取请求同时只有一个运行；取消或失败时，
   已确认落下的草稿评论**保留**（它们已经是既有人工路径的产物），未确认的意见全部丢弃，
   并明确告知用户发生了什么（§6）。
6. **模型输出必须过锚点校验，过不了就丢，绝不猜。** 输出是 JSON、带 schema 校验；
   只有一行/多行、head/base 两侧、且行号确实落在该文件该侧 diff 里的意见才转成草稿，
   其余**丢弃并计数**（不挪到最近的行、不改侧、不截断字数以外的修补）（§8）。
7. **宿主侧调用 `vscode.lm`，webview 不碰模型。** 这条由
   [`../architecture/mcp-server.md`](../architecture/mcp-server.md) 的「Security model」一节
   末段已经定下，本文沿用（§9）。
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
  `forgejoToolkit.addPullReviewComment`。~~**新的"AI 预评审"动作应当挂同一个键**，
  这样它只在这条 diff 视图里出现，不需要新的上下文键。~~
  （**2026-10-02 修正**：这条只对 `editor/title` 成立——见本文开头「入口从某一个文件的右键菜单移到
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
   让人**读**一遍，而不是让人**点**一下。**2026-10-01 验收修正（上面这句原文保留，只在此注明它不能
   怎么读）：扩展自己确实不做这个入口，但这不等于"界面上没有一键全选"**——VS Code 的多选 quick pick
   自带一个 accessible name 为「切换所有复选框」的控件，扩展移除不了；准确口径与实测见本文开头那条
   验收记录。

---

## 6. 运行怎么触发、边界在哪

### 6.1 触发

- 一个宿主命令，建议命名 `forgejoToolkit.aiPreReviewPullRequest`（与既有命令的命名风格一致：
  `forgejoToolkit.addPullReviewComment` / `forgejoToolkit.createPrFromCurrentBranch`），
  挂在 `editor/title`，`when` 用既有的 `forgejoToolkit.inPullRequestDiff`。
  （**2026-10-02 修正**：`editor/context` 那条后来被删除，见本文开头「入口从某一个文件的右键菜单移到
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
  第五次排查的证据（写在本文开头的交付记录里）是：失败**按次**发生而不是按模型——同一个模型有时能答、
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
  回答的**有界摘录**（最多 200 字符、转义成一行），成功时仍一个字都不写；理由与完整口径见本文开头那条
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
  **留给维护者的变体**见 §11.4。

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
- **~~模型按预算挑，不取列表第一个。~~ 已被 2026-10-01 的维护者裁决删除：扩展不挑模型。**
  ~~`selectChatModels()` 的返回顺序与输入预算无关，而指令提示词是每次运行都要付的固定成本；取第一个
  的实现因此在维护者的机器上"一分钟都没跑起来"（第一个模型的 `maxInputTokens` 小于那份固定提示词）。
  实现分两步：`affordableAiPreReviewModels()` 用每个候选自己的 `countTokens` 量一遍指令提示词，按
  `maxInputTokens` 从大到小剔掉装不下的；`selectAiPreReviewModel()` 再取第一个能装下整个请求的候选，
  若一个都装不下，就用预算最大的那个候选走文件粒度丢弃。~~
  这段历史仍然有用，它解释了**为什么会有校验这件事**：指令提示词是每次运行都要付的固定成本，第一个
  被提供的模型完全可能装不下它。**留下的只有校验，且绝不替换**：选定模型后
  `validateChosenAiPreReviewModel()` 用**该模型自己的** `countTokens` 量一遍固定指令提示词，
  `>= maxInputTokens` 就按两个数字拒绝（点名模型：需要多少 / 可用多少），分词器抛错则单独报"量不出来"；
  两条路径都**不换模型**。指令提示词本身按"每条规则都还要在"的前提压缩过（892 → 781 字符），并有
  一条测试锁住上限。不用 `vendor` / `family` 去挑提供者：那等于替用户点名一个提供者（§9.3）。
- **~~尝试顺序（2026-10-01 补）：本窗口内曾给出合规回答的模型优先，其余仍按预算降序。~~ 已删除。**
  这一段是"先问谁"的排序规则，连同它依赖的模块级窗口记忆（`contractSatisfyingModelKeys`、
  `orderAiPreReviewCandidates()`、`AI_PRE_REVIEW_CONTRACT_MEMORY_LIMIT`）一起被维护者的裁决删除：
  运行只有一个模型，没有"先问谁"。**被否掉的三个候选信号与理由保留在这里**，因为它们逐条核对过
  `@types/vscode` 1.102.0 的 `index.d.ts`：
  1. **"用户最近选用的模型"——没有这个 API。** `ChatRequest.model` 的注释确实写着"This is the
     model that is currently selected in the UI"，但 `ChatRequest` 只作为 `ChatRequestHandler`
     的参数存在，命令式扩展拿不到它；`LanguageModelAccessInformation`（`env.languageModelAccessInformation`）
     只有 `onDidChange` 与 `canSendRequest(chat)`，后者回答的是"同意框是否已经给过"，不是偏好；
     `LanguageModelChatSelector` 只有 `vendor` / `family` / `version` / `id` 四个字段，都是选择器
     而不是"当前选中"的读数；`selectChatModels()` 的注释只说"When omitted all chat models are
     returned"，**没有承诺任何顺序**。所以这类信号**不存在**，不发明、不猜——这条结论仍然是"必须问
     用户"的**直接依据**（§9.1）。
  2. **点名 `vendor` / `family`** —— 本设计明确拒绝（§9.3：不把用户送去某个具体提供者）。
  3. **本扩展自己的历史（"这个窗口里曾答对过的模型"）** —— 曾经是唯一既有据可依、又不点名提供者的
     信号，现在也被否决：它是**观察**，而用户的选择是**指令**；用观察去决定发哪家提供者，仍然是扩展
     替用户做选择。观察与记忆都删掉，设置里那个用户选的值才是唯一的排序（只有一项，没有顺序问题）。
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
  ——这条"回答只留在 debug 里"已被 2026-10-01 的修正取代（见本文开头那条修正）：**契约失败的行现在
  始终带一条回答的有界摘录**（最多 200 字符、`JSON.stringify` 转义成一行；成功时一个字都不写），
  因为只说"不是 JSON"无法判断是模型退化、被截断还是提示词不对。debug 级那条有界形状描述**照旧保留**，
  **简报、diff 与提示词仍然一个字都不进输出通道**，超过摘录上限的部分仍然只在 debug 的 dump 里；
  **debug 打开时另有回答的碎片清单与小结**（2026-10-01 第八次修正，见本文开头那条——一行一个碎片，
  一行写碎片总数、字符总数与拼接结果的有界开头，所以"成功时一个字都不写"只在 debug 关闭时逐字成立）。
  ③ **花掉的调用数要报出来**：两次都失败的消息先写"the same question {1} time(s) — its bound is
  {2} attempt(s) per run, and no other model was called"，再写每次失败在哪儿；成功路径的日志写
  "在第几次询问上给了合规 JSON、这次运行一共花了几次调用"。用户为这些调用付费，所以数字进用户可见
  的消息；~~而**回答内容不进去**（有界形状描述只在 debug 级与 dump 里）。~~ **2026-10-01 修正后：
  每次失败的尝试还带一条有界摘录（≤200 字符、转义成一行），完整回答仍然只在 debug 的 dump 里。**
- **装不下时必须报出数字，不许只说"放不下"。** 装不下**固定指令提示词**时，提示点名选定的模型并
  写清"需要多少 / 可用多少"，再说清**没有替换成别的模型**，并指向换模型的命令；请求装不下时同样
  带上"需要多少 / 可用多少"与模型身份，并点名可以关掉
  `forgejoToolkit.aiPreReviewIncludeDiff` 让请求变小。两条路径都仍然**什么都没发、什么都没建**，
  且日志里各留一行带数字的记录。注意：指令放不下时**不能**把 diff 正文开关当成解法推荐（它只让
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
  失败行带一条有界摘录（≤200 字符、转义成一行；成功时一个字都不写），见本文开头那条修正；
  **2026-10-01 第八次修正：debug 打开时输出通道还多一行一个碎片与一行小结**（同样是回答正文，同样
  只在 debug 下；debug 关闭时仍然一行都没有，见本文开头那条）；除这些之外，输出通道里的回答信息仍然
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
  ① 开启后会把拉取请求的元数据（以及第 (a)/(b) 选项决定的 diff 正文）发给**模型供应商**；
  ② 生成的意见只是草稿，仍要逐条确认；③ 关闭时本功能完全不出现在菜单里或不产生任何请求
  （③ 的前半句由 2026-10-01 的修正落实：两个菜单项的 `when` 现在同时要求
  `config.forgejoToolkit.aiPreReview`，见本文开头那条修正；后半句的运行时拒绝不变）。
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
  **探测命令的用例一条都不改**：它按"模型 × 形态"各写一块，与运行的重试是两个互不相干的循环。
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
  debug 关闭都**零 `sendRequest`**）、"每个被提供的模型都问到每种形态"，以及"同意被拒时只问一次
  就停"；④ 请求形态本身用一条
  测试锁住"`sendRequest` 收到的只有一个 `User` 消息，指令在前、请求在后"——否则一次重构就可能
  把契约放回可以被丢掉的那一条消息里。debug 开关在 `beforeEach` 里显式置为 `false`，因为
  `Logger` 缓存的是构造时读到的值，而断言"关闭时零文件"的用例必须真的在关闭状态跑。

### 9.6 调试诊断：dump 文件与模型探测（2026-10-01 第三次排查补）

维护者的机器上，三个被提供的模型对真实请求都回了 5–10 字符的退化回答，而~~默认路径按设计**不保留
回答正文**~~（**2026-10-01 修正：默认路径现在保留一条有界摘录，见本文开头那条修正与 §7.2；完整回答
仍然只在这里**）——于是"到底是什么发出的、到底回了什么"在默认路径上无法回答。这一节是那条承诺的**唯一**
出口，形态被故意做得尽量窄（裁决与理由见 §7.2）。

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
  （`config.forgejoToolkit.debug && config.forgejoToolkit.aiPreReview`，与入口保持一致见本文开头的修正），
  处理体另外再查一遍 `forgejoToolkit.debug` 与 `forgejoToolkit.aiPreReview`，
  任一条件不满足就**一条模型请求都不发**。满足后向**每一个**被提供的模型各问三种形态的同一句
  `Reply with exactly {} and nothing else.`（`AI_PRE_REVIEW_PROBE_PROMPT`）：单条 `User` 无指令
  （对照）、两条 `User`（旧形态）、单条 `User` 含指令（新形态）。它不读 Pull Request、不发任何仓库
  内容，判词是 `answered exactly "{}" as asked` 或 `did NOT answer the requested "{}"`——这句就是
  "模型不可用"与"请求形态不对"的分界：对照能答而旧形态不能答，说明问题在形态；三者都不能答，说明
  这台机器上的这些模型无法用于本功能，不必再改我们的提示词。
  **（2026-10-01 第六次排查补：还有第四种形态——不带指令块的标点回声
  （`AI_PRE_REVIEW_PROBE_ECHO_PROMPT`，见本文开头那条修正）；它的判词是**布尔**
  `answered the echo exactly as asked: true|false`，用来分开「模型不行」与「通道把标点弄丢」。
  它对每个模型也照旧只问一次，闸门与「不读 Pull Request」都不变。）**
  探测与运行写**同一个文件**，所以"探测一次 + 预评审一次"两轮运行的证据在同一个文件里可以直接对照。**同意框被拒绝或用户取消时不重复问**：
  失败经 `classifyModelError` 分类（与运行同一条路径），`NoPermissions` 与取消都立即停止探测，只把
  已完成的调用写进文件——否则同一个"未授权"会按模型 × 形态重复弹九次。**探测不受运行的重试影响**
  （2026-10-01 第五次排查补）：它的循环是"每个模型 × 每种形态各一次"，写成
  `probe "<形态>"`，不读 `AI_PRE_REVIEW_MAX_*`、也不做第二次尝试——探测要回答的正是"一次调用会碰到
  什么"，把运行的重试掺进去会让它测的是别的东西。
  **（2026-10-01 修正：探测只问「用户选定的那一个模型」，不再向每个被提供的模型各问一遍。）** 决定
  由 `forgejoToolkit.aiPreReviewModel` 单独做出（`resolveAiPreReviewProbeTarget()`，与运行共用
  `findOfferedAiPreReviewModel()`，所以两个界面不可能对"当前是哪个模型"给出不同答案）：设置命中一个
  被提供的模型时，只问它一个（12 个模型 × 4 种形态 = 48 次调用里省下 44 次，其中若干是付费调用）；
  设置为**空**或命中不了任何被提供的模型时**一次都不发**，把"是空的"还是"值没命中"分开说清，并列出
  被提供的模型——它**刻意不**退化成"随便挑一个模型问"或"退回问全部"：这两种都会把调用花在用户没有选择
  的模型上，而这套设置在运行侧的全部意义就是"选择是用户的，扩展不替他挑、也不在模型之间轮换"。
  两个闸门、四种形态、判词、原始回答块、「不读 Pull Request」都不变；dump 头新增两行
  （`models asked by this probe: …` 与 `why these models: the chosen model — …`），把"问了谁、为什么
  是它"写进文件本身，读的人不必从各块反推选择规则；进度条文案随之改为
  `Asking the chosen chat model the same trivial question…`。
- **碎片边界也进输出通道（2026-10-01 第八次修正）。** 本节的 dump 保存的是**拼接后**的完整回答，
  有界摘录同样是拼接后的；**碎片边界本身**此前没有任何地方记录，而那正是"提供者的碎片本来就是坏的"
  与"我们的累积弄坏了它"之间唯一的分界。两条流循环现在各写**一行一个碎片**
  （`AI pre-review: answer fragment 3 of 8 in the stream: length=12, text="…"`，文本按失败摘录那套转义、
  同一个 200 字符上限、被截断时追加 `, cut from N characters`）加**一行小结**
  （`AI pre-review: answer stream summary: 8 fragment(s), 62 character(s), excerpt="…"`）。
  两条路、成功失败都写——它描述的是传输而不是裁决；**被取消或中途失败的流不写**（半读的流没有诚实的
  总数）。**严格由 `logger.isDebugEnabled()` 把关**，
  没有新设置，为假时一行都不交给 logger，消息/toast/通知一个字都不加，所以 debug 关闭时行为与今天
  逐字节相同（判据、理由与测试见本文开头那条修正）。

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
| `@types/vscode` 1.102.0 里**没有** system 角色（枚举只有 `User` / `Assistant`，类只有这两个工厂）                                                                           | 同上类型的 `LanguageModelChatMessageRole` / `LanguageModelChatMessage`；官方指南 "Language Model API" 的 "Build the language model prompt" 一节（"doesn't support the use of system messages"）                                                                                                                                                                              |
| 非 Copilot provider 如何收到消息（`role` + content parts，自行转换角色）                                                                                                    | 官方指南 "Language Model Chat Provider API" 的 "Message format and conversion" 一节（`LanguageModelChatRequestMessage` 与示例 `convertMessages`）                                                                                                                                                                                                                            |
| debug 日志的既有开关                                                                                                                                                        | `src/logger.ts` 的 `Logger.debug` / `forgejoToolkit.debug`                                                                                                                                                                                                                                                                                                                   |
| 本套件自己的 MSW 状态清理                                                                                                                                                   | `src/__tests__/aiPreReview.test.ts` 的 `beforeEach`（`resetMockState()`，来自 `src/test/mocks/handlers.ts`）                                                                                                                                                                                                                                                                 |
| `vscode.lm` 的类型面（`selectChatModels` / `sendRequest` / `countTokens` / `maxInputTokens` / `LanguageModelError`）                                                        | `@types/vscode` 1.102.0 的 `index.d.ts`（`LanguageModelChat` / `LanguageModelChatMessage` / `LanguageModelChatResponse` / `namespace lm`）                                                                                                                                                                                                                                   |
| 引擎底线                                                                                                                                                                    | `packages/forgejo-toolkit/package.json` 的 `engines.vscode`                                                                                                                                                                                                                                                                                                                  |
| 宿主侧用 `vscode.lm` 而不是 MCP sampling 的方向                                                                                                                             | [`../architecture/mcp-server.md`](../architecture/mcp-server.md) 的「Security model」一节末段                                                                                                                                                                                                                                                                                |
| Codeberg 约束与"人类维护信号"                                                                                                                                               | `AGENTS.md` 的「Codeberg hosting and resource usage」一节、`CONTRIBUTING.md` 开头                                                                                                                                                                                                                                                                                            |
| 写侧先例（默认关闭 + 逐次确认 + 不做自动 approve）                                                                                                                          | [`mcp-write-tools-confirmation.md`](./mcp-write-tools-confirmation.md)（其 §3.6 即该先例）                                                                                                                                                                                                                                                                                   |
| "代码会发给模型供应商、加默认关闭开关"的既有判断                                                                                                                            | `TODO.md` 的「PR 描述生成」条目                                                                                                                                                                                                                                                                                                                                              |

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
   命名一旦发布就是对外契约，本轮定稿。**2026-10-01 修正**：`when` 在
   `forgejoToolkit.inPullRequestDiff` 之外还要与 `config.forgejoToolkit.aiPreReview` 相与——开关关掉时
   不显示入口，理由与实现见本文开头那条修正；挂的位置与命令命名不变。
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
   级别不变，仍是 `forgejo-toolkit: minor`），那六份文件删除。本文开头各条修正里"这条改动自己的
   changeset"的说法，自本条起一律指这唯一一份文件，正文按功能当前的样子重写。
8. **文档同步要动哪些文件**（阶段 4 交付时）：**裁决**：`FEATURES.md`（一条能力）、
   `TODO.md`（本条目移出、只留未做的部分）、两份 `CHANGELOG`（字节一致）、本记录与
   `docs/design/README.md` 的状态列。README / FAQ 本轮不动。
9. **"谁来选模型"**（§7.2）：**维护者已裁决（2026-10-01）：用户选，扩展不选、不换。** 空设置 =
   运行时问一次并把答案写进 `forgejoToolkit.aiPreReviewModel`，非空 = 每次都用它；跨模型轮换、
   按历史排序、按预算挑选与窗口记忆全部删除；留下的只有校验（报数字、不替换）。实现口径写在
   §7.2 与本文开头那条修正里。
