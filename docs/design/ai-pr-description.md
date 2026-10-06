# PR 描述生成（draft-only）

- 状态：**设计已定稿；已交付**。本文是**现行契约**：只写今天成立的决定与理由，以及决定当时否掉了什么。
  2026-10-06 的第二次材料裁决（维护者）补上了本功能唯一剩下的那一项：新增具名档位 `commits-and-diff`，
  材料是**平台自己的整段 PR diff**，只在 Pull Request 已经存在的那一面提供（§2.1、§3.1）。

- 适用范围：「生成描述」这一个动作——从表单手里的那次比较起草一段描述，填进描述框作为可编辑草稿。它有两个
  面：**创建 Pull Request 表单**（比较即将提交，PR 还不存在）与**已存在的 Pull Request 的编辑弹窗**（比较是
  这个 PR 自己的，index 已知）。不含 PR 的创建与提交（那是用户自己的动作）、不含 Issue 分诊与通知摘要（它们
  是各自独立的功能，见 `FEATURES.md` 的「未完成」）、不含 webview 里的任何模型调用（`vscode.lm` 只在扩展宿主
  可用）。

- 关联：模型接缝、传输选择、外发同意与能力降级的总记录是
  [`ai-model-transport.md`](./ai-model-transport.md)——本文只落**本功能特有**的决定，接缝的形状（§4）、两条传输
  不得互相回退（§7.5）、设置与密钥面（§8）、能力判断与降级（§9）都在那里定稿，本文不再重复。

- 定稿日期：2026-10-06（接缝阶段 4 落地之后，本功能是第二个接上 `selectedModelFor(feature)` 的功能）；
  `commits-and-diff` 档位同日补上。

## 1. 问题

`TODO.md` 的那一条原先写的是「创建 PR 表单加「生成描述」按钮，diff + commit 列表生成草稿填入 body」。落地时要回答
的问题有四个，都不是「怎么调模型」：

1. **材料从哪来**：创建表单里的 PR **还不存在**，所以没有 PR index，`/pulls/{index}/files`、`/pulls/{index}/commits`
   与 `/pulls/{index}.diff` 三条路都用不上。
2. **送多少、怎么同意**：预评审那套同意面（`aiPreReviewPromptScope` 的五个取值）是按**行级意见**设计的，
   这次要送的东西不一样，直接复用会把两个不同的决定塞进一个值。
3. **失败长什么样**：草稿是往用户正在编辑的正文框里写的，所以「写了一半」这一条比预评审更刺眼——用户可能
   已经打了字。
4. **扩展的边界**：一旦这次动作能提交 PR，扩展就变成了「替用户开 PR」的东西，这是本仓一直拒绝的那类行为。

第 1 条与第 4 条一起把行级 diff 挡在外面，直到 2026-10-06 的第二次材料裁决（§2.1）从一个**已经存在**的 Pull
Request 那一面绕开了它：在编辑弹窗里，index 是已知的。

## 2. 材料：`/compare` 能给的与不能给的

决定：比较的**两半**都从 `GET /repos/{owner}/{repo}/compare/{basehead}` 读，用 `base...head`（merge base 到 head），
commit 列表与变更文件表各取一半。

- **能给的**：commit（sha、主题、正文、作者、日期）、变更文件（路径 + `added`/`removed`/`modified`）、
  `total_commits`。
- **不能给的**：**行级 diff 与增删行数**。`CommitAffectedFiles` 只有 `filename` 与 `status`
  （`docs/api-verification-checklist.md` 的 `repoCompareDiff` 条目已记），`additions`/`deletions` 只在
  `/pulls/{index}/files` 的 `api.ChangedFile` 上有，而创建表单里的 PR 还没有 index。
- **因此创建表单这一面不发 hunk**，而且**同意文案里不许暗示会发**：一句「整份 diff」在那条路上是谎话。要行级
  diff 就得自己把两个版本的正文取回来合成 diff，那会送去一份**与平台自己显示的不一定相同**的 diff——送给模型
  的错 diff 比少送内容更坏（§9）。行级 diff 因此等到了 §2.1 的那次裁决。
- **顺序与上限**：commit 表按服务端顺序（新→旧）取前 `PR_DESCRIPTION_MAX_COMMITS`（50）条，每条主题截到
  200 字符、正文截到 1000 字符；变更文件表取前 300 行并受共享 diff 预算约束。每一处截断都**写进提示词本身**，
  否则模型会把局部当整体描述。

**一处修正（2026-10-06，实测发现）**：两半最初各写各的分隔符，而变更文件那一半在请求到达服务端时是
`base..head`——`slashPreservingPathSerializer` 会把路径参数里的 `.`/`..` 段规范化，一个字面的 `...` 在那里留不住。
`..` 会把 base 分支自 fork 点之后拿到的每个 commit 都算进这次变更，与 PR 自己显示的范围不同。两半现在都走
`src/api/client.ts` 的同一个 `_compareRange`，范围只在一处渲染，并由
`src/api/__tests__/client.test.ts` 在**服务端实际收到的 URL** 上钉住。

### 2.1 行级 diff：用平台自己的整段 PR diff（2026-10-06 第二次材料裁决）

**决定：新增档位 `commits-and-diff`，材料是 `GET /repos/{owner}/{repo}/pulls/{index}.{diffType}` 返回的**
**整段 PR diff（`diffType: 'diff'`，即 `src/api/client.ts` 的 `getPullRequestDiff`），并且只在 Pull Request
已经存在的那一面提供。** 创建表单这一面不提供它，也**不**用别的材料顶替（§3.1）。

否决掉的两条路，理由各自独立：

- **逐 commit 拉 diff**（`GET /repos/{owner}/{repo}/git/commits/{sha}.diff`，它在 pinned swagger 里、生成客户端
  也已导出）：一个 commit 一次请求，并把"每个 commit 相对其父的 diff"当成一次比较的 diff——合并提交显示的是
  合并 diff，线性历史之外的范围也与平台自己的整段 diff 不是同一份字节。**它需要自己拼**，而拼接出来的东西
  不是平台显示的那一份。
- **两个分支上各取一次文件正文、自己合成 diff**：与 §9 的同一条理由——送去的 diff 与平台自己显示的不一定
  相同，而给模型一份**错**的 diff 比少送内容更坏。
- **走 web 路由** `/{owner}/{repo}/compare/{base}...{head}.diff`：它不在 pinned swagger 里，生成客户端没有对应
  operation，而 `tools/api-audit/check.mjs` 只读 `client.ts` 里对 `@cpf23333-forgejo-toolkit/api` 的 import——手写
  请求会**静默绕过端点审计**。维护者的裁决是"不扩审计"，所以这条不做。

**已核实的事实与未能核实的两条**（依据都写在树内，不假装量过）：

- **是 API 端点、且已登记**：`GET /repos/{owner}/{repo}/pulls/{index}.{diffType}` 在
  `docs/api-verification-checklist.md` 的对应条目里（`text/plain`；`diffType` 只有 `diff` / `patch`；源码位置
  `routers/api/v1/repo/pull.go:335-396`），所以接上它不会让 `api-audit` 变红，也不需要新清单条目。
- **响应形状**：标准 unified diff——`diff --git` 起块、`@@ -a,b +c,d @@` 分 hunk。这是树内既有的
  `src/utils/parseDiff.ts`、`src/aiPreReviewBrief.ts` 的 diff 分块器与 `src/test/mocks/data/pullRequestExtras.ts`
  共同依赖的形状。
- **二进制**：清单只记了 `?binary=true` 会让输出包含二进制变更（从而适用于 `git apply`）；本档位**不发**它，
  所以二进制文件的变更就是服务端默认写法（没有 hunk 的 `Binary files … differ` 一类），提示词里如实说明，
  绝不替它编造 hunk。
- **未实测（一）**：这个端点的**响应体长度上限**树内没有记录，也没有真实实例可量；记录里按"未实测、以实际
  响应长度为准"处理，客户端的字符预算与 token 预算是仅有的两道可见边界。
- **未实测（二）**：「与 PR 页面 Files changed 逐字节一致」**不可从树内证明**。两者是同一份 diff 服务的不同
  入口（web UI 走 web 路由、扩展走 API 路由），本仓库没有页面那一侧的可比读数，所以本文只说"这是平台自己的
  diff"，不声称比对过。
- **不与模型输出截断混为一谈**：`AiCompletionResult.truncated`（`finish_reason: 'length'`）说的是**模型回答**被它
  自己的输出上限截断，不是这个响应被截断；两者在这条路径上各自报告，互不冒充。

## 3. 开关与范围：两个功能，两对设置

决定：本功能有自己的**功能开关**与自己的**提示词范围**，都不复用预评审的。

| 设置                                      | 取值                                                              | 默认    | 语义                                                     |
| ----------------------------------------- | ----------------------------------------------------------------- | ------- | -------------------------------------------------------- |
| `forgejoToolkit.prDescription`            | boolean                                                           | `false` | 本功能是否可用；关闭时控件不显示、不读比较、不发任何内容 |
| `forgejoToolkit.prDescriptionPromptScope` | `ask` / `commits-only` / `commits-and-diff` / `commits-and-files` | `ask`   | 提示词可以携带什么；`ask` 是**问题**而不是答案           |

**为什么范围是独立的一份值，而不是复用 `aiPreReviewPromptScope`**：

1. **取值说的不是同一件事**。预评审的四个已选范围里，`changed-lines-only` 与 `full-diff` 描述的是**行级**
   内容，而这条路只在 PR 已存在时才拿得到行级 diff（§2.1）；`metadata-only` 描述的是「PR 的标题与分支名 +
   已有评审评论的元数据」，而创建表单里既没有 PR 也没有评审评论。同一个值在两条路上指向不同的字节，这正是
   「一个值只能有一个含义」要避免的。
2. **同意是逐功能的**。`aiPreReview` 与 `prDescription` 是两个开关、两个时刻：把两个功能的出网决定塞进**一个**
   设置，会让用户为了「让描述能生成」而一次性放开预评审的**代码**出网——那是预评审自己的一个问题，用户没有
   被问过。
3. **形状照抄，语义不照抄**。读取纪律（非字符串 / 读不到 / 拼错一律读作 `ask`，只有显式取值才算答案）、
   「回答写回全局设置，所以只问一次」、以及模态框的目的地句式，都照预评审那一套；变的只是取值集合与文案。
   写回仍然是**全局**作用域：答案要能在设置界面里看到、手改，且在每次生成时都能被读到。

**三档内容的界线**（后两档都会发代码，各自发的是不同的字节）：

- `commits-only`：分支名、用户已填的标题、commit（主题/正文/作者/时间）、变更文件表（路径 + 状态）。**没有任何
  代码离开本机**，所以模型只能说「提交说改了什么」，读不到代码。
- `commits-and-diff`（2026-10-06 新增）：在上面基础上，加上**该 Pull Request 自己的整段 diff**——每个变更文件
  的新增与删除行连同文件头与 hunk 头，服务端报告什么就发什么（§2.1）。**不含**任何变更文件的完整正文。粒度是
  按文件块：超出共享 diff 预算或文件数上限时**从末尾丢整个块**并在提示词里写明，只有"第一个块本身就超过整个
  预算"这一种情形截断保留（否则这一档会静默退化成不发 diff）。
- `commits-and-files`：在 `commits-only` 基础上，加上变更文件在 **head 分支**的正文，最多
  `AI_PRE_REVIEW_MAX_CONTENT_FILES`（20）个文件、受共享文件正文预算约束。复用预评审的
  `buildAiPreReviewFileContents` 与那个文件数上限：两个功能不该对「一次请求能带多少文件正文」有两种答案。

**为什么新增一档，而不是把 `commits-and-files` 的含义扩大**：那个值已经有人回答过——模态框当时明说"不发 hunk"
（`package.nls.json` 的 `config.prDescription.description` 与 `prDescriptionPromptScope.description` 都这么写）。把
hunk 悄悄塞进同一个值，既是"一个值两个含义"，也是拿一个用户从未同意过的外发内容去兑现他给过的答复。两个
档位各自的名称、同意句与 nls 说明因此都独立。

### 3.1 哪一档在哪一面提供

**决定：`commits-and-diff` 只在 Pull Request 已经存在的那一面提供；创建表单配着它时按名拒绝，且不改用别的档位。**

- **模态框的答案集合随面变化**：已存在的 Pull Request 那一面给三个答案（默认档位 + 新档位 + 文件正文档），
  创建表单那一面给两个（默认档位 + 文件正文档）。理由是这一档**读不到材料**——创建表单里的 PR 还不存在，
  `getPullRequestDiff` 没有 index 可用——而一个"提供了但必然被拒绝"的答案不该出现在问题里。
- **配着一个在本次面兑现不了的档位时，运行按名拒绝**：句子点名该取值、说明它需要 Pull Request 已经存在、
  指出两条出路（打开该 PR 在编辑弹窗里生成，或把设置改成别的值），并明说"没有读取任何内容、没有发送任何内容、
  也没有改用别的范围"。**不替换**是硬纪律：换档就是发出用户没选过的字节；**重新提问**也不行，`ask` 是设置里
  "还没回答"的拼法，不是"这个答案放不下"的退路（那会覆盖用户已经给出的回答）。
- **控件层面**. 宿主把"创建表单现在能不能提供这个动作"作为一个**派生布尔**推给 webview
  （`prDescriptionOfferedOnCreateForm`），配置着 `commits-and-diff` 时创建表单不显示该控件；编辑弹窗只看功能开关。
  webview 读不到配置，所以这个判断属于宿主；运行仍然是唯一的闸门（一条过期的布尔最多少显示一个按钮）。
- **如实记下的发现性限制**：回答写进的是**同一个全局设置**，所以"答案集随面变化"只在**还没回答**（`ask`）时
  起作用——一个在创建表单上答过 `commits-only` / `commits-and-files` 的用户，在编辑弹窗里**不会**被重新问一次，
  因此也不会在现场看到 `commits-and-diff` 这个答案；改用它的路径是设置页那个下拉（四个取值都在里面），或者把
  设置清回 `ask`。**重新提问不是出路**：那会覆盖用户对同一件事已经给出的回答，而"只问一次"正是这个设置存在
  的理由。

**任何范围都不发**：访问令牌、URL / 主机名、仓库里**没有**在这次比较中出现的任何文件。`commits-and-diff` 也
不发变更文件的完整正文（那是 `commits-and-files` 的字节），`commits-and-files` 也**不会**因为新档位而开始发
hunk——两档的字节各自不变，且各有一条回归测试钉住。

## 4. 同意：先问，再读

决定：回答之前**什么都不读、什么都不发**，与预评审同一条纪律（`ai-model-transport.md` §7.2、§7.3）。

- 顺序是：功能开关 → 取模型（`selectedModelFor('prDescription', …)`，只做查找）→ **那一个问题** → 读比较 →
  量 token → 请求。`scope` 仍是 `ask` 时，模态框是这一步唯一发生的事；用户关掉 / 取消 / 按 Escape 都返回
  「未回答」，运行以 `cancelled` 结束，**零请求、零模型调用、零写入**。
- 模态框写四件事，与预评审一样：目的地（编辑器自己的模型点名 vendor；自配端点写**显示名与地址**）、每个答案
  分别会发出什么、答案被写回哪个设置、以及「在你回答之前不请求也不发送」。**它只描述这一面真正提供的答案**
  （§3.1）：`commits-and-diff` 那一句必须**明说会把 hunk 发出去**——每个变更文件的新增与删除行连同文件头与
  hunk 头，服务端报告什么就发什么，二进制文件的变更没有 hunk——并同时说清它**不**发什么（任何变更文件的完整
  正文），这样没有人会为了"整份文件"而选了它。创建表单那一面的句子只列它自己的两个答案，并且不承诺 diff。
- **配置好的端点不是同意**（§7.3）：端点齐备、AI 总开关是开的、本功能开关也是开的，都只是「可以问」与「有一个
  目的地」，不改变这里要问一次；这四件事（AI 总开关 / 端点 / 密钥 / 这次的 `ask`）互相都不能推断。
- 回答写回 `forgejoToolkit.prDescriptionPromptScope`（全局），写失败只影响「记在哪」，不影响本次发什么。

## 5. 模型：同一个选择点，没有第二条路

决定：取模型这一步走 `selectedModelFor('prDescription', …)`，参数与预评审完全一样，本功能**不新增**第二条取
模型的路径，也**不自己判断**该走哪条传输。

- 编辑器那条路：本功能**没有**自己的模型设置。列表由用户当场选（面板与预评审同形：显示名、`vendor/family`、
  id、`maxInputTokens`、内容会发给哪个提供者），不选中即取消；这与预评审不同是**有意**的——预评审有一个
  「只评审用哪个模型」的设置（`forgejoToolkit.aiPreReviewModel`），那是它的决定，本功能不去读也不去写它。
- 自配端点那条路：由 `forgejoToolkit.aiModelBindings` 里的 `prDescription` 条目点名，**不弹选择器**，
  `aiPreReviewModel` 一个字都不读。
- **两条传输之间没有回退**（§7.5）：选中的那条失败就是失败，另一条不会被用来「再试一次」。绑定指向的端点
  不存在 / 不可用 / 被开关挡住时，失败并点名，不就近找另一个。
- 预算照预评审的规则：模型自己的 `maxInputTokens` 优先，没有 tokenizer 的端点按 **2 UTF-8 字节 = 1 token** 估算
  并假定 32768；装不下就**拒绝并报两个数**，绝不换模型、更不截断提示词后照发。

## 6. 失败、降级与「正文不被写坏」

决定：草稿只有一种产物——**一段文本**；扩展**从不**创建、编辑或提交 Pull Request。由此：

- 表单只在**成功**那一条臂里把返回的文本写进正文框，所以「失败」与「正文保持原样」是同一件事，不需要回滚。
  用户仍然可以编辑这段草稿，提交仍然是用户自己的动作。
- 正文里已经有用户写的内容时，控件**先问**（第二次按下才替换）。webview 里没有 `window.confirm`，而为一次
  纯 UI 状态的确认跑一趟宿主再接一个原生对话框也不值当，所以这里用「再按一次」的形态；用户继续打字即视为
  选择保留。这**不是**宿主侧破坏性命令的确认，那些仍然由宿主自己弹模态框。
- 失败一律**说清楚**，且只对**那一个**模型说一次、绝不重试到别的模型上：读比较失败、**读该 Pull Request 自己的
  diff 失败**（`commits-and-diff` 档位专用的一句，点名"读不到 diff"而不是"读不到比较"）、模型调用失败、被拒绝
  授权、回答为空 / 只有一段代码围栏 / 超过
  `PR_DESCRIPTION_MAX_CHARACTERS`（16384）字符——每一种都有自己的话。过长的回答**拒绝而不是截断**：把一段话
  从中间砍掉再叫它草稿，比说「这次不行」更坏。
- **配置与本次面不匹配时也失败，而且更早**：一个 stated `commits-and-diff` 配在创建表单上时，运行在**取模型之前**
  就按名拒绝（§3.1），所以既不选模型、也不读比较、也不问第二次。
- **没有可用模型时不出现**：`selectedModelFor` 回 `unavailable` 时，运行只报一句并指向**设置页**
  （`ai-model-transport.md` §9.3 要设置页给出两条出路，而不是每个界面各自复述一遍），零请求、零模型调用。
- 回答不合约定时**没有重试**：与预评审不同，这里的回答是散文而不是 JSON 契约，一次调用要么给出一段可用的
  文字，要么给出上面某一句话。这条差异是有意的：预评审重试的是「JSON 形状不对」，而这里的三种拒绝都不是
  形状问题。

## 7. 交出去的表面

两个面，共用同一个运行（`generatePrDescription`）与同一个消息（`generatePrDescription`）：

- **创建 Pull Request 表单**：正文框上方，「生成描述」按钮 + 一行说明。只在宿主报告"这一面现在可以提供"、
  且 base / head 两个分支名都在且不同的时候出现——比较就是这两个分支，缺一个就没有可描述的东西。
- **已存在的 Pull Request 的编辑弹窗**（2026-10-06 新增）：同一个控件在同一个位置，`mode === 'edit'`。它多用
  一个坐标：**该 PR 的 index**，由视图在 await 之前捕获（`route.params` 跟随全局路由，晚读会起草到别的 PR 上），
  随消息一起交给宿主。base / head 取该 PR 自己的 ref（编辑模式里分支选择器是隐藏的，两个 ref 仍然是这个 PR 的
  ——commit 列表就用它们）；fork 出来的 head 在 base 仓库里 `/compare` 解析不到时，运行按"读不到比较"如实失败，
  不换端点也不猜范围。
- **按钮的显示与否只是「有没有这个入口」**（照 `aiPreReview` 的先例）：运行自己会重读设置，所以一个过期的
  布尔值最多让按钮多显示或少显示一次，永远不会放开一次运行。
- **命令** `forgejoToolkit.generatePrDescription`：贡献在 manifest 里，但**不**从面板猜分支、也不猜 PR——比较只在
  表单打开时存在，所以命令只说明「打开创建表单，或打开一个已存在的 Pull Request 并在它的编辑弹窗里使用同一个
  按钮」。它存在的理由与预评审的命令一样：让这条能力在命令面板里有个名字、在设置页面里有处可指。

## 8. 落地面

| 关切                                                                                   | 位置                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 纯的那一半：提示词、材料、预算、回答校验、**整段 diff 的分节与预算**                   | `src/prDescriptionBrief.ts`                                                                                                                                                                                                                                      |
| 设置读取与"哪一档在哪一面兑现"的判断                                                   | `src/prDescriptionSettings.ts`（`prDescriptionScopeNeedsExistingPullRequest` / `prDescriptionOfferedOnCreateForm`）                                                                                                                                              |
| 运行：取模型 → 问一次 → 读比较（+ 该档位的 diff）→ 量预算 → 请求                       | `src/prDescription.ts`                                                                                                                                                                                                                                           |
| 比较的两半（同一个 `_compareRange`）与整段 PR diff（`getPullRequestDiff`）             | `src/api/client.ts`                                                                                                                                                                                                                                              |
| webview 消息的白名单校验（分支名允许 `/`，拒绝 `..` 段与自身比较；index 必须是正整数） | `src/webview/repoIdentity.ts` 的 `parsePrDescriptionRequest`                                                                                                                                                                                                     |
| 表单控件与「先问再替换」（两个面共用）                                                 | `webview/src/components/PullRequestForm.vue`                                                                                                                                                                                                                     |
| 编辑弹窗把 index 一起交出去 / 创建表单读派生的可用性布尔                               | `webview/src/views/PullRequestDetail.vue`、`webview/src/views/RepoPullRequests.vue`、`webview/src/composables/useAppState.ts`                                                                                                                                    |
| 设置页的开关与范围                                                                     | `webview/src/views/Settings.vue`、`src/webview/settingsSurface.ts`                                                                                                                                                                                               |
| 测试                                                                                   | `src/__tests__/prDescriptionBrief.test.ts`、`src/__tests__/prDescription.test.ts`、`src/webview/__tests__/viewProviderDispatch.test.ts`、`src/webview/__tests__/i18nParity.test.ts`、`webview/src/components/__tests__/PullRequestForm.descriptionDraft.test.ts` |

## 8.1 一条如实记下的限制：没有第二条取消入口

**决定：不为这个功能（也不为预评审）在界面上新增取消控件。** 运行的取消权已经在 VS Code 自己的可取消进度通知
上：两次运行都用 `withProgress({ cancellable: true })`，`abortSignalForToken` 把那个 token 的取消镜像成
`AbortSignal` 并一路送进 `transport.fetch` / `sendRequest`，所以通知上的「取消」真的会中止请求。

**如实留在这里的缺口**：那条通知是**窗口级**的、可能被用户错过（尤其当编辑器窗口不在前台时），而今天没有任何
webview 控件能取消一次运行。补第二个入口的代价是具体的：一条新消息 + host 侧按请求 id 管理 `AbortController`
的注册表 + "取消也必须回一次回复，否则 webview 的 promise 永远挂着"的收尾 + 双语 i18n；收益只是复制一个位置
更对、平台自己已经画出来的按钮。而两次运行的产物都只是文本、失败零写入，没有"取消要回滚"的额外理由。真要补，
顺序应当是先做 host 侧的"每请求一个 AbortController + 取消回复"，再谈界面按钮。

## 9. 否掉了什么

- **复用预评审的提示词范围**：理由见 §3 的三条。
- **把 `commits-and-files` 的含义扩大成"也发 hunk"**：那个值已经被用户回答过，而当时的同意句明说它不发 hunk
  （§3 末段）。
- **逐 commit 拉 diff 再把它们拼起来**：拼接出来的不是平台显示的那一份整段 diff（§2.1）。
- **把两个版本的正文取回来自己合成 diff**：会送去一份与平台自己显示的不一定相同的 diff，而错 diff 比少送内容
  更坏（§2.1）。
- **走 web 路由 `/compare/{base}...{head}.diff`**：不在 pinned swagger 里，手写请求会静默绕过 `api-audit`
  （§2.1）。
- **在创建表单上提供 `commits-and-diff` 再让它失败**：那个面读不到材料，问题里不该有必然被拒绝的答案（§3.1）。
- **运行里替用户换一档**：换了就是发出用户没选过的字节；**重新提问**也不行，那会覆盖已经给出的回答（§3.1）。
- **在界面上加第二个取消控件**：§8.1（连同如实记下的缺口）。
- **一个全局的「允许 AI 出网」设置**：那会让一个功能替另一个功能回答同意问题，§3 第 2 条。
- **失败后自动改用另一条传输 / 另一个模型**：`ai-model-transport.md` §7.5，硬要求。
- **过长的回答截断后照样填进去**：§6。
- **扩展自己创建或提交 Pull Request**：§6 的第一条，也是本功能存在的边界。
