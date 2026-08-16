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
- 使用 Changesets 管理 monorepo 版本号与 CHANGELOG。

### Issue / PR 详情

- Issue / PR 列表与详情页。
- Issue / PR 描述的 Markdown 渲染与附件列表。
- Issue / PR 详情页：展示评论、diff、时间线。
- PR 详情页 diff 增强：按提交查看 diff，列出每个 commit 的变更文件并支持单提交 diff 预览。
- PR 详情页改为左右两栏布局。
- PR 详情页右侧栏展示标签、负责人、里程碑、到期时间、引用、参与者。
- PR 详情页支持反应表情、订阅/取消订阅通知、时间追踪、依赖议题管理。
- PR 详情页显示合并状态及具体阻塞原因（冲突、需要审查、状态检查未通过等）。
- PR 详情页直接展示 CI / commit status 列表。
- PR diff 使用 `merge_base` 与 `head.sha`，避免 fork PR 内容漂移。
- 打开 PR 的新增/删除文件时给出状态提示。

### Issue / PR 操作

- 创建 Issue / PR：仓库 Issue/PR 列表页提供新建弹窗。
- 编辑 / 关闭 / 重新打开 Issue 和 PR：详情页弹窗编辑，保存成功后重新获取详情。
- 编辑弹窗使用原生 `<dialog>` 封装，不留下路由历史。
- 为 Issue / PR 添加评论，支持附件上传。
- 合并 PR，支持 merge / squash / rebase 策略。
- 撤销已合并 PR（Revert merge commit）：在本地仓库执行 `git revert -m 1` 并 push。
- Issue 详情页支持订阅/取消订阅通知、时间追踪、依赖议题管理。
- PR 编辑表单支持负责人、标签、里程碑、到期时间、引用分支/标签。

### PR Review

- PR 内联 review 评论（行级评论）：支持在 VS Code 原生 diff 中查看、添加、删除评论。
- PR diff 行级评论富文本输入：使用独立 webview panel 内嵌 EasyMDE，提供 Markdown 工具栏、预览、@/# 提及、图片附件上传；支持「添加单条评论」和「开始评审/继续评审/提交评审」两种模式。

### 富文本编辑器与附件

- 集成 EasyMDE 富文本编辑器，支持描述编辑。
- 富文本内图片上传，上传后固定插入 `![image](/attachments/{uuid})` 格式。
- 编辑弹窗内支持附件上传与删除。
- 附件删除改为 pending 模式：标记后随保存一起提交，取消编辑则放弃删除。
- 保存成功后重新获取详情，确保附件等数据最新。
- Issue / PR / Release / 评论创建时支持 pending 附件，创建实体后自动上传。
- 新建 Release 时支持多文件附件选择。
- 提取 PendingAttachmentList 组件，统一 pending 附件列表的展示与 object URL 管理。

### 仓库浏览

- 文件浏览器：目录树展示、文件内容查看、代码高亮由 VS Code 自动处理。
- 文件浏览器增强：文件搜索、文件历史、文件夹展开 loading 指示器。
- 分支 / 标签 / Release 管理：在仓库详情页展示列表、切换标签页查看，并支持创建 / 删除分支、创建标签 / Release。
- README Markdown 渲染预览：在仓库详情页点击「预览 README」，通过 VS Code 原生 Markdown 预览打开。

### 本地仓库自动关联

- 根据当前 workspace 的 git remote 自动识别 Forgejo 仓库和对应实例。
- 在 Dashboard 顶部显示关联仓库卡片，支持快捷打开仓库、Issues、Pull Requests。
- workspace 文件夹变化或实例增删时自动重新检测。

### 通知与搜索

- Forgejo 通知中心：未读角标、按状态和类型筛选、标记已读/全部已读、Issue/PR 通知直接跳转详情。
- 全局仓库 / Issue / PR 搜索：跨实例搜索，支持实例、类型、状态筛选。

### 设置与数据

- 实例配置导出 / 导入：支持将已保存实例（含 access token）和设置导出为 JSON 文件，或从 JSON 文件导入。
  - 导出时可选择具体实例、复制到剪贴板、使用密码加密。
  - 导入前预览，显示「已存在」实例的差异和 Token 冲突检测。
  - 导入后自动恢复语言、调试开关、worktree 配置，并自动跳转到 Dashboard。
- 移除实例前二次确认。
- onboarding 面板与侧栏主视图通过事件同步实例变更。

### CI / Actions

- [x] 读取仓库 Actions 运行状态和历史。
- [x] 在 PR 详情页展示状态检查（status checks）列表，帮助判断是否可以合并。
- [x] Actions 运行详情页：展示 job 列表、job 日志、制品列表。
- [x] Actions 制品本地下载：通过 API 获取 ZIP 并调用系统 save dialog。
- [x] Actions 运行详情页支持取消正在运行的记录。
- [x] Actions 远程触发 workflow，支持输入参数，并轮询展示运行状态。

## 当前迭代

本轮迭代内容已全部完成并提交。

## 后续迭代

### 设置与数据

- 设置同步（可选 VS Code Settings Sync）。

### 构建工具统一

- Vite 8 已默认基于 Rolldown，但 extension host 仍使用 esbuild。
- 评估将 extension host 的打包从 esbuild 迁移到 Rolldown，统一整个项目的构建工具链，减少依赖和配置差异。
- 需要验证 Node builtins 处理、CJS 输出、sourcemap、minify、watch 模式等能力。

### Mock 与测试

- 接入 MSW mock 用于测试或离线开发。
- 为 webview `ModalDialog`、`FileTreeItem` 等组件添加更多测试。
- 为 webview `useAppState` 的 API 调用与消息处理逻辑添加单元测试。

### 旧版本 Forgejo / Gitea 兼容

- 测试并兼容不同 Forgejo 版本（如 1.x、7.x、9.x）的 API 差异。
- 评估对 Gitea 的兼容支持，处理 API 路径、字段、认证方式的差异。
- 在设置中允许用户声明服务器版本或自动探测。

## 长期可能

- 图标库统一：用 VS Code `codicon` 替代 `font-awesome`，减少依赖并保持与 VS Code 风格一致。当前 `font-awesome` 仅用于文件浏览器刷新按钮和 EasyMDE 工具栏图标，EasyMDE 部分需要自定义按钮才能迁移。
- 本地仓库关联：将 VS Code 已打开的 workspace 与 Forgejo 仓库关联（目前已支持检测本地仓库作为 worktree 源）。
- Issue / PR 与 Git 分支联动：例如点击 PR 自动检出对应分支到 worktree（worktree 已支持）。
- 通知推送：后台轮询 + VS Code 消息提醒。
- 多账号权限管理：区分只读 / 读写 token。
- 文件浏览器增强：文件重命名 / 删除（目前更推荐本地 clone 后操作）。
