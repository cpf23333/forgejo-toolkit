# 已知问题

## PR 附件需要从 Issue API 获取

Forgejo 的 `GET /repos/{owner}/{repo}/pulls/{index}` 接口**不会**返回 `assets`/`attachments` 字段，即使网页界面显示了附件。不过，底层 PR 也可以通过 `GET /repos/{owner}/{repo}/issues/{index}` 作为 issue 访问，而这个接口**会**返回 `assets`。

为了在详情页显示 PR 附件，`ForgejoClient.getPullRequestDetail` 目前会同时发起两个请求，并把 issue 响应中的 `assets` 数组合并到 PR 详情里。这是一个 workaround，如果 Forgejo 将来改变 PR 和 issue 的关系，可能会失效。

理想情况下，Forgejo 应该直接在 pull request 响应中包含 `assets`，或者为 PR 提供独立的附件接口。

## Markdown 中的图片附件需要扩展宿主代理

Forgejo 附件 URL（例如 `/attachments/{uuid}`）需要认证。VS Code webview 无法与扩展宿主共享 cookie，所以直接指向 Forgejo 的 `<img>` 标签会被重定向到登录页，导致图片无法渲染。

扩展目前的 workaround 是：使用存储的 access token 在扩展宿主中获取渲染后的 Markdown HTML 里的每张图片，将其转换为 `data:` URL，并在返回 HTML 给 webview 之前替换原始的 `src`。

## Issue/PR 创建时上传附件需要分两次 API 调用

Forgejo 官方 API 只提供了 `POST /repos/{owner}/{repo}/issues/{index}/assets`，该接口要求 Issue 或 Pull Request 已经存在。没有能在创建 Issue/PR 的同时上传附件的接口。

Forgejo 网页界面在*创建*新 Issue/PR 时，还会使用一个通用的 `POST /{owner}/{repo}/issues/attachments` 表单接口。但该 Web 路由属于基于 session 的认证组，不接受 API access token（`Authorization: Bearer`/`token`），扩展无法使用，只能退回到官方 API 接口。

扩展目前的做法是：先创建 Issue/PR，再自动把待上传的附件传上去。对用户来说，创建前可以选择文件，创建后会自动上传。

此外，上传附件要求 access token 拥有 **`write:issue`** 权限范围。如果 token 只有只读权限，会返回 403 错误：`token does not have at least one of required scope(s): [write:issue]`。

## Forgejo 的 PR 文件接口可能会漏掉删除文件

Forgejo 的 `GET /repos/{owner}/{repo}/pulls/{index}/files` 接口返回的变更文件列表，不一定与 Forgejo 网页界面显示的一致。

在一次测试 PR 中，网页界面显示有 6 个变更文件（包括一个删除文件），但 API 只返回了 5 个文件，遗漏了删除文件。

扩展现在使用 `GET /repos/{owner}/{repo}/compare/{basehead}` 接口来构建 PR 级别的变更文件列表。该接口返回 PR base 与 head 之间的净 diff，包括在整个 PR 中被删除的文件。如果某个文件在一个提交中被添加、在另一个提交中被删除，则不会出现在净 diff 列表中；这对于完整 PR 视图是正确的，但与按提交查看的视图不同。

PR 详情页已有的按提交查看模式覆盖了这一缺口：**提交**一节会列出每个单独提交的变更文件，并可打开单提交 diff。因此，即使 PR 级别的列表漏掉了某个文件，只要它是在一个提交中被添加、在另一个提交中被删除，仍然可以在对应提交里看到。

## 多文件 diff 编辑器中修改/重命名文件不显示 M/R 徽章

在 VS Code 的多文件 diff 编辑器（`vscode.changes`）中查看 PR 变更文件时，新增文件会原生显示 **A** 徽章，删除文件会原生显示 **D** 徽章，因为 diff 的一侧为空。

对于修改或重命名的文件，VS Code 通常通过内置 Git 扩展解析 **M**/**R** 徽章，而这要求仓库已经作为工作区文件夹打开。当没有本地 checkout 直接查看 PR 时，多文件 diff 编辑器可以正确渲染 diff 的两侧内容，但文件名旁不会显示 **M** 或 **R** 徽章。

我们已为自定义的 `forgejo-pr:` scheme 注册 `FileDecorationProvider`，但在此场景下 VS Code 目前只使用内部的 `multi-diff-editor:` 包装 URI 调用它，而不是底层的资源 URI，因此该 provider 无法补上缺失的徽章。我们也尝试过把修改文件的 resource URI 换成本地工作区的 `file:` URI，但同样没有让 VS Code 显示出徽章。

目前要保证 M/R 徽章唯一可行的方案是自己实现一个自定义 diff 预览 webview，而不是使用 `vscode.changes`。短期内没有 workaround。

## 打开的 worktree 会出现在 VS Code 的最近打开文件夹历史里

当扩展使用 `vscode.openFolder` 打开一个 worktree 时，VS Code 会自动把这个文件夹路径加入它自己的「最近打开」历史。扩展 API 没有参数可以在打开文件夹的同时抑制这条记录。

这是 VS Code 的预期行为，不是扩展的 bug。如果你不希望最近列表被填满，可以手动在 VS Code 的**文件 > 最近打开**菜单中移除相关条目。

## Release 创建时上传附件需要分两次 API 调用

Forgejo 上传 Release 附件的 API 端点是 `POST /repos/{owner}/{repo}/releases/{id}/assets`，要求 Release 已经存在。目前没有能在创建 Release 的同时上传附件的接口。

扩展目前的做法是：先创建 Release，再自动把待上传的附件传上去。对用户来说，创建前可以选择文件，创建后会自动上传。

## Release「使用标题和内容作为标签消息」无法通过 API 实现

Forgejo 网页版在创建 Release 时提供了一个复选框，可以把 Release 标题和正文复制到自动创建的标签消息中。但官方的 `CreateReleaseOption` / `EditReleaseOption` 类型里并没有 `tag_message` 字段。

所以扩展没有实现这个复选框；当 Forgejo 根据 `target_commitish` 自动创建标签时，标签消息使用 Forgejo 的默认行为。

## Actions 运行步骤未在 REST API 中暴露

Forgejo 网页界面会展示每个 job 的步骤（例如 "Set up job"、"actions/checkout"、"Run tests"）及其状态和耗时，但官方 REST API 没有提供步骤级别的数据。

现有接口（`GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs` 和 `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs`）只能返回 job 级别的信息和日志。网页界面是通过解析 job 详情页 HTML 中的内部数据（`data-initial-post-response`）来渲染步骤的，而这种方式无法通过基于 token 的 API 认证访问。

因此扩展目前只展示 job 级别的状态和日志。要实现步骤级拆解，要么等待 Forgejo 新增 API 端点，要么退回到网页爬取，但后者在私有仓库上存在认证限制。

## 重新运行 Actions 运行记录未在 REST API 中暴露

Forgejo 网页界面允许用户重新运行已完成的工作流运行，但官方 REST API 中没有对应的端点。`/repos/{owner}/{repo}/actions/runs/{run_id}/cancel` 端点可以取消 pending 或 running 状态的运行，但 API 路由中并没有 `/rerun` 或 `/re-run` 相关的实现或文档。

已对 Forgejo 服务端源码核实：rerun 仅以基于 session 认证的 web 路由形式存在（`POST /{owner}/{repo}/actions/runs/{run}/rerun`，注册于 `routers/web/web.go`，handler 在 `routers/web/repo/actions/view.go`），而 `routers/api/v1/api.go` 中没有注册任何 rerun 路由。不建议在扩展中模拟 web 表单请求，因此将其作为平台限制接受。

因此扩展只为正在运行的记录提供「取消运行」按钮，不提供「重新运行」按钮。如果工作流支持 `workflow_dispatch`，用户可以通过「触发 workflow」按钮再次手动触发。

## PR diff 行级评论无法通过行号旁的 + 图标创建

VS Code 稳定版 Comments API 没有暴露 `CommentController.onDidCreateCommentThread`，因此扩展无法捕获用户在 diff 编辑器行号旁点击 `+` 图标的动作。如果启用该按钮，只会显示一个无法提交的评论输入框，反而造成误导。

因此新增 PR 审阅评论改通过编辑器右键菜单命令 **Add Pull Review Comment** 触发；已有评论仍会作为 `CommentThread` 渲染在对应的 base/head 行上。这是稳定版 VS Code API 的限制，短期内没有 workaround。

## base 侧评论在 inline diff 模式下不渲染

PR 文件 diff 编辑器（`forgejo-pr:` scheme）处于 inline（合并）模式时，锚定在 base（旧/左）侧的审阅评论完全不渲染——评论 thread widget 和行范围高亮都不出现。相同的评论在并排（side-by-side）模式下渲染正常；head（新/右）侧评论在两种模式下都不受影响。

这是 VS Code 的投影限制：inline 模式把原始文档和修改后文档投影到同一个视图中，挂在原始侧文档上的评论 thread 不会显示。扩展侧日志确认 thread 和装饰都已正确创建并应用，是 VS Code 在 inline 投影中不予展示。

规避方法：用 **Compare: Toggle Inline View** 把 diff 编辑器切到并排模式查看 base 侧评论，或从**评论**面板打开——所有 thread 在面板中都会列出，不受视图模式影响。

## 多行评论高亮的末行颜色与其他行略有差异

VS Code 原生的评论范围装饰是 inline 装饰：多行评论范围的首行和中间行整行染色，但末行只染到范围的结束列，看起来就像「末行没有高亮」。扩展用自己的整行装饰补齐末行，使用相同的主题色（`editorCommentsWidget.rangeBackground`），并且只在评论 thread 展开时绘制。

这个补齐无法做到像素级一致。VS Code 通过内部 CSS class 绘制它的装饰，而扩展只能走 editor decoration API，两者与底下的半透明 diff 背景叠加的方式不同。结果就是末行的色调可能与上面的行略有差异，在新增（绿色）diff 行上最明显，且与锚在该范围上的评论条数无关。不透明补偿色也不可行：扩展无法把主题色解析成 RGB 值，无法复现叠加后的颜色，而写死颜色又会破坏其他主题。

这只是观感问题——评论范围本身（widget 锚点、行标签、Forgejo 网页端）都是正确的。

这个补齐会在 diff 文档的可见范围变化时重新应用，因为 VS Code 与 Comments API 都不上报 thread 的展开状态。这条同步被刻意收窄，排查该高亮问题时可以假定三条规则：只有已经带有范围装饰的文档才能触发它（输出通道、评论输入框所在文档和普通文件永远不触发——重新应用可能写「Forgejo Toolkit」输出通道，让输出文档参与触发曾使扩展对自己反复重绘）；某个编辑器算出的范围集合没变时根本不会重绘；debug 诊断行（`Thread range decorations applied per visible editor: …`，仅在 `forgejoToolkit.debug` 打开时写入）只在它报告的明细真正变化时写入，因此每次真实变化只出现一次，而不是每次重新应用都出现一次。有一个结果属于预期而非缺陷：打开 debug 后，在含展开多行 thread 的 diff 编辑器里滚动，只要每个编辑器的条数不变就不会产生新行。

## 点击 PR diff 编辑器的 gutter 会误设断点

PR 文件 diff 编辑器（`forgejo-pr:` scheme，inline/合并模式）中，修改侧在「原始侧行号列」与「修改侧行号列」之间保留了一条约 19px 宽的 glyph margin。单击这条区域会在只读的 diff 文档上设下断点，行为与普通文件编辑器完全一致——已在默认配置的开发宿主上实测确认，不需要 `debug.allowBreakpointsEverywhere` 或任何特殊设置。

这个断点既没有意义又容易误导：文档是按 sha 寻址的只读快照，任何调试器都不可能绑定到它；而且这条区域紧邻行号，而行号的右键菜单正是 **Add Pull Review Comment** 评审入口。

扩展侧无法阻止。diff 是通过 `vscode.diff` 命令打开的，其选项不携带任何编辑器设置（无法对单个 diff 关闭 `editor.glyphMargin`）；gutter 单击由 VS Code 内置的编辑器组件处理，不经过带 `when` 子句的命令，context key 无从拦截。

规避方法：在**运行和调试**视图中删除误设的断点（或执行 **Debug: Remove All Breakpoints**）。更激进的替代方案是全局设置 `editor.glyphMargin: false`，但那会影响所有编辑器。

## 项目看板未在 REST API 中暴露

Forgejo 网页界面为仓库和组织提供了项目看板功能，包括创建项目、管理列、把 Issue 分配到项目等。但官方 v1 REST API 没有暴露任何 `/projects` 端点。

API 中唯一与项目相关的字段只有：

- 仓库设置里的 `has_projects`，仅用于控制是否启用项目单元。
- `TimelineComment` 里的 `project_id` / `old_project_id`，仅在 Issue 被移动项目时作为时间线事件记录。

目前没有接口可以列出、创建、更新、删除项目，也没有接口可以把 Issue 分配到项目或从项目移除。因此扩展无法提供项目看板功能。

这是 Forgejo API 本身的限制。要实现项目看板支持，需要 Forgejo 在 v1 REST API 中增加专门的项目端点。

## inline diff 视图可能把行号渲染成 `undefinedundefined`

我们观察到过一次：当 PR 文件 diff 编辑器宽度不足、自动切换为 inline（合并）模式时，评论 zone widget 旁边的行号栏显示了字面文本 `undefinedundefined` 而不是行号。并排（side-by-side）模式不受影响，且切换视图模式或重新加载窗口后该现象未再出现。

这疑似是 VS Code 在 inline diff 编辑器中渲染评论 zone widget 时的偶发竞态，并非扩展绘制的：扩展没有使用任何 decoration 或行号 API，同一文件的原生 Git diff 在 inline 模式下行号显示正常，因为它没有挂评论 widget。

如果再次出现，规避方法：切换视图模式（**Compare: Toggle Inline View**）或重新加载窗口。

## 分支名含 `/` 时，在会解码 `%2F` 的反向代理后可能 404

扩展会对分支/标签/ref 路径参数做百分号编码（`feature/foo` → `feature%2Ffoo`）。已对 Forgejo 服务端源码核实：一个全局中间件强制 chi 在转义后的路径（`RawPath`）上路由，路由参数再解码还原，因此编码后的斜杠在**所有**路由上都能正常工作——包括 `git/trees/{sha}` 这类单段参数路由，与 chi 默认行为给人的直觉相反。

但某些反向代理（部分 nginx/Apache 配置）会在转发前把 `%2F` 解码回 `/`，导致参数被拆成多余的路径段，请求 404。受影响的功能包括文件搜索等一切按名字定位分支的操作。

规避方法：调整代理配置，原样转发转义后的路径（nginx 使用不带 URI 部分的 `proxy_pass` 即不会解码）；或避免在分支名中使用 `/`。扩展侧无法检测或修复代理层的解码行为。

## 仅第三方 http:// 明文图片会被 webview CSP 拦截

webview 的 Content-Security-Policy 允许任意 origin 的 `https:` 图片，因此 Issue/PR 正文里的第三方 https 图片——包括 Forgejo 为未上传头像的用户返回的 gravatar 头像——都能正常显示。已配置实例的 origin 也会单独加入白名单，所以 `http://` 实例自身提供的图片同样正常。

设置向导是例外：它要为「已输入但尚未保存」的实例渲染 markdown 预览，因此该面板直接允许 `http:` 图片，而不是在面板 HTML 构建时白名单一个当时还不知道的 origin（表单不做持久化，为了套用 origin 重建面板会把输入清空）。

只有来自其他主机的 `http://` 明文图片（向导之外）会被浏览器拒绝，显示为裂图。规避方法：在浏览器中打开对应 Issue/PR 查看这些图片。

该 CSP 同时将 `connect-src` 限制为 webview 资源，但这没有用户可见影响：webview 不直接发起网络请求，一切都通过 postMessage 走扩展宿主。

## PR diff 无法显示重命名文件的旧路径

PR 级别的变更文件列表来自 `GET /repos/{owner}/{repo}/compare/{basehead}`（见上文「删除文件」条目）。该接口返回 Forgejo 的 `CommitAffectedFiles` 结构，只有 `filename` 与 `status` 两个字段，且 status 只有 `added`、`removed`、`modified` 三种取值——既没有 `previous_filename`，也从不报告 `renamed`。

因此重命名会表现为一对互不关联的 `removed` + `added` 记录；当同一区间内有多个文件增删时，扩展无法判断哪个删除项对应哪个新增项。这类文件的 base 侧会按新路径获取，diff 编辑器左侧因此显示为空。

规避方法：在 Forgejo 网页界面查看该重命名文件的 diff，或在本地检出 PR（`$ git diff -M` 可识别重命名）。按 commit 的对比以及 `/pulls/{index}/files` 路径会返回 `previous_filename`，不受影响。

## Forgejo 15（低于支持下限）缺少 Actions 子端点

支持下限是 Forgejo 16.0（见 README 兼容性一节）。扩展会读取 workflow 运行、job、job 日志与 artifacts，并支持取消或删除运行记录。Forgejo 15 只有 `GET /actions/runs` 与 `GET /actions/runs/{run_id}`；其余功能对应的接口（`/actions/runs/{run_id}/jobs`、`/artifacts`、`/actions/jobs/{job_id}/logs`、`/actions/runs/{run_id}/cancel`、`DELETE /actions/runs/{run_id}`）是 Forgejo 16 才加入的。

因此在 Forgejo 15 实例上，运行详情页不显示 job 和 artifact，日志查看、取消与删除操作都会返回 404。由于最低版本只是温和警告而非硬性阻断，这些功能仍会显示，只是在请求时失败。

规避方法：把实例升级到 Forgejo 16 或更高版本——这也是扩展实际验证的版本。

## 配置了 url.insteadOf 的仓库无法关联

`git remote -v` 与 `git remote get-url` 输出的是**应用 `url.<base>.insteadOf` 重写之后**的 URL。如果仓库的 remote 使用简写（例如把 `work:owner/repo.git` 重写到另一台主机），打印出来的主机就与任何已配置实例都不匹配。

结果是仓库无法被识别为已关联：Dashboard 不显示关联仓库、「发布到 Forgejo」按钮重新出现，且推送会被拦截——因为扩展拒绝把 access token 发往无法校验的主机。

规避方法：添加一个 URL 中原样包含实例主机的 remote，或反向配置重写（remote 中写完整的实例 URL，再为其他工具配置重写）。

## 大于 10 MiB 的文件无法通过 contents 接口读取

Forgejo 的 contents 接口不会返回超过 `[api] DEFAULT_MAX_BLOB_SIZE`（默认 10 MiB）的文件的正文：它会返回 `content: ""` 以及真实的 `size`，而不是报错；真正的空文件返回的 `size` 为 0。

扩展在所有通过该接口读取正文的地方都会区分这两种情况，改为给出一条说明（写出文件大小并指向浏览器）——包括 PR diff、仓库文件浏览器、仓库 README 预览与 MCP 的 file-content 工具——而不是把文件渲染成空文档。真正的空文件仍然以空文档打开。

规避方法：通过 Forgejo 网页界面或本地检出打开该文件。

## 列表最多返回 500 条，多数列表仍不提示被截断

分页列表接口在 500 条处停止，因此达到同一上限的列表仍可能不完整。只要服务端报告 `X-Total-Count`，数量就是精确的：客户端自己读取该响应头（`src/api/client.ts` 的 `_getListPage`，因为生成客户端只返回响应体），`*WithTotal` 方法再把它交给各视图与 MCP 工具，从而区分「刚好 500 条」和「还有更多的前 500 条」——包括一条总数恰好证明自己完整的 500 条列表。只有在不发送该响应头的实例上，扩展才退回长度启发式，无法区分这两种情况。

部分视图现在会在列表达到上限时给出提示：仓库 Issue 列表、仓库 PR 列表、分支 / 标签 / Release 三个页签、Issue 与 PR 时间线（评论）、变更文件列表、提交列表，以及仓库内文件搜索（它报告的是 git tree 过大而无法完整读取，而不是 500 条上限）。MCP 工具在「结果本身或它的一级字段」是被截断列表时，会在结果后追加 `(list truncated at 500 items: …)` 说明。

其余列表仍是静默展示，匹配项更多的仓库或账号会看到不完整列表却没有任何提示：仓库、标签分类、里程碑、Issue 依赖、表情回应、时间追踪与运行制品。通知线程是例外：通知视图用「加载更多」逐页读取，直到服务端返回空页，因此不会在上限处被截断。

「创建 PR」状态栏入口用服务端自己的分支过滤来回答同一个问题：它按 `head` 查询当前分支的开放 PR，并在命中所在的那一页停下，所以常见情况只需一次请求而不是最多十次，也不会产生警告。警告现在只覆盖更窄的情形：什么都没命中**且**列表确实在共享的 500 条上限处被截断时，入口才往 `Forgejo Toolkit` Output Channel 写一条记录——因为上限之外的 PR 会无法被发现，该入口仍可能为一个其实已有 PR 的分支显示「创建 PR」。这条警告很容易被忽略。

规避方法：用扩展提供的筛选条件或关键词搜索缩小范围，或改用 Forgejo 网页界面查看完整列表。

## `<vscode-tree>` 行内嵌套控件上的 Enter/Space 并非总能触发

`@vscode-elements/elements` 的树组件（2.5.1）会在宿主上监听 `keydown`，遇到 Enter 与 Space 时先对它聚焦的那个 tree item 调用 `stopPropagation()` + `preventDefault()`，然后才执行自己的选中逻辑。因此嵌套在该行里的 `<button>` 永远收不到浏览器默认的键盘激活：在它上面按 Enter 只会选中该行，而不会执行按钮。

扩展用树宿主上的捕获阶段监听绕开了这一点（`packages/forgejo-toolkit/webview/src/utils/treeRowActivation.ts`）：它在树自身的冒泡阶段监听之前运行，激活视图已声明的行（`data-tree-row-action`）或该行嵌套的控件，同时仍然阻止按键进入树的选中逻辑。方向键导航不受影响。该监听已接入 Dashboard、全局搜索、通知三个视图，以及文件浏览器的「再显示」行。

残留问题是刻意收窄的：只有当某一行被声明、且其所在视图接入了该监听时，该行里的嵌套控件才可键盘到达。视图未声明的行、以及完全未接入该监听的视图里的行，其嵌套控件仍然无法用键盘激活——因为本可以激活它的那个平台事件已被库消费掉。

规避方法：使用该行已有的右键菜单或键盘快捷方式（若有），或改用对应网页界面 / 鼠标。这是上游库行为，扩展无法从行内部改变它。

## 代理支持不解释 `no_proxy`，且各进程各读自己的配置

请求会走代理：编辑器的 `http.proxy` 设置优先于环境变量 `HTTPS_PROXY`/`https_proxy`、`HTTP_PROXY`/`http_proxy` 与 `ALL_PROXY`/`all_proxy`，取值会被规范化（`proxy.example.com:8080` 这种不带协议的写法也接受），不可用的取值会退化为直连并写一条日志。扩展会把该设置以 `FORGEJO_MCP_PROXY` 传给 MCP 服务进程；该进程除此之外只读环境变量，因为它在编辑器之外运行。注意 `no_proxy` 不会被解释：列在其中的主机仍会走代理——每个请求都发往用户自己配置的实例，静默绕过已配置的代理反而更难排查。

规避方法：把实例地址指向可直连的主机——例如在 Forgejo 前面放一个反向代理或隧道——或在具备直连网络的环境中运行编辑器。

## 工作树缓存清理会接管缓存目录下所有裸仓库

`forgejoToolkit.worktreeCacheDirectory` 接受任何可写目录，扩展把自己的裸克隆放在 `<cacheDir>/repos/*.git`，检出目录放在 `<cacheDir>/worktrees/*`。LRU 清理是惰性执行的——只在用缓存的克隆创建工作树时触发，没有定时器——它会把其中每个裸克隆目录都当成自己的：扩展从未使用过的克隆会在清理第一次看到它时被标记为「刚用过」，此后 30 天内再没被用到就会被删除；数量超过 20 个时最旧的会被删除。因此把该设置指向一个已经存放了无关裸克隆的目录，这些仓库就进入了这个清理节奏。

同一趟清理也会处理 `<cacheDir>/worktrees` 下的检出目录，但只限于扩展能证明是自己创建的那些：必须是直接子目录、没有被任何已记录的 worktree 引用、存在超过 30 天，并且是「源克隆已消失的链接检出」（`.git` 文件指向已被删除的 `<source>/.git/worktrees/<name>`）。真正的检出（`.git` 是目录——例如你自己放在那里的仓库）以及源克隆仍然存在的 worktree 永远不会被删除。完全没有 `.git` 条目的目录也不会被清理：清理无法把它与无关内容区分开，因此它会留在磁盘上，并且在 worktree 列表中始终不可见，直到你自己删除它（当扩展要用到的正是这样一个目录时，「开始处理 issue」会先询问再删除）。

规避方法：为该设置单独准备一个目录（默认位于扩展存储目录），或把自己维护的裸仓库放在 `<cacheDir>/repos` 之外。

## 通知轮询、版本探测与首次运行向导都在窗口之间协调

扩展会在每个 VS Code 窗口中激活。这是声明的 `onStartupFinished` 激活事件，它按窗口生效：我们在隔离 dev host 上实测，VS Code 并不会仅因扩展贡献了 `mcpServerDefinitionProviders` 就激活它（重载后始终没打开 Dashboard 时，运行中扩展列表里没有本扩展，MCP gateway 日志里也没有 Forgejo server，打开 Chat 的工具选择器前后都没有变化），所以要靠这个事件让 MCP server 在用户未先打开视图时也可被发现。上游报告 [microsoft/vscode#266221](https://github.com/microsoft/vscode/issues/266221) 描述的结论相反——贡献 MCP 定义会导致扩展在每个工作区都被激活——但无论哪种情况，这个事件对用户可见的代价都一样：每个窗口都会在启动时激活扩展。通知轮询通过 profile 的 globalStorage 里的一个租约文件协调：`forgejoToolkit.multiWindowLease` 开启时（默认即开启），持有租约的那个窗口轮询所有已配置实例并弹出提示。**意图**是你正在使用的窗口会申请并接管租约，因此提示跟着你的焦点走；我们在 Windows 11、同一 profile 的两个窗口上实测到这个意图**在同应用的窗口之间**是成立的：激活另一个窗口时，失去焦点的那个窗口**自己的**日志里会出现 `focus-lost` / `focus-gained reason=window-state`，而且两边落在**同一毫秒**（三次切换实测 0 ms / 8 ms / 11 ms），`focusedForMs` 属实，租约也确实跟着焦点走——持续聚焦超过去抖的 follower 发出请求后，不聚焦的持有者 **2.0 s** 后释放、claim 再晚 **0.01 s**（距它获得焦点 15.4 s；另一次独立复跑为 16.0 s）。焦点**事件**本身全程即时（16 次转换全部以 window-state 事件到达，没有一次需要按 tick 兜底读），早先记录的"最多晚约 6 s"没有复现——受 2 s tick 约束的是**换手**，不是事件。除这一形态外，焦点信号并不可信，而所有不可信的形态都倒向"不换手"这一侧：把持有租约的窗口**最小化**完全不会产生 `focus-lost`（它连续 44 s 仍读到 `focused=1`，直到另一个窗口被激活才失去焦点）；把**另一个应用**放到前台的那一次实测同样没有产生，而另外两次前台被夺走的实测产生了；同一 profile 的两个窗口可以在第二个窗口打开后的最初约 73 s 里**都报 `focused`**；**锁屏**则从锁定到解锁都不报 `focus-lost`——持有者保持 `focused=1`，10 s 心跳（实测间隔 10.02–10.05 s）与 2 s tick 都没有节流，在没人能操作期间不会发生任何换手。正因为方向如此，现任会继续持有、继续轮询，什么都不丢，只是提示留在租约所在的那个窗口、不跟随焦点。（第二台显示器的形态是更早一轮实测的，不是本轮；本机只有一块屏幕。）焦点不可信时，正确的结果是**完全不换手**：现任继续持有、继续轮询，什么都不丢，只是提示留在租约所在的那个窗口、不跟随焦点。其余窗口不轮询、也不自动弹提示，但你手动打开通知视图时会即时读取；而协调机制的任何失败都会退化为「每个窗口各自轮询」，所以通知不会静默停止。

版本探测现在也共享：首个探测的窗口把每个实例的版本记在实例列表旁（profile 全局状态里紧挨实例列表的位置），其它窗口在记录仍然新鲜时（约一分钟）直接复用它，不再各自发 HTTP 请求——记录新鲜期间全机每个实例只探测一次；记录过期后由一个窗口重新探测并把结果写回。首次运行的设置向导也按同样的方式协调，但只在一份 offer 还在飞行中时生效：在 profile 的 globalStorage 里创建短命 offer token 的那个窗口打开向导，其余窗口在这份 offer 仍然可信（创建它的窗口仍在运行、token 仍然新鲜）时保持安静。让向导永久不再出现的仍然是全局状态里的「已展示过」标记，它在向导走完或已存在实例时写入——因此没有配置实例的 profile 仍会继续提供向导，与之前完全一样。

规避方法：不需要。想让每个窗口重新各自轮询并弹出提示，把 `forgejoToolkit.multiWindowLease` 关掉即可——设置立即生效，无需重载窗口。想进一步减少请求量，可调大 `forgejoToolkit.notificationPollingInterval`，或用 `forgejoToolkit.notificationPollingEnabled` 关闭轮询。若某个窗口上该协调机制不可用（profile 目录不可写、磁盘只读），该窗口会自行轮询并提示一次，该提示可以直接复制诊断信息，或为**本窗口**关闭该设置——否则通知不会丢失，只是请求更多。共享的版本探测记录不受该设置控制：它存放在实例列表旁，所以无论该设置如何，各窗口都会继续复用它。

## 不提供删除他人计时记录的入口

`DELETE /repos/{owner}/{repo}/issues/{index}/times/{id}` 只接受该记录的本人或站点管理员——仓库管理员不够。计时面板只在能确认属于当前登录用户的行上保留删除按钮，其余行隐藏，因为这些请求只会得到 403。因此站点管理员也无法从扩展删除他人的计时记录，尽管 API 允许。

规避方法：通过 Forgejo 网页界面删除，网页端知道当前账号是否站点管理员。

## Agents 窗口（Agent Host）的会话看不到扩展贡献的 MCP server

扩展通过 `mcpServerDefinitionProviders` 贡献的 MCP server 只会被普通窗口里 VS Code 内置聊天消费。Agents 窗口的会话运行在 Agent Host 上，它的 MCP 配置从 `mcp.json` 文件发现——扩展的注册永远不会到达那里。`agentsWindow` 能力也帮不上：它只控制扩展自身能否在那个窗口运行。这是 VS Code 的平台限制，扩展侧无法通过声明绕过。

规避方法：用一份静态 `mcp.json` 指向扩展在 globalStorage 里维护的 shim（见 FAQ「Agents 窗口里能用这个 MCP server 吗？」）。扩展宿主运行期间，broker 会把该 server 经本地管道转发给扩展，认证工具在那里也可用、token 不落盘；扩展宿主不在时降级为匿名只读（仅公开数据）。

## 同一时间只有一个窗口能持有 MCP broker

该 broker 在一个用户 profile 上只绑定一个端点，因此同时只有一个窗口能提供服务：最先启动的窗口持有它，之后启动的窗口静默让位、不写自己的注册文件（让位只记在 debug 日志里，打开 `forgejoToolkit.debug` 才能看到）。让位后的窗口并不会就此放弃：它每隔几秒读一次注册文件，并检查其中记录的 pid 是否仍然存活，因此一旦持有者消失，它就会自己绑定该端点——无论持有者是正常关闭（`deactivate()` 已删除注册文件）还是被强杀（文件残留、其中的进程号已死）。接管是全自动的，不需要重载窗口；完成接管的窗口会用自己的实时 pid 重新写注册、打印 `MCP broker listening at …`，从 `mcp.json` 启动的 shim 无需任何客户端改动即可连上它。这里刻意没有文件锁、也没有选举协议——让位的窗口只是去尝试绑定，`listen` 成功的那一个就是持有者。同一用户的两个 profile 也共享该端点，因为它由用户名与主目录派生，而不是按 profile 区分。

接管无法挽救的是持有者死亡时**已经在运行**的那个会话：它的 forwarder 会丢失连接、写一条 info 日志后退出，因此那一个 MCP 会话就此结束。重新启动该会话即可经新的持有者转发——通常在接管完成后几秒内恢复——此后静态 shim 路径重新回到已认证状态。

规避方法：不需要。若刚才的会话因此结束，重新启动它即可；不想等这几秒的话，重载窗口或把 `forgejoToolkit.mcpEnabled` 关掉再打开可立即完成绑定。

## 普通窗口里由扩展贡献的 MCP server 现在依赖 broker

扩展提供的 MCP server 定义**不携带任何 access token**，这是刻意的：VS Code 会把每个已注册定义的完整内容（含 `env`）持久化到 profile 的 workspace storage，把 token 放进去就等于把一个明文秘密落在 SecretStorage 旁边的磁盘上。因此定义里只写"是哪个实例"，VS Code 启动的进程则转发到静态 `mcp.json` 路由所用的同一个本地 broker，token 从 SecretStorage 读出、始终留在扩展宿主进程内。

代价是：当 broker 不可达时，扩展在那次解析中**不发布**任何 MCP server，并写一条日志（`MCP server definitions withheld: the extension-host broker is not running…`），而不是注册一个"客户端以为已认证、实际匿名"的 server。实际上这是一个很窄的窗口——注册 provider 的正是启动 broker 的那次激活，而客户端在其后才解析 server——但如果某个窗口的 profile 无法承载 broker（globalStorage 目录不可写、端点被占用），编辑器内的 Forgejo MCP server 就不会出现。

规避方法：正常情况下不需要。若日志显示定义被扣下，检查扩展的 globalStorage 目录是否可写并重载窗口；静态 `mcp.json` 路由（shim）仍然可用，且在没有扩展窗口运行时照旧降级为匿名只读。你自己写的启动配置也仍可自带 `FORGEJO_MCP_TOKEN`，那条路径没有变化——但那样 token 就以明文落在你自己的文件里，这是你自己的选择。

## `API_REQUEST_TIMEOUT_MS` 约束的是每页请求，而不是整次分页读取

扩展读取分页列表时每页各发一次 HTTP 请求，而 `API_REQUEST_TIMEOUT_MS`（30 s）约束的是这其中每一次请求，不是整次读取：分页辅助按页依次发请求，每页的超时各自重新计时。所以一次读到共享的 500 条上限的分页读取在慢实例上累计可能持续数分钟（约 10 页 × 30 s），而单次请求并不会超时。

规避方法：需要整体上限的调用方必须自己传 `AbortSignal`；扩展自身的列表命令不设这一上限。

## 两个 VS Code 窗口同时启动时可能重复探测一次版本

实例的 Forgejo 版本全机只探测一次并在窗口间共享；发现别的窗口正在探测时，本窗口会等它的结果，而不是自己再发一次请求。偶尔——两个窗口在同一瞬间都决定探测时——两边仍会各发一次请求。

原因：共享记录放在 VS Code 的 `globalState` 里，它没有原子的读-改-写，也没有跨窗口变更事件，所以"别人在探测吗"与"现在我来探测"无法合成一个不可分割的步骤。这个重复是**有意保留**的：漏判的代价只是一次无害的只读请求，而把它做成权威判定，则可能让功能闸门依赖一条从未落盘的记录。

规避方法：不需要——只是多发一次 `/api/v1/version` 请求，"实例版本过旧"的提示仍然只弹一次，所有功能行为完全一致。

## 设置项名称无法翻译

设置编辑器给设置项显示的标题是**按设置 ID 推导**出来的，不会用 `contributes.configuration.properties` 里声明的 `title`。所以无论界面语言是什么，`forgejoToolkit.aiPreReview` 都显示为 **Forgejo Toolkit: Ai Pre Review**（英文，而且推导规则把 `ai` 拆成了 `Ai`），只有描述是翻译过的——`package.nls.zh-cn.json` 里其实已经写好了它的中文名。

原因：该字段会被解析进一个不对设置模型暴露的内部属性，编辑器只认那个内部值（[microsoft/vscode#191807](https://github.com/microsoft/vscode/issues/191807)，仍开着并已指派给设置编辑器团队；更早的 "Names of settings not translated"，[microsoft/vscode#150891](https://github.com/microsoft/vscode/issues/150891)，已于 2024 年 12 月以 _not planned_ 关闭）。今天没有任何 manifest 字段能改掉推导出来的标题，而改设置 ID 这条路不可行：用户已有的 `settings.json`、本扩展自己的文档与提示文案都按这个 ID 写。

规避方法：标题本身无解。本项目新增的设置项照样把名称写进 `package.nls.json` 与 `package.nls.zh-cn.json`，等 VS Code 支持该字段时立刻生效；在那之前，设置项的**描述**是正常翻译的，而布尔设置项在复选框旁显示给用户的正是描述。用 `enum` + `enumDescriptions` 贡献的设置项是唯一做得更好的一类：枚举每个取值的说明由编辑器自己从 nls 对里取，所以即使名称没被翻译，`forgejoToolkit.aiPreReviewPromptScope` 那五条取值说明也是翻译过的。

## AI 预评审从响应的 stream part 里取回答，而不是从 `text` 取

有些聊天模型提供者把模型的回答放在响应的 **part** 里，而通过 `LanguageModelChatResponse.text` 交出来的是别的东西。在维护者机器上，那个投影是模型的**推理 token 流**，不是回答：debug 探测里那条标点敏感的「回声」形态要求照抄 27 字符的字面量 `{"a":"b,c\"d\\e","f":[1,2]}`，`text` 交出的是 12 字符的碎片 `{"":",cdef12`，而响应的文本 part 拼起来**逐字节等于**那个字面量。

扩展早先的版本用不上这一点：它们解析 `text`，于是在这类提供者上每次预评审都以「回答不是 JSON」失败、什么都不创建，而且每次运行要问两遍（对用户选定的那一个模型的有界重试）。这里原本把该失败记成「提供者从回答里删字符」，那个说法是错的：没有任何东西被删掉，活下来的字符只是推理轨迹里恰好出现过的那些，而真正的回答完好地在另一股上。同一次响应里实测到**两股候选流**——文本 part 与推理 part；同一条提供者路径被它的多个模型共用，所以原来那条「换一个提供者的模型」的建议也不是解法。

扩展现在的做法：**只消费一次**响应的 stream，从它的 part 里取回答，优先取**文本 part**；文本 part 缺失、或过不了 JSON 契约时，再取**推理 part**；只有两股都拿不出可用回答时，才回落到 `text` 投影。无论哪一股胜出，运行都会在 debug 级别写明是哪一股，诊断 dump 也会把两股候选**分别标注**记录下来。两股候选绝不拼接，候选绝不被修补，也绝不替换成另一个模型。

两股都拿不出合法回答时用户看到什么：预评审照旧报出失败的模型、尝试次数，以及它检查过的那份回答的一段有界摘录；什么都不创建，JSON 契约、锚点校验与重试上限都不变。自查本机的方法：打开 `forgejoToolkit.debug` 与 `forgejoToolkit.aiPreReview`，运行 `forgejoToolkit.aiPreReviewProbeChatModels`（它只问 `forgejoToolkit.aiPreReviewModel` 里点名的那个模型，共四次平凡调用，不含任何仓库内容），再用 `forgejoToolkit.aiPreReviewOpenDiagnostics` 打开诊断文件，读 `echo: one user message, punctuation-sensitive` 这条判词。判词会写明它判的是哪一股候选流；判词不是 `true`，就说明那台机器的 part 通道没有携带期望的字面量。

在维护者机器上进行的一次验收运行第一次走到了确认这一步，也正是这次运行暴露了它被重做的原因：当时用的多选 quick pick 把每条评论的**正文塞在 label 里**，而 VS Code 会截断 label，既没有 `description` 也没有 `tooltip` 放剩下的部分——所以用户根本读不到自己正要接受的那条评论。确认这一步现在是一个编辑器标签页面板（`AiPreReviewPanel`），每条候选一张卡片、正文完整呈现，因此阅读是能做到的；旧实现那句「一份让人逐条读的清单」不该再被用来描述它。

当时对 quick pick 成立的那些保证依然成立，而且现在它们就是全部、不再是"只成立一半"：不预选任何一条，扩展也**不贡献任何「全部接受」控件**——既没有按钮，也没有预先勾上的框。平台层的「切换所有复选框」属于 VS Code 自己的多选 quick pick，而本面板不使用它，所以面板上线后屏幕上不存在任何"一键全部接受"的入口。旧实现还有一条性质，这里继续按验证笔记记录：锚点校验失败的意见永远到不了清单，现在也永远到不了面板——但那次验收运行里它只是成立而**没有被实际走到**（模型只提了两条意见、两条都通过了校验，所以没有任何候选被丢弃），因此它仍然只由测试保证，还没有观察到过真实的丢弃。

这次验收运行的其余部分把通道处理端到端验证了一遍：探测再次回答 `true`，这次运行的答案来自**文本**候选（不是推理 part，也不是 `text` 投影），在确认之后恰好创建了**一条 PENDING 评审**（带着这些评论），并且**没有提交任何东西**。

## 从评论线程发出的回复由 PR 时间线回显进该线程

在 diff 编辑器里回复一条评审评论，发出的是一条普通的 PR 评论（issue 层的评论端点）——它**不是** Forgejo 网页端自己回复时的那次写入（那次发的是带 `origin=timeline` 的评审评论），但同样落在时间线上。发成普通评论正是它**立即**出现在 PR 时间线里、无需提交任何评审的原因；也正是因此，渲染**评审**评论的 diff 线程无法从评审接口拿回这条回复：在 Forgejo 上评审评论与时间线评论是两种不同的对象，没有任何一次评审读取会把回复当作线程的一部分返回。

现在用户看到的是：POST 成功后，扩展会把这条回复追加到它被写出的那个线程的评论下面，带 **已发布到该 Pull Request 的时间线** 标记、只读；POST 成功时扩展也会提示「回复已作为评论发布到该 Pull Request 的时间线。」。回复本身仍是一条普通的时间线评论，在 PR 上对所有人可见（Forgejo 网页端，或本扩展的 PR 详情页）——而且因为线程的回显是**每次渲染都从 PR 的时间线重新推导**的，窗口重载后它仍然在那个线程里。在别处写出的回复（Forgejo 网页端、手机）也会出现在线程里，因为扩展读的是它们的引用归属行（`@user wrote in <url>:`），而不是要求这条回复必须从 VS Code 发出。

代价在于：每次渲染一个 PR 的线程时，只要它至少有一条评论可以挂，就会顺带读一次这个 PR 的**时间线**（每个渲染过程一次请求，缓存几秒、该 PR 的所有已打开文件共用；一条能挂的评论都没有的文件则一次都不发）。这次读取走的就是 PR 详情页用的那个时间线调用，因此按共享的 500 条列表上限分页——时间线长于这个上限时，超出的回复不会被推导出来。回显仍然只是服务端数据之上的渲染辅助：不会被写回、不会被重发、不参与计数，不是服务端的评审评论，也不改变线程对服务端内容的任何判断。

为什么改成从服务端推导而不是记住：本地记住的回显只活一次扩展会话，窗口重载就没了，而回复自始至终都在服务端上。早先那版试过的替代方案——把回复放进用户的待提交评审——正是被取代的那个缺陷：回复会一直不可见，直到用户提交那次评审并选一个结论（`COMMENT` / `APPROVE` / `REQUEST_CHANGES`），于是一句对话式的回答变成了评审内容，而且要和 AI 预评审的草稿共用同一个待提交评审位。把回复再以真正的评审评论发一遍则会重复出现，并多出一条用户从未写过的评论。

剩下两处空档的绕过办法：正文里的引用归属行被手工编辑掉的回复无法匹配回它所回答的评论；超出时间线 500 条读取范围的回复也看不到。这两种情况下打开 PR 的**对话**视图（或本扩展的 PR 详情页）就能看到这条回复。

## 实例首页活动流的一行只显示评论正文的第一行

实例首页活动流并不渲染评论正文：它渲染的是**活动行上存的摘要**，而这个摘要就是评论正文的**第一行**（按 `\n` 切分，超过约 190 字符硬截断并加 `…`）。因此，一条以"引用被回复评论"开头的回复——也就是 Forgejo 网页端自己的「引用回复」写出来的形状——在活动流那一行里显示的是那段引用，而用户真正写的话在引用下面，在那里根本不会出现。这是活动流那一行的显示限制，不是评论被截断：完整回复始终在 PR 时间线上，其他所有会读评论正文的地方读到的也都是完整的。

在本项目的实例上实测（PR 的活动流接口）：活动行 580 对应一条以引用开头的时间线回复，它只存了正文第一行（`> @user wrote in …:`）；活动行 582 对应一条在 Forgejo 网页端发出的回复，只存了它的归属行（`@user wrote in …:`）；活动行 581 对应一条正文里根本没有引用的回复，存的就是那段文字。所以平台自己的引用回复在那里读起来同样是它的引用或归属行。

为什么这里不修：摘要是服务端在创建活动行时写入的，活动流模板渲染的是这个摘要而不是评论正文，所以 API 客户端把评论正文写成什么形状都改变不了那一行摘要的取法。它还是写入那一刻的快照：之后编辑评论不会刷新它，也没有任何东西能让它改取后面某一行、或者丢掉引用。扩展自己的回复因此改成配合它：把你的话放在正文第一行，于是活动流那一行显示的就是你自己写的话，引用排在后面。

在 Forgejo 网页端回复时的绕过办法：发之前把回答写到引用块上面（编辑器预填的是引用在前），或者到 PR 时间线上读这条回复——完整正文永远在那里。

---

_各 API 端点与 Forgejo 服务端源码的核对细节，参见 [`docs/api-verification-checklist.md`](docs/api-verification-checklist.md)。_
