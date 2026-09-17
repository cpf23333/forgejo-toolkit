# TODO

短期任务清单。已交付功能的完整记录见 `ROADMAP.md` 的「已完成」一节；更早的历史完成记录由本文件的 git 日志保存。

## 待开始

### 发布前

- [ ] 根 README 引用 `docs/screenshots/` 10 张图片，目录不存在（发布前补截图或移除引用）

### 第六轮复审缓议项（2026-09-15 四方向复审已修完，以下已评估暂不动）

- [ ] S2 破坏性操作（delete*/merge/dispatchWorkflow）确认全靠 webview 自发 showConfirm，host 侧无独立确认——host 弹 modal 会改变交互形态，待拍板
- [ ] S5 导入预览把文件中的 token 明文送入 webview 进程——改 host 侧暂存+索引回指，收益/工程量比一般
- [ ] C9 有记录的 PR worktree 重开不校验 headSha，PR 更新后静默打开旧代码——可能是「记录即真相」的有意设计，待确认意图
- [ ] P5 500 条列表全量渲染无分页/虚拟化——大仓库才感知，待性能实测后定
- [ ] P6 renderMarkdown 无 in-flight 去重——并发挂载同 cacheKey 发重复请求，顺手级
- [ ] DOMPurify 替换手工 sanitizer——license（Apache-2.0 OR MPL-2.0）与 bundle 体积评估后再定
- [ ] `useAppState.test.ts` 的 `openNewIssue` 测试存在顺序脆弱性（依赖靠前测试已缓存懒加载 chunk），测试顺序变化时需改 `vi.waitFor`
- [ ] P3 懒加载分包只做了 vite 配置静态分析，下次真实打包后实开 webview 确认动态 chunk 加载正常

### 低优先级（历史遗留）

- [ ] issue worktree 重开残留目录时 `baseBranch` 硬编码为 `'main'`（`viewProvider.ts` 的 existsOnDisk 路径不查 API；默认分支非 main 的仓库记录里 baseBranch 错误，目前仅展示用途，危害低）——第二轮复审遗留
- [ ] vscode-tree 内按钮（IconActionButton）的 Enter/Space 键盘激活被库自身 keydown `preventDefault` 抑制——`@vscode-elements/elements` 2.5.1 的 pre-existing 限制（原 vscode-icon 同样如此），升级库或上游修复后复查
- [ ] onboarding 面板的 CSP 只在 HTML 重建时生效：编辑中实例 URL 已并入 `instanceUrls`，但 `http://` 实例在下一次面板重建前，markdown 预览里的实例图片仍被拦（https 实例不受影响，影响面小）

### 走查方向

- [ ] 动态端到端走查：重新打包 vsix 后用 tools/ui-review harness 实测功能闭环（多 remote 关联、关联仓库切换器、中文详情页、Publish 按钮新行为、评论 thread 清理、懒加载分包实包验证）
- [ ] `prFileSystemProvider` 大文件行为实测：contents API 对大文件可能不返回 `content` 字段，PR diff 里大文件会显示为空字节（与 repoFileProvider 一致，属既有行为），值得实测一次确认
- [ ] 性能实测：激活耗时、懒加载后 bundle 实测体积（静态部分已完成并修复 P1-P4）

## 进行中

（空）
