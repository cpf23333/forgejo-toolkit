# Forgejo Toolkit 功能清单

功能清单：按状态分类（进行中 / 已完成 / 未完成），只列插件面向用户的能力；功能级的现状在这里，具体待办、阻塞与下一步动作在 `TODO.md`。

## 进行中

## 已完成

### AI 端点（OpenAI 兼容）

- 除编辑器自己贡献的语言模型之外，可以自配 OpenAI 兼容端点并让 AI 功能跑在上面：页面的「AI 端点」区块列出每个端点（地址、认证方式、已声明模型、自定义请求头、密钥是否已存、哪些请求头被认证方式接管、明文 `http://` 提示），编辑器里填显示名与 id、地址、认证方式（Bearer / `api-key` 请求头 / 无需认证）、模型（id 与显示名）与请求头；id 与显示名留空时按地址生成，撞名自动加后缀，创建时明说 id 之后不能改（密钥按 id 归属）。
- 密钥只进编辑器的密钥存储：API 密钥与每个请求头的 value 都不写进设置，页面只说已设置 / 未设置，清空是显式动作；端点相关设置全在机器级，工作区改不了它。请求地址进日志时去掉可能携带密钥的查询串。
- 「测试连接」按端点运行并给出报告，报告写出它的地址（同样去掉查询串）；端点答 404 / 405 / 501 表示它没有 `/models`，这不是失败，报告直接说模型要手填。
- 目的地分两层，默认值是主路径：设置页先给一条**默认端点与模型**（`forgejoToolkit.aiDefaultProvider` 与
  `forgejoToolkit.aiDefaultModel`），配一次之后所有没有例外的 AI 功能都用它——`openai-compatible` 与 `auto` 的端点那一半说的
  "已配置的端点"就是它；某个功能需要更强或更私密的模型时，才在「逐功能覆盖」里写一条
  （`forgejoToolkit.aiModelBindings`，每行默认"不覆盖——跟随上面的默认值"）。覆盖是最具体的一句话：它点名的端点与
  模型只压过那一个功能的默认值；覆盖要么完整要么不用，只给一半时运行点名缺的那一半，不猜。每次运行都在面板头部、诊断
  与日志里写明这次由哪条传输、哪个端点、哪个地址、哪个模型服务。
- 设置页的 AI 区块按当前传输方式呈现对应的配置：`vscode-lm` 只显示编辑器的聊天模型行、隐藏端点面（原位留一句说明它为什么
  被隐藏、改哪个控件能拿回来），`openai-compatible` 只显示端点面、隐藏编辑器模型行，`auto` 两者都显示并写明优先级
  （有可用的编辑器模型时优先用它，没有时才用已配置的默认端点）。请求超时与逐功能覆盖在任何取值下都可见可改。
- 模型列表自动探测：地址、认证方式或凭据被改过、并停止输入约 800 ms 后，用当前输入发一次 `GET /models`（只列模型，从不发补全请求，保存之前不写任何配置），只补进还缺的模型行，不覆盖手写的列表；地址不是合法 URL、或 AI 总开关关着时一个字节都不发，继续输入即取消本次，失败或被拒都在模型行下面与报告卡上说清，报告卡自己标明来自哪一边；探测成功时那行状态文字旁边再说一句这不是同意——它只读了模型列表，是否会真的发出内容由 AI 总开关与各功能自己的同意询问决定。
- 用不用 AI、哪个功能用，分三层：设置页顶部的 **AI 总开关**（`forgejoToolkit.aiEnabled`，默认**开**）说"完全不要用 AI"——关掉它，没有任何 AI 功能会运行，也不向任何模型取答案（编辑器自己提供的与已配置的都不问）；每个功能自己的开关（AI 预评审、PR 描述生成）说"这个功能是开的"，仍然默认关；真正决定内容是否离开本机、离开多少的是各功能自己那一次同意询问。配好的端点不再另有一道"允许发请求"的闸门：配置端点这个动作本身就说明你要用它，不想用就把它删掉。选定的路不会中途换掉：端点失败就按端点自己的原因报错，不会改用编辑器提供的模型，反之亦然。
- 端点配置随实例与其余设置一起导出 / 导入：导出文件里是一段非密的 `ai` 配置（端点显示名、地址、认证方式、已声明模型、请求头**名字**、逐功能绑定与传输方式），API 密钥与每个请求头的 value 只有选了「加密」才会随文件走，明文的导出会在导出前的提示与导出文件里都不含它们；导入时先在同一套「导入预览」里列出这些端点、标出 id 已存在的三选一（保留已配置的 / 换个新 id 一并导入 / 替换）与明文 `http://` 地址，并直说这个文件有没有带凭据（没加密的文件带不了，得之后自己补）；确认后才写入，凭据进编辑器的密钥存储而不是设置。**导入永不打开全局开关或任何功能开关**（也不关它们）：它不写 `forgejoToolkit.aiEnabled`、不打开任何 AI 功能、也不改你选定的传输方式，所以导入之后每个功能仍会照旧先问一次"发什么出去"。

- 添加、删除、测试连接多个 Forgejo/Codeberg 实例。

### Dashboard 面板

- 标签页切换：Repositories / Issues / Pull Requests；Issues / Pull Requests 页签按当前账号筛选（本人创建、被指派、被提及、待评审）。
- 按实例折叠展示数据，折叠面板标题显示服务器地址和当前账号。
- 仓库卡片：名称、描述、默认分支、star/fork、右侧图标支持在浏览器打开和复制克隆地址。
- Issue / PR 卡片：编号、标题、状态、仓库名、复制链接图标。
- 仓库详情页：README、分支列表、最近 commits、返回 Dashboard。
- 侧边栏视图标题栏的刷新图标刷新的是**你正在看的这一页**的数据，提示文字随页面一起变：仪表板刷新实例与仓库（每个实例的仓库、我的 Issue、我的 PR），仓库页（详情、Issue / PR 列表、单次 Actions 运行）刷新这个仓库的数据，Issue 详情页刷新这个 Issue 及其时间线与追踪时间，PR 详情页刷新这个 PR 及其文件、时间线与提交，通知页按当前筛选刷新通知列表；同一时刻只出现一个刷新图标，命令面板里同样只列当前页面对应的那一条。刷新没有意义的页面它**不出现**：还没有实例时的仪表板首屏（那里只有引导入口）与全局搜索页（结果属于那个搜索框里的查询，页面的「搜索」就是它的刷新）；设置页、首次运行向导与其余编辑器区面板没有视图标题栏，因此也没有这个图标。
- 初次使用引导页：以编辑器页签形式打开，支持语言、服务器、worktree 配置。
- 首次安装引导：Walkthrough 三步入门指南（添加实例 → 打开仪表板 → 发布/创建 PR，中英双语）；首次激活且无实例时自动打开引导页。

### Pull Request Worktree

- 在 PR 详情页提供「在 Worktree 中打开」按钮。
- 自动 bare clone 源仓库到缓存目录，基于 `refs/pull/<index>/head` 创建本地分支和可编辑 worktree。
- 支持配置 worktree 打开方式（新窗口 / 当前窗口）和缓存目录。
- 设置页管理已创建的 worktree（打开、删除）。
- 未配置打开方式时弹窗询问（新窗口 / 当前窗口），并支持记住选择。
- 本地没有源仓库时支持：clone 到缓存目录、选择已有本地仓库、取消。

### 设置页

- 设置页住在**编辑器区的一个标签页**里（一个窗口一个）：命令面板的「Open Settings」与侧边栏视图标题栏的齿轮都打开它，再打开一次是聚焦已开着的那个，关掉再打开是从头重读的新页面；打开它不会再动侧边栏（侧边栏那份应用里的设置页已退役，「打开扩展设置」入口仍在）。标签页重新显示时会重新读一遍当前读数，不带着旧快照回来。
- 页内分**六组**（通用、实例、通知、MCP、AI、Git / Worktree），默认停在「通用」：标签页够宽时是左侧一列竖向分组导航（键盘可上下移动），被拖窄或落进分割编辑器一格时改成一个吸顶的分组选择器，两种形态都不新增设置项；每一组的内容里还有该组自己的标题。切换分组不改变任何控件的可见性与可写性——只有本页能写的设置始终可达。
- 语言切换、调试日志开关。
- 添加 / 删除 / 修改 Forgejo 实例，测试连接。
- 手动声明服务器版本：在实例表单里填写或清空该实例的 Forgejo 版本（如 `16.0.2`、`16.0.2+gitea-1.22.0`），留空即回到自动探测；填写的值解析不了会被拒绝并给出可读提示，不会存下来后被悄悄忽略。声明优先于自动探测与缓存（含 60 秒过期与跨窗口合并写），Actions 等版本闸门按声明值判定——窗口里是这样，Agents 窗口从静态 `mcp.json` 启动、自己建客户端的 MCP server 也是这样；声明值低于最低支持版本时，提示与拒绝信息都会点名是你声明的版本。
- 配置 PR worktree 打开方式和缓存目录，支持文件夹选择器。
- 列出已创建的 worktree。
- 页面上还承载这些设置：通知轮询开关、**轮询间隔**（数字字段，接受 60–3600 秒、默认 300，范围外的值被拒绝并说明原因）与「多窗口」租约、MCP 总开关与三条写工具开关和审计落盘开关、**AI 总开关**（`forgejoToolkit.aiEnabled`，默认开）、AI 预评审开关与提示词范围、PR 描述开关与提示词范围、模型传输方式（`auto` / `vscode-lm` / `openai-compatible`，改选即写，并且决定 AI 区块呈现哪一半配置），以及默认端点与模型、逐功能覆盖两行，还有「开发者」里的 **mock API 开关**（打开后每一个 Forgejo 请求都由本构建自带的样本数据回答，界面里的改动只留在内存里；扩展启动时只读一次，所以要重载窗口才生效，而开发构建之外这个开关不起作用）。每条都在行内写明默认值（轮询、租约、MCP 总开关与 AI 总开关默认开，三条写工具、审计落盘与 mock API 默认关，AI 预评审与 PR 描述默认关、各自的提示词范围默认 `ask`，传输方式默认 `auto`，默认端点与模型默认为空），一次改动只写变化的那一条设置，被编辑器拒绝时把已存的值弹回控件并说明宿主给的原因。

### 国际化

- 支持中文 / 英文切换。

### 调试日志

- 设置页提供 debug 开关。
- 输出 API 请求 URL、状态码、响应体到 `Forgejo Toolkit` Output Channel。

### Issue / PR 详情

- Issue / PR 列表与详情页。
- Issue / PR 描述的 Markdown 渲染与附件列表。
- Issue / PR 详情页：展示评论、diff、时间线。
- PR 详情页 diff 增强：按提交查看 diff，列出每个 commit 的变更文件并支持单提交 diff 预览；PR 只有一个提交时，提交区改为一行摘要（短 SHA 链到该提交 · 提交主题），不重复整份变更树。
- PR 详情页右侧栏展示标签、负责人、里程碑、到期时间、引用、参与者。
- PR 详情页支持反应表情、订阅/取消订阅通知、时间追踪、依赖议题管理。
- PR 详情页显示合并状态及具体阻塞原因（冲突、需要审查、状态检查未通过等）。
- PR 详情页直接展示 CI / commit status 列表。

### Issue / PR 操作

- 创建 Issue / PR：仓库 Issue/PR 列表页提供新建弹窗。
- 编辑 / 关闭 / 重新打开 / 删除 Issue 和 PR：详情页弹窗编辑，保存成功后重新获取详情；删除 Issue 需二次确认。
- 为 Issue / PR 添加评论，支持附件上传。
- 合并 PR，支持 merge / squash / rebase 策略。
- 撤销已合并 PR（Revert merge commit）。
- Issue 详情页支持订阅/取消订阅通知、时间追踪、依赖议题管理。
- PR 编辑表单支持负责人、标签、里程碑、到期时间、引用分支/标签。
- 自研 VS Code 风格日期时间选择器，替代浏览器原生 `datetime-local`/`date` 输入；集成到 Issue / PR 创建与编辑表单、详情页到期时间编辑。
- 从代码中的 TODO / FIXME 注释快速创建 Issue：CodeAction 快速修复，正文自动附带源码永久链接。

### PR Review

- PR 内联 review 评论（行级评论）：在 VS Code 原生 diff 中查看、添加、删除评论。
- PR diff 行级评论富文本输入（独立编辑面板）：Markdown 工具栏与预览、@/# 提及、图片附件上传；支持「添加单条评论」与「开始评审 / 继续评审 / 提交评审」两种模式。
- 提交评审时选择结论：评论 / 批准（Approve）/ 要求修改（Request changes），编辑器中的文本作为评审总结一并提交。
- 多行 review 评论：在 diff 编辑器中拖选多行创建评论，与网页端的多行评论互通。
- AI 预评审（draft-only）：在 PR 详情页点「AI 预评审（整个 PR）」，让聊天模型读一遍整个 PR 并给出行级意见，逐条勾选后只把勾中的落成**待提交评审**的草稿评论；公开仍由你按「提交评审」决定。默认关闭（`forgejoToolkit.aiPreReview`）。
- 自己决定预评审送什么出去：`forgejoToolkit.aiPreReviewPromptScope` 有四个范围（`metadata-only` / `changed-lines-only` / `full-diff` / `changed-files`），默认 `ask` 时第一次运行先问一次才发。见 `docs/design/ai-prereview.md` §7。
- 自己选择由哪个聊天模型评审 PR：`forgejoToolkit.aiPreReviewModel` 留空时每次先弹一次完整模型列表（含 `vendor/family` 与收件提供者），选中即记住；扩展不替你挑，设置页与命令 `forgejoToolkit.aiPreReviewChooseModel` 随时可改。见 `docs/design/ai-prereview.md` §2。
- 预评审可以走自配的 OpenAI 兼容端点：用逐功能绑定把它绑到某个端点与模型后，此时不再读 `aiPreReviewModel`；两条传输互不替代，每次运行都写明内容去了哪个端点与模型。见 `docs/design/ai-model-transport.md` §8.4。
- 端点把回答截断时说得出来：读不出来时提示点名该端点、说明它撞上了自己的输出上限，并给出调高上限或换模型两条出路。见 `docs/design/ai-model-transport.md` §9.2。
- 预评审的确认面板：一个编辑器标签页，每张卡片给出锚点、**可改的正文**（可一键恢复模型原文）与「在 diff 里打开这一行」；默认一条都不勾，也没有「全部接受」控件，只有勾中的才落成待提交评审草稿。见 `docs/design/ai-prereview.md` §5。
- 预评审失败时可读到模型到底回了什么：失败尝试在「Forgejo Toolkit」输出通道留一行（模型、次数与摘录）；命令 `forgejoToolkit.aiPreReviewOpenDiagnostics` 打开完整提示词与回答，仅在 `forgejoToolkit.debug` 打开时写入。见 `docs/design/ai-prereview.md` §9.6。
- AI 预评审的三条变体都未被承诺；见 `docs/design/ai-prereview.md` §13。
- 回复 PR 行级评审评论：在 diff 编辑器里用线程自带的回复框回答，回复立即成为 PR 时间线里的**普通评论**公开可见，不必提交评审或选结论。见 `docs/design/pr-comment-replies.md`。
- 回复在它的线程里可见（含窗口重载之后）：回显每次渲染都从该 PR 的时间线重新推导，所以网页端 / 手机写出的回复也会一并出现在线程里，带时间线标记。见 `docs/design/pr-comment-replies.md` §3。
- PR 描述生成（draft-only）：创建 PR 表单与已存在 PR 的编辑弹窗里都有「生成描述」按钮，由聊天模型按表单手里的那次比较起草一段**可编辑**草稿填进描述框；描述框已有内容时先按一次确认再替换，失败时正文保持原样，扩展**从不**创建、编辑或提交 Pull Request。默认关闭（`forgejoToolkit.prDescription`）。
  范围由本功能自己的设置决定（默认先问一次）：只发 Commit 与变更文件表、加变更文件正文、或加该 PR 自己的整段 diff（最后一档只在编辑弹窗里提供）；模型走同一个选择点，失败不回退、不换模型。见 `docs/design/ai-pr-description.md` §3 与 §3.1。

### 富文本编辑器与附件

- 描述编辑使用带 Markdown 工具栏与预览的富文本编辑器。
- 富文本内图片上传，上传后固定插入 `![image](/attachments/{uuid})` 格式。
- 编辑弹窗内支持附件上传与删除。
- Issue / PR / Release / 评论创建时支持 pending 附件：先选好附件，实体创建成功后自动上传。

### 仓库浏览

- 文件浏览器：目录树展示、文件内容查看、代码高亮由 VS Code 自动处理。
- 文件浏览器增强：文件搜索、文件历史、文件夹展开 loading 指示器。
- 分支 / 标签 / Release 管理：在仓库详情页展示列表、切换标签页查看，并支持创建 / 删除分支、创建标签 / Release。
- README Markdown 渲染预览：在仓库详情页点击「预览 README」，通过 VS Code 原生 Markdown 预览打开。

### 本地仓库自动关联

- 根据当前 workspace 的 git remote 自动识别 Forgejo 仓库和对应实例。
- 在 Dashboard 顶部显示关联仓库卡片，支持快捷打开仓库、Issues、Pull Requests。
- 发布本地仓库到 Forgejo：「Publish to Forgejo」命令引导选择实例、仓库名与可见性，自动创建远程仓库、添加 origin 并推送当前分支；已关联 Forgejo 仓库时该命令直接推送当前分支。
- 作为 VS Code Git clone 源：已配置实例注册为 `RemoteSourceProvider`，「Git: Clone」快速选择中按关键字在服务端搜索仓库克隆，无关键字时列出当前用户仓库。
- 多仓库 / 嵌套仓库 workspace：workspace folder 一层子目录中的独立 git 仓库（含 repo 内嵌套 repo）参与关联检测，按当前文件/活动编辑器归属仓库，多仓库歧义时交互命令弹 QuickPick 消歧。
- 多 remote 仓库：一个仓库配置多个 git remote 时，任一 remote 匹配已配置实例即参与关联（origin 优先）；Publish 命令可选择推送到匹配的 remote。
- Dashboard 关联仓库卡片列出全部已关联仓库，可手动切换关注对象；活动编辑器切换时自动跟随归属。
- Start Work on Issue：Issue 详情页一键从默认分支创建 `issue-<编号>-<标题>` 分支与 worktree 并打开。

### 状态栏

- 当前 workspace 关联 Forgejo 仓库、当前分支非默认分支且无开放 PR 时，状态栏显示「创建 PR」按钮；点击按需推送分支并打开预填 head/base 的新建 PR 弹窗。
- 分支已有开放 PR 时显示「PR #n」，点击直达 PR 详情。

### 通知与搜索

- Forgejo 通知中心：未读角标、按状态和类型筛选、标记已读/全部已读、Issue/PR 通知直接跳转详情。
- 通知后台轮询与推送：extension host 定期拉取所有实例未读通知，检测到新通知时弹出 VS Code 消息提醒，并自动更新首页铃铛角标；支持开关与轮询间隔配置。
- 全局仓库 / Issue / PR 搜索：跨实例搜索，支持实例、类型、状态筛选。
- 仓库内 Issue / PR 列表支持关键词搜索（服务端 `q` 参数），与状态筛选组合使用。

### 设置与数据

- 实例 URL 同步：当 Forgejo `app.ini` 的 `ROOT_URL` 与用户配置的实例地址不一致时，自动将 API 返回的 URL 重写为配置地址；支持 per-instance 开关，默认开启。
- 实例配置导出 / 导入：支持将已保存实例（含 access token）和设置导出为 JSON 文件，或从 JSON 文件导入。
  - 导出时可选择具体实例、复制到剪贴板、使用密码加密。
  - 导入前预览，显示「已存在」实例的差异和 Token 冲突检测。
  - 预览有返回路径：「返回实例列表」回到设置列表，落点是打开预览的那一组、焦点回到「导入」按钮；读者在预览里改过选中项或端点的冲突答案时先问一次再离开。
  - 导入后自动恢复语言、调试开关、worktree 配置，并停在设置页的实例列表（回到打开预览的那一组），不再跳转 Dashboard。
- 移除实例前二次确认。

### CI / Actions

- 读取仓库 Actions 运行状态和历史。
- 运行列表分页累加加载（Load more），翻到末页后保留已加载内容。
- 在 PR 详情页展示状态检查（status checks）列表，帮助判断是否可以合并。
- Actions 运行详情页：展示 job 列表、job 日志、制品列表。
- Actions 制品本地下载：通过 API 获取 ZIP 并调用系统 save dialog。
- Actions 运行详情页支持取消正在运行的记录。
- Actions 远程触发 workflow：表单读取所选 ref 上 workflow 文件声明的 `on.workflow_dispatch.inputs`（依次查找 `.forgejo/workflows`、`.gitea/workflows`、`.github/workflows`），按声明渲染控件——`string` 文本框、`boolean` 复选框、`choice` 用 `options` 生成下拉框，其他类型（如 `number`、`environment`）退化为文本框——并显示输入名与 `description`、预填 `default`、标出 `required` 且在必填为空时拒绝提交。文件读取或解析失败（私有路径、不支持的写法、没有 `inputs`、接口报错）时回退到原始键值对输入、在界面上说明当前模式，且切换模式不会丢弃已填写的值；触发后轮询展示运行状态。

### MCP Server

- 通过 VS Code `contributes.mcpServerDefinitionProviders` 将每个已配置且存有访问令牌的 Forgejo 实例各暴露为一个 MCP 服务器（每实例一个 definition，label 为 `Forgejo: <实例名>`；两个实例的 label 相同时——同名，或同一主机上的两个账号——只给相撞的那些追加 `<用户名或实例 id>` 判别符，保证列表里可区分），供 Copilot agent mode 等 MCP 客户端使用，零配置（VS Code ≥ 1.102）。
- 工作区 → 仓库映射工具 `get_workspace_repository`：宿主把当前工作区链接到的仓库按窗口写入 `globalStorage/mcp-workspace-<pid>-<nonce>.json`（复用检测的共享扫描缓存，串行化的原子写入，不含凭据），路径经 `FORGEJO_MCP_STATE_FILE` 传给 MCP 子进程；子进程每次调用实时重读，按实例 id（旧版宿主回退到实例 URL）过滤，并能把属于其他实例的仓库指向对应的服务器。AI 在用户说「这个仓库 / 当前项目」而未给 owner/repo 时先调它。
- Phase 1 只读工具集（全部标记 `readOnlyHint`，大字段截断保护上下文）：
  - 基础工具：Issue / PR / 时间线 / 通知 / 仓库信息 / 全局搜索。
  - Actions 扩展：运行历史、job 列表、job 日志、制品列表。
  - 代码读取扩展：文件内容、目录列表、分支、标签、提交、文件历史、仓库内文件搜索、PR diff。
  - Review 与元数据扩展：PR 评审、whoami、Release、标签、里程碑、当前用户仓库列表。
- MCP Prompts：三个只读提示模板 `review-pull-request` / `analyze-ci-failure` / `triage-issue`，把工具按固定顺序串成工作流并规定回答结构（评审意见、CI 根因、issue 分诊建议）。参数全部可选：缺省 owner/repo 时指引先调 `get_workspace_repository`，缺省编号时指引先用对应的列表工具解析。提示模板本身无副作用，不改动只读工具面与安全模型。
- 面向 agent 上下文预算的 CI 失败摘要工具 `get_ci_failure_summary`：一次调用取 run 内每个失败 job 的错误行（各带 2 行上下文）与日志尾部（约 100 行），并标注每处截断——包括客户端 10 MB 上限只保留头部、导致真实尾部不可见的情形；替代连续调用 `get_action_run_jobs` + 每个失败 job 一次 `get_action_job_log`，并避开后者「只保留日志头部 10 KB」而恰好丢掉失败信息的问题。提取文本按共享预算预分片，不依赖 `truncateLargeStrings` 兜底。
- 面向 agent 上下文预算的 PR 评审摘要工具 `get_pr_review_brief`：一次调用返回 PR 头部（标题/状态/作者/基头分支/合并阻塞）、diff 统计（文件数与总增删行，外加按文件的增删行表——不含 diff 文本）、每个 reviewer 的最新结论与汇总判断、以及未解决的 inline 评审评论（path/line/作者/时间/正文），替代评审起步时的 `get_pull_request` + `get_pr_diff` + `get_pr_timeline` + `list_pull_reviews` 四次调用；描述注明 diff 文本、描述、commit 与时间线仍需按需回退原工具。评论按 review 逐条读取（上游没有一次取全的端点），以 4 并发有界扇出，单个 review 读取失败只计入 `unreadableReviewCount`；被解决的会话按 Forgejo 只写在首条评论上的 `resolver` 整体排除。各段预分片（文件表 100 行/16 KB，评论 50 条/24 KB、单条正文 1 KB），`truncated`/`truncatedBy`/`bodyTruncated` 标注每处裁剪且总数保持精确，不依赖 `truncateLargeStrings` 兜底。
- Phase 2 写工具（三个，均默认关闭、各自独立开关）：`create_issue_comment` 在 Issue / PR 下新增一条评论；`submit_pull_review` 提交一个已存在的待处理（pending）评审，结论为 `COMMENT` / `APPROVED` / `REQUEST_CHANGES`（拼写与 Forgejo 的 `ReviewStateType` 一致，非法取值发请求前即被拒），`APPROVED` 可能满足分支保护要求，且它与 `REQUEST_CHANGES` 必须有非空正文；`cancel_action_run` 取消一条待处理或运行中的 Actions workflow 运行记录（停止已在跑的工作，且服务端对已完成的 run 也返回 204，故结果只说「接受了取消请求」，状态以 `list_action_runs` 为准）。两道闸门：VS Code 每次调用弹确认框，并且要在设置里**按工具**开启（`forgejoToolkit.mcpWriteTools.createIssueComment` / `submitPullReview` / `cancelActionRun`）；只有**由扩展宿主建立的会话**才能写，只带你自己配置里 token 的会话会被明确拒绝并指出该打开哪个设置。
- 三个写工具都支持 dry-run（先给出计划，含目标与正文长度/摘要哈希，评审还会说明结论的含义）与幂等键（10 分钟内同一 key 的相同调用只发一次、直接回放上次结果）；每次调用都留下不含正文的审计记录（默认只进 `Forgejo Toolkit` Output Channel，可用 `forgejoToolkit.mcpWriteAuditToFile` 同时落盘，评审记录额外带 `reviewId`，无请求体的取消记录不带字节数与摘要字段）。设计与决定记录见 `docs/design/mcp-write-tools-confirmation.md`。
- 设置 `forgejoToolkit.mcpEnabled`（默认开）：关闭后不注册 MCP server 定义、停掉本地 broker，已连接的客户端继续用已启动的进程直到重载窗口；运行时切换即刻生效。
- Copilot 指令生成命令 `forgejoToolkit.writeCopilotInstructions`：在工作区仓库的 `<仓库根>/.github/copilot-instructions.md` 创建 / 追加 / 更新一段只读能力声明；标记不完整或重复时完全不写入并警告。

### 多窗口轮询租约

- 设置 `forgejoToolkit.multiWindowLease`（默认开）：机制健康时**只有持有者窗口轮询与提示**，follower 停止轮询/提示并在被接管后立即轮询一轮；**任何不确定一律退化为全速轮询**。机制不可用时给一次性提示（可复制诊断或关闭设置），并提供 `Forgejo Toolkit: Copy Polling Diagnostics` 命令（脱敏诊断字段）。

## 未完成

### 近期

- 设置同步：可选接入 VS Code Settings Sync。
- Issue 分诊建议：按内容建议标签与负责人。
- 通知讨论摘要：在通知列表总结讨论时间线。
- 行上的右键菜单带上本扩展自己的动作：在仓库、PR、Issue、通知、已保存实例、AI 端点与预评审建议这些行上右键时，看到的是适用于该行的动作（打开、复制地址或编号、刷新、标为已读、测试连接、在 diff 里打开这一行等），而不是平台那三项剪切 / 复制 / 粘贴。逐块要加哪些条目与加它们之前必须先解决的两件接口事在 `TODO.md` 的「P3 Webview 右键菜单的 VS Code 原生项」条目；现行的抑制与两处例外见 `docs/architecture/README.md` 的「Webview UI」一节。

### 等上游

- CI / Actions：Workflow / job 重新运行（rerun）与按 job 过滤日志，两者都等 Forgejo v17 的相关接口；见 `TODO.md` 的「等上游版本」条目。

### 长期

- 旧版本 Forgejo / Gitea 兼容：兼容不同 Forgejo 版本（如 1.x、7.x、9.x）的 API 差异，并评估对 Gitea 的兼容支持（API 路径、字段、认证方式的差异）。
- 多账号权限管理：区分只读 / 读写 token。
- 文件浏览器增强：文件重命名 / 删除（目前更推荐本地 clone 后操作）。
- 预评审读 PR 之外的相关文件：现在的最高一档 `changed-files` 只让模型看这次改动过的文件，"这个函数在别处怎么用、这里的约定是什么、这次改动破坏了哪个测试"这类问题它答不了。让扩展按 import / importer 关系、同名测试文件与同目录兄弟文件挑少量相关文件一并读，并如实说明取了哪些、为什么取；每一份都是新的出网内容，所以同意要按范围逐项做，而不是悄悄把 `changed-files` 的边界放大。这是独立的大功能，需要自己的设计与批准；现行提示词范围的契约见 `docs/design/ai-prereview.md` 的「现状摘要」一节。
- 预评审按需索取文件：让模型在评审过程中通过扩展提供的工具按需拉取它要看的文件，而不是一次把范围定死；每一轮取什么、为什么取都摆在你面前、可以逐次拒绝，并受明确的调用上限与费用边界约束。它的同意模型比"一个模态框问一次"大得多（每一轮都在往外发内容），同样是独立的大功能、需要自己的设计与批准；现行提示词范围的契约见 `docs/design/ai-prereview.md` 的「现状摘要」一节。
