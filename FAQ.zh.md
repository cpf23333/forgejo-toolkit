# 常见问题

## 一般问题

### Forgejo Toolkit 是什么？

Forgejo Toolkit 是一个用于 [Forgejo](https://forgejo.org/) 和 Codeberg 的 VS Code 扩展。它提供基于 Webview 的仪表盘、仓库浏览、Issue / PR 管理以及 PR worktree 支持，无需离开 VS Code。

### 是否支持 Gitea？

Forgejo 和 Gitea 有共同的 API 历史，因此许多功能在 Gitea 实例上也能运行。但本扩展仅针对 Forgejo 进行测试；Gitea 兼容性尽力而为。

## 设置

### 需要什么样的 access token 权限？

在 Forgejo 个人资料设置中创建 token，并至少授予以下权限：

- `repo` — 读取仓库、提交、分支、标签和 Release。
- `issue` — 读取和写入 Issue。
- `pull_request` — 读取和写入 Pull Request。
- `attachment` — 为 Issue / PR 上传附件。

### 我的 token 存在哪里？

Token 存储在 VS Code 内置的 `SecretStorage` 中，该存储使用操作系统的钥匙串或凭据管理器。

### 可以管理多个 Forgejo 实例吗？

可以。从 Dashboard 打开设置页面，按需添加实例。每个实例使用独立的 token。

## 功能

### 为什么文件树不显示图标？

请确保 `codicon.css` 已在 webview 中加载。扩展会自动注册所需样式表。如果图标仍然缺失，请检查开发者工具控制台中的网络错误。

### 为什么 PR diff 编辑器不显示 M/R 徽章？

VS Code 的 diff 编辑器在虚拟文件系统的标题区域不会暴露新增/修改/删除徽章。这是 [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) 中记录的已知限制。

### 创建 Release 时可以上传附件吗？

可以。在新建 Release 弹窗中直接选择文件即可；扩展会先创建 Release，然后自动上传排队的附件。如果部分附件上传失败，只有失败的文件会保留在队列中，方便你重试。

### 为什么 worktree 缓存目录可以配置？

PR worktree 会被检出到一个缓存目录以便复用。如果默认位置不方便，你可以在设置中更改该目录。

## MCP Server

### 为什么在「MCP: List Servers」里看不到 Forgejo 实例？

MCP Server 只有在满足以下全部条件时才会注册：

- VS Code 版本为 1.102 或更高。
- 扩展中至少配置了一个 Forgejo 实例。
- 该实例保存了 access token。

任一条件不满足时扩展会静默跳过注册——请先检查这三点。

### AI agent 能通过这个插件修改我的仓库吗？

不能。目前全部 MCP 工具均为只读（`readOnlyHint`），agent 可以查询 Issue、PR、Actions 运行记录和代码，但无法改动任何数据。写操作工具未来可能以「默认关闭、逐项开启」的方式提供。此外，VS Code 会在每次工具调用前向你确认，未经你批准不会执行任何操作。

## 故障排除

### 点击仓库没有反应

请检查 `Forgejo Toolkit` 输出通道中的错误。常见原因包括：

- token 无效或已过期。
- 网络错误，无法连接到 Forgejo 实例。
- 缺少仓库权限。

### Dashboard 一片空白

打开 VS Code 开发者工具，查看是否有 JavaScript 错误。常见原因包括消息初始化失败或首次渲染时的运行时错误。

## 贡献

请参阅 [CONTRIBUTING.md](./CONTRIBUTING.md) 了解开发环境和贡献指南。如需报告 bug 或提问，请访问 [Codeberg Issues](https://codeberg.org/cpf23333/forgejo-toolkit/issues)。
