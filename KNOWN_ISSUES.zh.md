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

未来可以考虑增加按提交查看 diff 的模式，以展示每个单独提交引入的变更（参见 TODO.md / ROADMAP.md）。

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

因此扩展只为正在运行的记录提供「取消运行」按钮，不提供「重新运行」按钮。如果工作流支持 `workflow_dispatch`，用户可以通过「触发 workflow」按钮再次手动触发。

## PR diff 行级评论无法通过行号旁的 + 图标创建

VS Code 稳定版 Comments API 没有暴露 `CommentController.onDidCreateCommentThread`，因此扩展无法捕获用户在 diff 编辑器行号旁点击 `+` 图标的动作。如果启用该按钮，只会显示一个无法提交的评论输入框，反而造成误导。

因此新增 PR 审阅评论改通过编辑器右键菜单命令 **Add Pull Review Comment** 触发；已有评论仍会作为 `CommentThread` 渲染在对应的 base/head 行上。这是稳定版 VS Code API 的限制，短期内没有 workaround。

## 项目看板未在 REST API 中暴露

Forgejo 网页界面为仓库和组织提供了项目看板功能，包括创建项目、管理列、把 Issue 分配到项目等。但官方 v1 REST API 没有暴露任何 `/projects` 端点。

API 中唯一与项目相关的字段只有：

- 仓库设置里的 `has_projects`，仅用于控制是否启用项目单元。
- `TimelineComment` 里的 `project_id` / `old_project_id`，仅在 Issue 被移动项目时作为时间线事件记录。

目前没有接口可以列出、创建、更新、删除项目，也没有接口可以把 Issue 分配到项目或从项目移除。因此扩展无法提供项目看板功能。

这是 Forgejo API 本身的限制。要实现项目看板支持，需要 Forgejo 在 v1 REST API 中增加专门的项目端点。

---

_各 API 端点与 Forgejo 服务端源码的核对细节，参见 [`docs/api-verification-checklist.md`](docs/api-verification-checklist.md)。_
