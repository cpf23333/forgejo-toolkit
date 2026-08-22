# TODO

短期任务清单。已交付功能的完整记录见 `ROADMAP.md` 的「已完成」一节；更早的历史完成记录由本文件的 git 日志保存。

## 待开始

### 高优先级

（空）

### 中优先级

- [ ] 从 TODO/FIXME 注释创建 Issue（CodeAction 快速修复）
- [ ] Start Work on Issue：从 Issue 一键创建分支并 checkout
- [ ] 多仓库 / 嵌套仓库 workspace 支持
- [ ] 作为 VS Code Git clone 源（`RemoteSourceProvider`，支持服务端搜索仓库）

## 进行中

（空）

## 已完成

### 最近完成

- [x] API 缓存审计与第一批修复：mention 补全加 TTL 缓存、Markdown 渲染按内容缓存、loader 全量 in-flight 去重、PR 文件列表缓存 key 包含 diff 范围
- [x] 状态栏「创建 PR」按钮：当前分支非默认分支且无开放 PR 时显示，点击按需推送分支并打开预填的新建 PR 弹窗；分支已有开放 PR 时显示「PR #n」直达详情
- [x] 发布本地仓库到 Forgejo：`Publish to Forgejo` 命令，无 origin 时创建远程仓库（实例/名称/可见性可选）并推送当前分支；已有关联仓库时直接推送当前分支
- [x] Access token 迁移到 VS Code SecretStorage（激活时自动从 globalState 迁移）；clone / fetch 改用 `http.extraHeader` 传 token，不再写入 HTTPS URL
- [x] 仓库内 Issue / PR 列表支持关键词搜索（服务端 `q` 参数，输入防抖 300ms）
- [x] PR review 提交支持选择结论：评论 / 批准（Approve）/ 要求修改（Request changes），可附带评审总结
- [x] 自研 VS Code 风格日期时间选择器组件（替代浏览器原生 datetime-local 弹窗）
- [x] Issue 详情页支持删除 Issue
- [x] 清理已废弃的 `VscodeDateField` / `VscodeDateTimeField` 组件
- [x] 移除 `packages/vscode-elements-vue` 包，改用原生 `@vscode-elements/elements` 组件
- [x] MSW mock 接入（测试与离线开发，`forgejoToolkit.useMockApi`）
- [x] `ForgejoClient` MSW 测试覆盖所有公开方法；webview 组件与 `useAppState` 单元测试
