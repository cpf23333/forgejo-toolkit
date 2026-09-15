# TODO

短期任务清单。已交付功能的完整记录见 `ROADMAP.md` 的「已完成」一节；更早的历史完成记录由本文件的 git 日志保存。

## 待开始

### 发布前

- [ ] 根 README 引用 `docs/screenshots/` 10 张图片，目录不存在（发布前补截图或移除引用）

### 低优先级

- [ ] issue worktree 重开残留目录时 `baseBranch` 硬编码为 `'main'`（`viewProvider.ts` 的 existsOnDisk 路径不查 API；默认分支非 main 的仓库记录里 baseBranch 错误，目前仅展示用途，危害低）——第二轮复审遗留
- [ ] vscode-tree 内按钮（IconActionButton）的 Enter/Space 键盘激活被库自身 keydown `preventDefault` 抑制——`@vscode-elements/elements` 2.5.1 的 pre-existing 限制（原 vscode-icon 同样如此），升级库或上游修复后复查
- [ ] onboarding 面板的 CSP 只在 HTML 重建时生效：编辑中实例 URL 已并入 `instanceUrls`，但 `http://` 实例在下一次面板重建前，markdown 预览里的实例图片仍被拦（https 实例不受影响，影响面小）

### 走查方向

- [ ] 性能专项检查：激活成本、webview bundle 体积、长列表渲染、git 子进程频率——暂缓
- [ ] 动态端到端走查：重新打包 vsix 后用 tools/ui-review harness 实测功能闭环（多 remote 关联、关联仓库切换器、中文详情页、Publish 按钮新行为、评论 thread 清理）
- [ ] `prFileSystemProvider` 大文件行为实测：contents API 对大文件可能不返回 `content` 字段，PR diff 里大文件会显示为空字节（与 repoFileProvider 一致，属既有行为），值得实测一次确认

## 进行中

（空）
