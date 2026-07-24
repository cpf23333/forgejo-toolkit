# TODO

## 进行中

- [ ] 创建 Issue / PR：提供表单提交入口
- [ ] 编辑 / 关闭 / 重新打开 Issue 和 PR

## 待开始

- [ ] PR worktree 增强
  - [ ] 判断当前 workspace 是否为 PR base repo
  - [ ] 未设置打开方式时弹窗询问，并支持记住选择
  - [ ] workspace 不匹配时：Clone / 打开已有仓库 / 取消
  - [ ] worktree 目录命名支持 sanitized PR title
- [ ] 完整文件浏览器：目录树、文件内容查看、代码高亮
- [ ] 分支 / 标签 / Release 管理列表
- [ ] README Markdown 渲染预览
- [ ] Forgejo 通知中心（`/notifications` API）
- [ ] 全局仓库 / Issue / PR 搜索
- [ ] 实例配置导出 / 导入
- [ ] 读取仓库 Actions 运行状态和历史
- [ ] 接入 MSW mock 用于测试或离线开发
- [ ] 为 API 客户端和 webview 添加单元 / 组件测试

## 已完成

- [x] 多实例管理
- [x] Dashboard 面板（Repositories / Issues / Pull Requests）
- [x] 仓库详情页
- [x] Issue / PR 列表与详情页
- [x] Issue / PR 详情页：展示评论、diff、时间线
- [x] PR 详情页 diff 增强（按提交查看 diff）
- [x] Issue / PR 描述的 Markdown 渲染
- [x] Issue / PR 附件列表
- [x] 图片附件 extension-host 代理
- [x] 国际化（中/英）
- [x] 调试日志开关
- [x] 工程规范与类型检查
- [x] 初次使用引导页（Onboarding）
- [x] PR worktree 基础功能
  - [x] 支持 `git worktree add` 检出 PR (`refs/pull/<index>/head`)
  - [x] worktree 目录命名：`{owner}-{repo}-pr-{number}`
  - [x] 用户选择 worktree 存放目录
  - [x] 设置项：`forgejoToolkit.worktreeCacheDirectory`
  - [x] 设置项：`forgejoToolkit.worktreeOpenMode`（newWindow / currentWindow）
  - [x] worktree 已存在时直接打开
  - [x] PR 详情页 UI 入口：在 Worktree 中打开
  - [x] 设置页 worktree 维护面板：列出、打开、删除
