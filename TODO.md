# TODO

## 待开始

- [ ] 接入 MSW mock 用于测试或离线开发
- [ ] 为 webview `useAppState` 的 API 调用与消息处理逻辑添加单元测试
- [ ] 评估将 extension host 打包从 esbuild 迁移到 Rolldown，统一构建工具链
- [ ] 自研 VS Code 风格日期时间选择器组件（替代浏览器原生 datetime-local 弹窗）
- [ ] 调研并补齐 Project 相关 API（当前生成的 client 中无 `/projects` 端点）

## 已完成

### 导入导出

- [x] 实例配置导出支持选择具体实例（而非全部导出）
- [x] 实例配置导出包含语言、调试开关、worktree 配置等完整设置
- [x] 导入预览页显示「已存在」实例的旧值与新值对比
- [x] 导入预览页检测 Token 冲突
- [x] 实例配置导出支持「复制到剪贴板」
- [x] 导出加密时增加密码确认输入
- [x] 导入成功后根据场景自动跳转（onboarding 关闭引导、Settings 去仪表盘）
- [x] 导入/导出文件格式增加 `version` 字段

### 实例与设置

- [x] 多实例管理
- [x] 移除实例二次确认
- [x] onboarding 导入配置后侧栏主视图自动刷新
- [x] 实例 URL 同步：`app.ini` ROOT_URL 与配置地址不一致时重写 API 返回的 URL

### 仓库与代码

- [x] 根据当前 workspace 的 git remote 自动识别 Forgejo 仓库并在 Dashboard 显示快捷入口
- [x] Dashboard 面板（Repositories / Issues / Pull Requests）
- [x] 仓库详情页
- [x] 仓库文件浏览器
  - [x] 目录树展示
  - [x] 文件内容查看
  - [x] 代码高亮（由 VS Code 自动处理）
  - [x] 文件搜索
  - [x] 文件历史
  - [x] 文件夹展开 loading 指示器
- [x] 分支 / 标签 / Release 管理列表
- [x] 分支 / 标签 / Release 管理增强（创建 / 删除分支、创建标签 / Release）
- [x] README Markdown 渲染预览
- [x] 仓库详情页 Actions 标签页：读取 Actions 运行状态和历史

### CI / Actions

- [x] Actions 运行详情页：展示 job 列表、job 日志、制品列表
- [x] Actions 制品支持本地下载（通过 API 获取 ZIP 并调用 save dialog）
- [x] Actions 运行详情页支持取消正在运行的记录
- [x] Actions 远程触发 workflow（支持输入参数）与实时轮询进度

### Issue / PR

- [x] Issue / PR 列表与详情页
- [x] Issue / PR 详情页：展示评论、diff、时间线
- [x] PR 详情页 diff 增强（按提交查看 diff）
- [x] PR diff 使用 `merge_base` 与 `head.sha`，避免 fork PR 内容漂移
- [x] PR 详情页直接展示 CI / commit status
- [x] PR 打开新增/删除文件时给出状态提示
- [x] PR 详情页支持撤销合并（Revert merge commit）
- [x] Issue / PR 描述的 Markdown 渲染
- [x] Issue / PR 附件列表
- [x] 图片附件 extension-host 代理
- [x] 为 Issue / PR 添加评论功能（支持附件）
- [x] 支持合并 PR（merge / squash / rebase）
- [x] Issue / PR 创建
- [x] Issue / PR 编辑、关闭、重新打开
- [x] Issue / PR 编辑弹窗（不留下路由历史）
- [x] 富文本编辑器（EasyMDE）与图片上传
- [x] 富文本图片上传后固定插入 `![image](/attachments/{uuid})` 格式
- [x] 编辑弹窗内附件上传 / 删除
- [x] 保存 Issue / PR 后重新获取详情
- [x] Issue 创建表单支持指定分支或标签（`ref`）
- [x] Issue 详情页支持订阅 / 取消订阅通知
- [x] Issue 详情页支持时间追踪（查看、手动添加、启动/停止计时器）
- [x] Issue 详情页支持依赖议题管理（添加/移除依赖、查看阻塞关系）
- [x] PR 详情页改为左右两栏布局
- [x] PR 详情页右侧栏展示标签、负责人、里程碑、到期时间、引用、参与者
- [x] PR diff 行级评论支持富文本输入框（用 webview 内嵌 EasyMDE 替代 `showInputBox`），支持「添加单条评论」和「开始评审」两种模式
- [x] PR 详情页支持反应表情
- [x] PR 详情页支持订阅 / 取消订阅通知
- [x] PR 详情页支持时间追踪
- [x] PR 详情页支持依赖议题管理
- [x] PR 编辑表单支持负责人、标签、里程碑、到期时间、引用
- [x] PR 详情页显示合并状态及具体阻塞原因
- [x] PR 详情页展示状态检查（status checks）列表

### 通知与搜索

- [x] Forgejo 通知中心（`/notifications` API）
- [x] 通知后台轮询与推送：extension host 轮询 + VS Code 弹窗提醒 + webview 角标自动更新
- [x] 全局仓库 / Issue / PR 搜索

### Worktree

- [x] PR worktree 基础功能
  - [x] 支持 `git worktree add` 检出 PR (`refs/pull/<index>/head`)
  - [x] worktree 目录命名：`{owner}-{repo}-pr-{number}`
  - [x] 用户选择 worktree 存放目录
  - [x] 设置项：`forgejoToolkit.worktreeCacheDirectory`
  - [x] 设置项：`forgejoToolkit.worktreeOpenMode`（newWindow / currentWindow）
  - [x] worktree 已存在时直接打开
  - [x] PR 详情页 UI 入口：在 Worktree 中打开
  - [x] 设置页 worktree 维护面板：列出、打开、删除
- [x] PR worktree 增强
  - [x] 判断当前 workspace 是否为 PR base repo
  - [x] 未设置打开方式时弹窗询问，并支持记住选择
  - [x] workspace 不匹配时：Clone / 打开已有仓库 / 取消
  - [x] worktree 目录命名支持 sanitized PR title

### 工程与体验

- [x] 国际化（中/英）
- [x] 调试日志开关
- [x] 工程规范与类型检查
- [x] 初次使用引导页（Onboarding）
- [x] 为 API 客户端和 webview 添加单元 / 组件测试
  - [x] 配置 Vitest + jsdom 测试环境
  - [x] 为 shared request 客户端添加单元测试
  - [x] 为 webview ModalDialog 组件添加测试
  - [x] 为 webview FileTreeItem 组件添加测试
- [x] 接入 Changesets 管理 monorepo 版本号
