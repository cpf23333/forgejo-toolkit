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

### 用户视角走查发现的问题（2026-08-24）

按影响排序；多数需要实测确认后单独拆任务处理。

- [ ] 同一实例配置多账号时，仓库关联检测按 `instanceId + owner/repo` 匹配第一个实例，可能以错误身份执行评论/合并等写操作；应提示用户选择或显式绑定仓库到账号
- [ ] Token 过期或 scope 不足时只有报错弹窗，没有修复引导；添加实例表单也应列出推荐 scope 清单
- [ ] 10+ 处 `.catch(() => undefined)` 静默吞错，部分用户操作（如同步）失败时无任何反馈；至少加日志，关键路径提示用户
- [ ] 多根 workspace 下关联检测只取第一个匹配的仓库，状态栏与命令上下文可能张冠李戴
- [ ] 通知轮询默认间隔 300s 延迟偏大，新通知弹窗也无聚合（一次弹多个）；考虑缩短默认值、聚合提示、动作失败时回滚已读标记
- [ ] Review 评论面板是单例（`PullReviewCommentPanel.currentPanel`），一行写到一半切到另一行时面板上下文被替换；需实测确认未提交内容是否丢失，丢失则加确认或缓存草稿
- [ ] `package.json` 的 `publisher` 仍是占位符 `your-publisher-name`，发布前必须改

#### 第二轮走查（同日补充，均有代码证据）

**严重**

- [ ] `forgejoToolkit.locale` 配置项 `default: "zh"` 导致非中文用户首启看到全中文界面（`resolveLocale(vscode.env.language)` 兜底失效，`pullReviewCommentPanel.ts` 直接写死 `'zh'`）；应去掉默认值让系统语言兜底生效
- [ ] 首次安装零引导：无 walkthrough / viewsWelcome / 首次激活逻辑，`openDashboard`/`openOnboarding` 等核心命令还被 `when: "false"` 从命令面板隐藏；应加 walkthrough、首启自动打开引导、解禁核心命令
- [ ] `ModalDialog` 用原生 `<dialog>` 但不监听 `close` 事件：Esc 关闭弹窗后父组件 `isCreating` 仍为 true，「新建」按钮从此无响应，必须刷新 webview；给 `<dialog>` 加 `@close` 同步父状态
- [ ] 不可逆操作缺二次确认：合并 PR 无确认（同文件 revert 却有）；设置页删 worktree 是 `useTrash: false` 物理删除且无确认；取消运行中的 Action 无确认
- [ ] 请求无超时：client 无 `AbortSignal`/timeout，webview pending 请求无超时，host 侧大量 `if (!instance) return` 早退不回包（如 mergePullRequest），提交按钮可永久卡 loading；应统一加超时 reject，host 每个 case 保证必然 `_reply`
- [ ] 网络错误与 HTTP 状态码无归类：断网/实例宕机显示 `fetch failed` 英文原文；401/404/409/422 一律 `Failed to X: {raw}`（PR 合并冲突 409 只显示原始报错）；应在 client 层抛结构化错误，按状态码映射 i18n 文案

**中等**

- [ ] 「Open Settings」按钮在侧栏 webview 未打开时静默失效（`publish.ts` 直接 postMessage 给 undefined）；`openSettings`/`openDashboard` 命令统一先 reveal/focus 视图再发消息
- [ ] 长操作（push / clone / 发布）无 `withProgress` 进度反馈，大仓库发布几十秒用户分不清在跑还是卡死
- [ ] Issue/PR 列表无分页（不传 limit/page），超出服务端默认页大小的老条目静默消失；全局搜索 limit 20、通知 limit 50，截断无提示；至少加「加载更多」或截断标识
- [ ] 通知异常不可见：某实例 token 失效且无通知时显示「暂无通知」而非错误；轮询失败只写日志，列表停在旧数据无感知
- [ ] `#`/`@` 补全和文档链接注册到所有文件类型（`scheme: 'file'` 无语言过滤），写 Python `#` 注释、C `#include` 都会触发 issue 补全；限定语言或加行内上下文判断（需实测干扰程度）
- [ ] Copy Permalink 右键菜单 when 条件是 `editorHasSelection || true`（调试残留），无关项目也常驻；改用 `setContext` 维护上下文键
- [ ] 403 scope 不足提示每请求弹一次且无去重（轮询 + 手动刷新会持续弹英文 toast）；按 instance+scope 去重，每会话一次并附「打开设置」
- [ ] 报错通知无可行动按钮（24 处 showErrorMessage 仅 1 处带按钮）；无「查看日志」命令，OutputChannel 默认日志不带 URL/状态码
- [ ] 关闭/重开 Issue/PR 失败时错误写入编辑弹窗的 key，用户毫无反馈；需单独的错误展示位

**轻微**

- [ ] 表单/搜索框无 autofocus（新建 Issue、全局搜索进入后不聚焦）
- [ ] 原生 `<select>`/`<checkbox>` 与 vscode-elements 组件混用（GlobalSearch、IssueDetail 依赖选择），观感与键盘体验不统一
- [ ] 切换 state/tab 时列表闪烁（新 key 无缓存直接替换为加载中）；可保留旧列表渲染
- [ ] 通知筛选切换无防抖，连续切换产生多次请求
- [ ] i18n 漏网：state 徽章直接渲染英文 "open"/"closed"、`aria-label="Close"` 硬编码、`Connected to Forgejo as ...` 等成功提示不走 l10n
- [ ] Onboarding 缺「去实例上创建 token」链接；`scm/title` 缺 Publish/Create PR 图形入口；「刷新实例」按钮可能只刷新实例列表不刷新数据（需实测）
- [ ] `InstanceList.vue` 整段英文硬编码且已无人引用（死代码，可删）

## 进行中

（空）

## 已完成

### 最近完成

- [x] API 缓存审计与第一批修复：mention 补全加 TTL 缓存、Markdown 渲染按内容缓存、loader 全量 in-flight 去重、PR 文件列表缓存 key 包含 diff 范围
- [x] API 缓存第二批修复：时间线附件请求按正文引用过滤（消除 N+1）、仓库文件搜索复用 git tree 缓存（60s）、labels/assignees/milestones/repoDetails 改为 60s 定时缓存、Action 轮询不再重拉已完成 job 日志、状态栏 PR 缓存加 60s TTL
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
