# TODO

短期任务清单。已交付功能的完整记录见 `ROADMAP.md` 的「已完成」一节；更早的历史完成记录由本文件的 git 日志保存。

## 待开始

### 发布前

- [ ] 根 README 引用 `docs/screenshots/` 10 张图片，目录不存在（发布前补截图或移除引用）

### 第六轮多角度复审（2026-09-15，安全/并发/错误处理/性能四方向）

#### 安全批

- [ ] S1 `testConnection`/`editInstance` 的 token 回退路径无 origin 校验：webview 被攻破后可用存储 token 打任意 URL，`editInstance` 还能把攻击者 URL 持久化为实例地址（viewProvider.ts:306-314, 371-383）——token 回退时强制与已存 URL 同 origin，origin 变化必须重新输入 token
- [ ] S3 手工 markdown sanitizer 缝隙（webview/src/utils/markdown.ts）：`style`/`link`/`base`/`meta` 未删、`javascript:` href 原样保留、`xlink:href` 未处理、内联 `style` 属性不过滤——补现有 sanitizer（暂不引 DOMPurify：Apache-2.0 OR MPL-2.0 双许可需先过 license 关）
- [ ] S4 `_resolveAvatarUrl` 对任意 URL 发起 host 侧 fetch（恶意实例 SSRF 内网探测）——只代理同 origin，外网头像交给 CSP `img-src https:` 直载
- [ ] S6 publish 成功后 `openExternal(repository.html_url)` 无 scheme 白名单（publish.ts:293，webview 路径有白名单这条漏了）

#### 稳定性批

- [ ] E1 变更类消息（merge/delete\*/revert/dispatchWorkflow/stopwatch/time/dependency/reaction/subscription 等约 20 个 case）在实例被删后静默 return，webview loading 永卡——与已修的 load 类同源，建 mutation→result 预检回复映射或挂 `_requestId`
- [ ] E2 `pullReviewCommentPanel.ts:166` context 切换 promise 链无 catch，一次 reject 永久毒化——照搬 `_enqueueRender` 的 `.then(task).catch(...)` 模式
- [ ] C1 WorktreeManager globalState 读-改-写无串行化，并发 open/remove 丢记录→孤儿 worktree/bare 缓存被 LRU 误清——加 promise 写队列（参照 notificationPoller `_seenIdsWriteQueue`）
- [ ] C2 `removeWorktree` 无 in-flight 守卫，与 open/startWork 的 key 不互通——随 C1 写队列一并串行化
- [ ] C3 同仓库不同 PR 并发 open 对同一路径双重 bare clone，后到者报错——clone 阶段 in-flight 降到 sourceRepo 维度，或失败后检测合法 bare 仓库降级复用
- [ ] C4 `myIssuesRequestStates` 单槽竞态（latent）：host 回复不回显 `state`，webview 靠猜槽位——host 回显 state（与 getRepoIssues 回显 query 一致），webview 删猜测逻辑

#### 性能批

- [ ] P1 `detectLinkedRepositories` 被 viewProvider/statusBar 两个消费者各自独立触发，每次 tab 切换 ≈2N+1 个 git 子进程——下沉 5-15s TTL 共享缓存（key 含 workspace+active editor+instances 指纹），issueMentionProvider 的私有缓存随之可删
- [ ] P4 头像 fetch 无缓存不 dedupe（repo detail 最多 20 次 HTTP，同一作者重复抓）——session 级 LRU + 单次内按 URL dedupe（复用附件缓存模式）
- [ ] P2 ActionRunDetail 每 4s 全量重拉所有 live job 日志（5 并发 job 最坏 50MB/4s）——只拉当前展开的 job 或降频到 8-10s
- [ ] P3 webview 977KB 单 chunk，EasyMDE（CodeMirror 5 + marked）静态打入主 bundle——EasyMdeEditor 内动态 `import('easymde')` + 路由级懒加载，预计首载削 30-40%

#### 卫生批

- [ ] l10n 孤儿键清理：host bundle `Export`（en/zh 各 1）；webview 27 个（app.title/app.openOnboarding/app.home/common.cancel/dashboard.title 等，清理前逐个人工复核非动态拼接）
- [ ] C5 `revertMergeCommit` 无 host 侧防重入——用 InFlightTasks（key 含 PR 坐标）包住 revert/merge
- [ ] C6 `publishToForgejo` 双击并发：两次 createUserRepo + 误导性 addRemote 报错——命令注册处加模块级 in-flight 标志
- [ ] C7 缓存陈旧：`serverVersions` 会话内不过期（服务器升级后 Actions 仍被拦）、`repoPathBindingCache` 负缓存 60s——保存/编辑实例时清对应缓存
- [ ] C8 RepoFileBrowser 搜索防抖无 isActive 守卫（与已修的 RepoIssues/GlobalSearch 不一致的漏网）——补守卫 + onActivated 重应用
- [ ] E3-E6 四处 `void promise` 无 catch：EasyMdeEditor.vue:105 renderPreviewHtml、config.ts:52 secrets.get、client.ts:1794 401 toast 回调、extension.ts:61/welcome.ts/readmeProvider.ts——补 catch
- [ ] 命令失败提示路径不统一：copyPermalink/add/deleteReviewComment/createIssueFromComment 用裸 showErrorMessage（commands/index.ts:45/82/96/106），改用 showErrorWithLog

#### 缓议（已评估，暂不动）

- S2 破坏性操作（delete\*/merge/dispatchWorkflow）确认全靠 webview 自发 showConfirm，host 侧无独立确认——host 弹 modal 会改变交互形态，待拍板
- S5 导入预览把文件中的 token 明文送入 webview 进程——改 host 侧暂存+索引回指，收益/工程量比一般
- C9 有记录的 PR worktree 重开不校验 headSha，PR 更新后静默打开旧代码——可能是「记录即真相」的有意设计，待确认意图
- P5 500 条列表全量渲染无分页/虚拟化——大仓库才感知，待性能实测后定
- P6 renderMarkdown 无 in-flight 去重——并发挂载同 cacheKey 发重复请求，顺手级
- DOMPurify 替换手工 sanitizer——license（Apache-2.0 OR MPL-2.0）与 bundle 体积评估后再定

### 低优先级（历史遗留）

- [ ] issue worktree 重开残留目录时 `baseBranch` 硬编码为 `'main'`（`viewProvider.ts` 的 existsOnDisk 路径不查 API；默认分支非 main 的仓库记录里 baseBranch 错误，目前仅展示用途，危害低）——第二轮复审遗留
- [ ] vscode-tree 内按钮（IconActionButton）的 Enter/Space 键盘激活被库自身 keydown `preventDefault` 抑制——`@vscode-elements/elements` 2.5.1 的 pre-existing 限制（原 vscode-icon 同样如此），升级库或上游修复后复查
- [ ] onboarding 面板的 CSP 只在 HTML 重建时生效：编辑中实例 URL 已并入 `instanceUrls`，但 `http://` 实例在下一次面板重建前，markdown 预览里的实例图片仍被拦（https 实例不受影响，影响面小）

### 走查方向

- [ ] 性能专项检查：激活成本、webview bundle 体积、长列表渲染、git 子进程频率——静态部分已完成（见性能批 P1-P4），实测部分暂缓
- [ ] 动态端到端走查：重新打包 vsix 后用 tools/ui-review harness 实测功能闭环（多 remote 关联、关联仓库切换器、中文详情页、Publish 按钮新行为、评论 thread 清理）
- [ ] `prFileSystemProvider` 大文件行为实测：contents API 对大文件可能不返回 `content` 字段，PR diff 里大文件会显示为空字节（与 repoFileProvider 一致，属既有行为），值得实测一次确认

## 进行中

（空）
