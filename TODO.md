# TODO

短期任务清单。已交付功能的完整记录见 `ROADMAP.md` 的「已完成」一节；更早的历史完成记录由本文件的 git 日志保存。

## 待开始

### 高优先级

- [ ] Access token 迁移到 VS Code SecretStorage；clone 时不再把 token 写入 HTTPS URL
- [ ] 仓库内 Issue / PR 列表支持关键词搜索（服务端搜索 API 现成）

### 中优先级

- [ ] 从 TODO/FIXME 注释创建 Issue（CodeAction 快速修复）
- [ ] Start Work on Issue：从 Issue 一键创建分支并 checkout
- [ ] 多仓库 / 嵌套仓库 workspace 支持
- [ ] 作为 VS Code Git clone 源 / 发布本地仓库到 Forgejo（`RemoteSourceProvider` / `RemoteSourcePublisher`）

## 进行中

（空）

## 已完成

### 最近完成

- [x] PR review 提交支持选择结论：评论 / 批准（Approve）/ 要求修改（Request changes），可附带评审总结
- [x] 自研 VS Code 风格日期时间选择器组件（替代浏览器原生 datetime-local 弹窗）
- [x] Issue 详情页支持删除 Issue
- [x] 清理已废弃的 `VscodeDateField` / `VscodeDateTimeField` 组件
- [x] 移除 `packages/vscode-elements-vue` 包，改用原生 `@vscode-elements/elements` 组件
- [x] MSW mock 接入（测试与离线开发，`forgejoToolkit.useMockApi`）
- [x] `ForgejoClient` MSW 测试覆盖所有公开方法；webview 组件与 `useAppState` 单元测试
