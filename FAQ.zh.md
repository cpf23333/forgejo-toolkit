# 常见问题

## 一般问题

### Forgejo Toolkit 是什么？

Forgejo Toolkit 是一个用于 [Forgejo](https://forgejo.org/) 和 Codeberg 的 VS Code 扩展。它提供基于 Webview 的仪表盘、仓库浏览、Issue / PR 管理以及 PR worktree 支持，无需离开 VS Code。

### 是否支持 Gitea？

Forgejo 和 Gitea 有共同的 API 历史，因此许多功能在 Gitea 实例上也能运行。但本扩展仅针对 Forgejo 进行测试；Gitea 兼容性尽力而为。

## 设置

### 需要什么样的 access token 权限？

在 Forgejo 个人资料设置中创建 token，至少授予以下读取权限：

- `read:user` — 账号信息、用户搜索、时间追踪。
- `read:repository` — 仓库、文件、Pull Request、评审、CI、Release。
- `read:issue` — Issue、评论、标签、里程碑。
- `read:notification` — 通知轮询。

需要创建或编辑内容时，再补上对应的写入权限（`write:repository`、`write:issue`、`write:notification`）。Forgejo 没有 `pull_request` 权限：Pull Request 相关端点归属 repository 类别。设置表单中列出的权限与此一致。

### 我的 token 存在哪里？

Token 存储在 VS Code 内置的 `SecretStorage` 中，该存储使用操作系统的钥匙串或凭据管理器。

### 可以管理多个 Forgejo 实例吗？

可以。从 Dashboard 打开设置页面，按需添加实例。每个实例使用独立的 token。

## 功能

### 为什么文件树不显示图标？

请确保 `codicon.css` 已在 webview 中加载。扩展会自动注册所需样式表。如果图标仍然缺失，请检查开发者工具控制台中的网络错误。

### 为什么 PR diff 编辑器不显示 M/R 徽章？

VS Code 的 diff 编辑器对新增文件会原生显示 **A** 徽章、删除文件会原生显示 **D** 徽章，因为 diff 的一侧为空。修改或重命名文件的 **M**/**R** 徽章通常由内置 Git 扩展解析，而这要求仓库已经作为工作区文件夹打开；没有本地 checkout 直接查看时，diff 的两侧仍会正确渲染，但文件名旁不会显示 **M**/**R** 徽章。这是 [KNOWN_ISSUES.zh.md](./KNOWN_ISSUES.zh.md) 中记录的已知限制。

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

不能。目前全部 MCP 工具均为只读（`readOnlyHint`），agent 可以查询 Issue、PR、Actions 运行记录和代码，但无法改动任何数据。写操作工具未来可能以「默认关闭、逐项开启」的方式提供。注意：VS Code 对只读工具**不会**在调用前弹确认框，因此保证来自工具面本身——每个工具都是 `GET`（唯一例外是 `get_workspace_repository`，它只读取扩展在本地发布的状态文件），且会进入请求路径的输入都做了校验，构造参数无法跳到其他接口。

### 「配置模型访问」对本扩展的 MCP server 有什么作用？

目前没有作用。这个菜单项是 VS Code 对所有 MCP server 统一显示的，控制的是 server 通过 MCP _采样_（sampling，由 server 主动发起的模型调用）可以使用哪些模型。本扩展的 server 从不发起采样——它只提供只读工具调用——所以该设置对它没有实际效果。

### Agents 窗口里能用这个 MCP server 吗？

不能通过扩展的贡献来使用：VS Code 不会在 Agents 窗口（Agent Host）会话中解析扩展贡献的 MCP server——这是平台限制，也是扩展不声明 `agentsWindow` 能力的原因。可行的做法是用一份静态 MCP 配置指向扩展在 globalStorage 里维护的 shim：

```json
{
  "servers": {
    "forgejo": {
      "command": "node",
      "args": ["%APPDATA%\\Code\\User\\globalStorage\\cpf23333.forgejo-toolkit\\mcp-server.js"]
    }
  }
}
```

（macOS 上目录是 `~/Library/Application Support/Code/User/globalStorage/cpf23333.forgejo-toolkit`，Linux 上是 `~/.config/Code/User/globalStorage/cpf23333.forgejo-toolkit`；Insiders 版本把 `Code` 换成 `Code - Insiders`。）这段配置放在哪里：推荐用户级 `<profile>/User/mcp.json`（VS Code 的注册表——对当前 profile 的所有工作区生效，并会转发给 Agent Host 会话）；工作区 `.vscode/mcp.json` 只对单个工作区生效。工作区根目录的 `.mcp.json` 只有 Agent Host 原生读——VS Code 会忽略它，而工作树隔离的会话根本看不到它。可以手动写文件，也可以运行 **Forgejo Toolkit: 为 Agents 窗口复制 MCP 配置** 命令，把片段合并进用户级 `mcp.json`、工作区 `.vscode/mcp.json`，或复制到剪贴板。路径是 shim `mcp-server.js` 而不是带版本号的安装目录：扩展每次激活都会重写它，所以升级后依然有效。

无需任何环境变量：server 会自己发现扩展发布的实例注册表，并根据会话工作区的 git remote 自动匹配实例。没有 `FORGEJO_MCP_TOKEN` 时为匿名只读（仅公开数据）。零配置版本不含秘密，但仍建议不要把 `.mcp.json` 提交进 git——绝对路径是机器相关的，而一旦加了 `env` 块，token 就会以明文落在可共享的文件里。

### 为什么在 Agents 窗口里 `whoami` 等账户级调用报「Invalid or expired credentials」？

因为那边的 server 是不带 token 启动的。从静态 `mcp.json` 启动的 MCP server 是由 VS Code 的 Agent Host 拉起的，不经过扩展——而只有扩展被允许从 VS Code SecretStorage 读 token 并在 spawn 时注入。不存在「让 server 自己去扩展配置里取」的路径：这个边界是刻意的（它保证 token 不落盘、不进日志），外部进程读取 SecretStorage 等同于凭证窃取，我们不实现。

可以改用：

- 在**主窗口**的 Copilot Chat 里做账户级操作——扩展贡献的 server 会自动携带 token。
- 或者自己在用户级 `mcp.json` 的 server 条目里加 `"env": { "FORGEJO_MCP_TOKEN": "<你的 token>" }`。这等于把明文 token 落盘在你的私有用户目录——可接受但要清楚这一点，并建议用只读权限的 token。

## 故障排除

### 点击仓库没有反应

请检查 `Forgejo Toolkit` 输出通道中的错误。常见原因包括：

- token 无效或已过期。
- 网络错误，无法连接到 Forgejo 实例。
- 缺少仓库权限。

### Dashboard 一片空白

打开 VS Code 开发者工具，查看是否有 JavaScript 错误。常见原因包括消息初始化失败或首次渲染时的运行时错误。

## 贡献

请参阅 [CONTRIBUTING.zh.md](./CONTRIBUTING.zh.md) 了解开发环境和贡献指南。如需报告 bug 或提问，请访问 [Codeberg Issues](https://codeberg.org/cpf23333/forgejo-toolkit/issues)。
