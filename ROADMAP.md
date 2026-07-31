# Forgejo Toolkit 功能规划

## 已完成

### 多实例管理

- 添加、删除、测试连接多个 Forgejo/Codeberg 实例。
- 使用 VS Code SecretStorage 安全保存 access token。

### Dashboard 面板

- 标签页切换：Repositories / Issues / Pull Requests。
- 按实例折叠展示数据，折叠面板标题显示服务器地址和当前账号。
- 仓库卡片：名称、描述、默认分支、star/fork、右侧图标支持在浏览器打开和复制克隆地址。
- Issue / PR 卡片：编号、标题、状态、仓库名、复制链接图标。
- 仓库详情页：README、分支列表、最近 commits、返回 Dashboard。
- 初次使用引导页：以编辑器页签形式打开，支持语言、服务器、worktree 配置。

### Pull Request Worktree

- 在 PR 详情页提供「在 Worktree 中打开」按钮。
- 自动 bare clone 源仓库到缓存目录，基于 `refs/pull/<index>/head` 创建本地分支和可编辑 worktree。
- 支持配置 worktree 打开方式（新窗口 / 当前窗口）和缓存目录。
- 设置页管理已创建的 worktree（打开、删除）。
- 打开 worktree 前检测当前 workspace 是否就是 PR base repo。
- 未配置打开方式时弹窗询问（新窗口 / 当前窗口），并支持记住选择。
- 本地没有源仓库时支持：clone 到缓存目录、选择已有本地仓库、取消。
- worktree 目录命名包含 sanitized PR title。

### 设置页

- 语言切换、调试日志开关。
- 添加 / 删除 / 修改 Forgejo 实例，测试连接。
- 配置 PR worktree 打开方式和缓存目录，支持文件夹选择器。
- 列出已创建的 worktree。

### 国际化

- 支持中文 / 英文切换。

### 调试日志

- 设置页提供 debug 开关。
- 输出 API 请求 URL、状态码、响应体到 `Forgejo Toolkit` Output Channel。

### API 客户端

- 基于 Forgejo OpenAPI 规范使用 Kubb 生成 `@cpf23333-forgejo-toolkit/api`。
- 源码交付，无 build/pack 步骤。
- 共享请求客户端放在 `@cpf23333-forgejo-toolkit/shared`。

### 工程规范

- 使用 `vue-tsc` 推导 `.vue` 组件类型。
- `@vscode-elements/elements` 组件必须在 `packages/vscode-elements-vue/src/components` 中定义 Vue wrapper 后使用。
- 使用 `oxlint` + `oxfmt` 作为 lint/format 工具。

### Issue / PR 详情

- Issue / PR 列表与详情页。
- Issue / PR 描述的 Markdown 渲染与附件列表。
- Issue / PR 详情页：展示评论、diff、时间线。
- PR 详情页 diff 增强：按提交查看 diff，列出每个 commit 的变更文件并支持单提交 diff 预览。

### Issue / PR 操作

- 创建 Issue / PR：仓库 Issue/PR 列表页提供新建弹窗。
- 编辑 / 关闭 / 重新打开 Issue 和 PR：详情页弹窗编辑，保存成功后重新获取详情。
- 编辑弹窗使用原生 `<dialog>` 封装，不留下路由历史。

### 富文本编辑器与附件

- 集成 EasyMDE 富文本编辑器，支持描述编辑。
- 富文本内图片上传，上传后固定插入 `![image](/attachments/{uuid})` 格式。
- 编辑弹窗内支持附件上传与删除。
- 附件删除改为 pending 模式：标记后随保存一起提交，取消编辑则放弃删除。
- 保存成功后重新获取详情，确保附件等数据最新。

### 仓库浏览

- 文件浏览器：目录树展示、文件内容查看、代码高亮由 VS Code 自动处理。
- 文件浏览器增强：文件搜索、文件历史、文件夹展开 loading 指示器。
- 分支 / 标签 / Release 管理：在仓库详情页展示列表、切换标签页查看，并支持创建 / 删除分支、创建标签 / Release。
- README Markdown 渲染预览：在仓库详情页点击「预览 README」，通过 VS Code 原生 Markdown 预览打开。

## 待实现

### 仓库浏览

- 文件浏览器增强：文件重命名 / 删除。

### 通知与搜索

- Forgejo 通知中心（`/notifications` API）。
- 全局仓库 / Issue / PR 搜索。

### 设置与数据

- 实例配置导出 / 导入。
- 设置同步（可选 VS Code Settings Sync）。

### CI / Actions

- 读取仓库 Actions 运行状态和历史。

### Mock 与测试

- 接入 MSW mock 用于测试或离线开发。
- 为 API 客户端和 webview 添加单元 / 组件测试。

## 长期可能

- 图标库统一：用 VS Code `codicon` 替代 `font-awesome`，减少依赖并保持与 VS Code 风格一致。当前 `font-awesome` 仅用于文件浏览器刷新按钮和 EasyMDE 工具栏图标，EasyMDE 部分需要自定义按钮才能迁移。
- 本地仓库关联：将 VS Code 已打开的 workspace 与 Forgejo 仓库关联（目前已支持检测本地仓库作为 worktree 源）。
- Issue / PR 与 Git 分支联动：例如点击 PR 自动检出对应分支到 worktree（worktree 已支持）。
- 通知推送：后台轮询 + VS Code 消息提醒。
- 多账号权限管理：区分只读 / 读写 token。
