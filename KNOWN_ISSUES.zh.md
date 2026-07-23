# 已知问题

## PR 附件需要从 Issue API 获取

Forgejo 的 `GET /repos/{owner}/{repo}/pulls/{index}` 接口**不会**返回 `assets`/`attachments` 字段，即使网页界面显示了附件。不过，底层 PR 也可以通过 `GET /repos/{owner}/{repo}/issues/{index}` 作为 issue 访问，而这个接口**会**返回 `assets`。

为了在详情页显示 PR 附件，`ForgejoClient.getPullRequestDetail` 目前会同时发起两个请求，并把 issue 响应中的 `assets` 数组合并到 PR 详情里。这是一个 workaround，如果 Forgejo 将来改变 PR 和 issue 的关系，可能会失效。

理想情况下，Forgejo 应该直接在 pull request 响应中包含 `assets`，或者为 PR 提供独立的附件接口。

## Markdown 中的图片附件需要扩展宿主代理

Forgejo 附件 URL（例如 `/attachments/{uuid}`）需要认证。VS Code webview 无法与扩展宿主共享 cookie，所以直接指向 Forgejo 的 `<img>` 标签会被重定向到登录页，导致图片无法渲染。

扩展目前的 workaround 是：使用存储的 access token 在扩展宿主中获取渲染后的 Markdown HTML 里的每张图片，将其转换为 `data:` URL，并在返回 HTML 给 webview 之前替换原始的 `src`。

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
