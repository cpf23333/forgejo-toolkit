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

分页列表接口在 500 条处停止。长度正好为 500 的列表可能并不完整：生成客户端不透出承载总数的响应头，扩展无法区分「刚好 500 条」和「前 500 条」。

部分视图现在会在列表达到上限时给出提示：仓库 Issue 列表、仓库 PR 列表、分支 / 标签 / Release 三个页签、Issue 与 PR 时间线（评论）、变更文件列表、提交列表，以及仓库内文件搜索（它报告的是 git tree 过大而无法完整读取，而不是 500 条上限）。MCP 工具在「结果本身或它的一级字段」是被截断列表时，会在结果后追加 `(list truncated at 500 items: …)` 说明。

其余列表仍是静默展示，匹配项更多的仓库或账号会看到不完整列表却没有任何提示：仓库、标签分类、里程碑、Issue 依赖、表情回应、时间追踪与运行制品。通知线程是例外：通知视图用「加载更多」逐页读取，直到服务端返回空页，因此不会在上限处被截断。

「创建 PR」状态栏入口是个特例：它为了回答「当前分支是否已有 PR」会把打开中的 PR 列表一直读到共享的 500 条上限（最多约 10 次请求），达到上限时往 `Forgejo Toolkit` Output Channel 写一条警告。位于上限之外的 PR 无法被发现，因此该入口仍可能为一个其实已有 PR 的分支显示「创建 PR」；这条警告是唯一的信号，很容易被忽略。

规避方法：用扩展提供的筛选条件或关键词搜索缩小范围，或改用 Forgejo 网页界面查看完整列表。

## 代理支持不解释 `no_proxy`，且各进程各读自己的配置

请求会走代理：编辑器的 `http.proxy` 设置优先于环境变量 `HTTPS_PROXY`/`https_proxy`、`HTTP_PROXY`/`http_proxy` 与 `ALL_PROXY`/`all_proxy`，取值会被规范化（`proxy.example.com:8080` 这种不带协议的写法也接受），不可用的取值会退化为直连并写一条日志。扩展会把该设置以 `FORGEJO_MCP_PROXY` 传给 MCP 服务进程；该进程除此之外只读环境变量，因为它在编辑器之外运行。注意 `no_proxy` 不会被解释：列在其中的主机仍会走代理——每个请求都发往用户自己配置的实例，静默绕过已配置的代理反而更难排查。

规避方法：把实例地址指向可直连的主机——例如在 Forgejo 前面放一个反向代理或隧道——或在具备直连网络的环境中运行编辑器。

## 工作树缓存清理会接管缓存目录下所有裸仓库

`forgejoToolkit.worktreeCacheDirectory` 接受任何可写目录，扩展把自己的裸克隆放在 `<cacheDir>/repos/*.git`，检出目录放在 `<cacheDir>/worktrees/*`。LRU 清理是惰性执行的——只在用缓存的克隆创建工作树时触发，没有定时器——它会把其中每个裸克隆目录都当成自己的：扩展从未使用过的克隆会在清理第一次看到它时被标记为「刚用过」，此后 30 天内再没被用到就会被删除；数量超过 20 个时最旧的会被删除。因此把该设置指向一个已经存放了无关裸克隆的目录，这些仓库就进入了这个清理节奏。

同一趟清理也会处理 `<cacheDir>/worktrees` 下的检出目录，但只限于扩展能证明是自己创建的那些：必须是直接子目录、没有被任何已记录的 worktree 引用、存在超过 30 天，并且是「源克隆已消失的链接检出」（`.git` 文件指向已被删除的 `<source>/.git/worktrees/<name>`）。真正的检出（`.git` 是目录——例如你自己放在那里的仓库）以及源克隆仍然存在的 worktree 永远不会被删除。完全没有 `.git` 条目的目录也不会被清理：清理无法把它与无关内容区分开，因此它会留在磁盘上，并且在 worktree 列表中始终不可见，直到你自己删除它（当扩展要用到的正是这样一个目录时，「开始处理 issue」会先询问再删除）。

规避方法：为该设置单独准备一个目录（默认位于扩展存储目录），或把自己维护的裸仓库放在 `<cacheDir>/repos` 之外。

## 每个窗口都会各自轮询和探测各个实例

扩展会在每个 VS Code 窗口中激活（为了让 MCP 服务器可被发现而必需的 `onStartupFinished` 激活事件是按窗口生效的）。因此每个窗口都会为所有已配置实例各自运行通知轮询，并通过 HTTP 探测其服务端版本；打开多个窗口时，每个实例会被轮询多次，同一条新通知也可能在每个窗口各弹一次提示。「首次运行的设置向导」同理：它记录「已展示过」的标记存放在全局状态中，读取与写入不是原子的，因此在全新安装时同时恢复的多个窗口可能各自打开一次该面板。

规避方法：减少启用该扩展的窗口数量、调大 `forgejoToolkit.notificationPollingInterval`，或用 `forgejoToolkit.notificationPollingEnabled` 关闭轮询。

## 不提供删除他人计时记录的入口

`DELETE /repos/{owner}/{repo}/issues/{index}/times/{id}` 只接受该记录的本人或站点管理员——仓库管理员不够。计时面板只在能确认属于当前登录用户的行上保留删除按钮，其余行隐藏，因为这些请求只会得到 403。因此站点管理员也无法从扩展删除他人的计时记录，尽管 API 允许。

规避方法：通过 Forgejo 网页界面删除，网页端知道当前账号是否站点管理员。

## Agents 窗口（Agent Host）的会话看不到扩展贡献的 MCP server

扩展通过 `mcpServerDefinitionProviders` 贡献的 MCP server 只会被普通窗口里 VS Code 内置聊天消费。Agents 窗口的会话运行在 Agent Host 上，它的 MCP 配置从 `mcp.json` 文件发现——扩展的注册永远不会到达那里。`agentsWindow` 能力也帮不上：它只控制扩展自身能否在那个窗口运行。这是 VS Code 的平台限制，扩展侧无法通过声明绕过。

规避方法：用一份静态 `mcp.json` 指向扩展在 globalStorage 里维护的 shim（见 FAQ「Agents 窗口里能用这个 MCP server 吗？」）。扩展宿主运行期间，broker 会把该 server 经本地管道转发给扩展，认证工具在那里也可用、token 不落盘；扩展宿主不在时降级为匿名只读（仅公开数据）。

---

_各 API 端点与 Forgejo 服务端源码的核对细节，参见 [`docs/api-verification-checklist.md`](docs/api-verification-checklist.md)。_
