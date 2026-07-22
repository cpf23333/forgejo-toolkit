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

## 待实现

### 详情与操作

- Issue / PR 详情页：展示评论、diff、时间线。
- 创建 Issue / PR：提供表单提交入口。
- 编辑 / 关闭 / 重新打开 Issue 和 PR。

### 仓库浏览

- 完整文件浏览器：目录树、文件内容查看、代码高亮。
- 分支 / 标签 / Release 管理列表。
- README Markdown 渲染预览。

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

- 本地仓库关联：将 VS Code 已打开的 workspace 与 Forgejo 仓库关联。
- Issue / PR 与 Git 分支联动：例如点击 PR 自动检出对应分支到 worktree。
- 通知推送：后台轮询 + VS Code 消息提醒。
- 多账号权限管理：区分只读 / 读写 token。
