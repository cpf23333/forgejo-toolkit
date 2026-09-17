# TODO

短期任务清单。已交付功能的完整记录见 `ROADMAP.md` 的「已完成」一节；更早的历史完成记录由本文件的 git 日志保存。

## 待开始

### 发布前

- [ ] 根 README 引用 `docs/screenshots/` 10 张图片，目录不存在（发布前补截图或移除引用）

### 规划中的功能

- [ ] MCP Server Phase 1（只读 8 工具）——方案见 `docs/architecture/mcp-server.md`，实现已完成待提交；待用户在 VS Code agent mode 冒烟后补步骤 5 文档（README/FAQ/ROADMAP、方案转 spec）

### 第六轮复审缓议项（2026-09-15 四方向复审已修完，以下已评估暂不动）

- [ ] P5 500 条列表全量渲染无分页/虚拟化——大仓库才感知，待性能实测后定

### 低优先级（历史遗留）

- [ ] vscode-tree 内按钮（IconActionButton）的 Enter/Space 键盘激活被库自身 keydown `preventDefault` 抑制——`@vscode-elements/elements` 2.5.1 的 pre-existing 限制（原 vscode-icon 同样如此），升级库或上游修复后复查
- [ ] onboarding 面板的 CSP 只在 HTML 重建时生效：编辑中实例 URL 已并入 `instanceUrls`，但 `http://` 实例在下一次面板重建前，markdown 预览里的实例图片仍被拦（https 实例不受影响，影响面小）

### 走查方向

- [ ] 动态端到端走查：重新打包 vsix 后用 tools/ui-review harness 实测功能闭环（多 remote 关联、关联仓库切换器、中文详情页、Publish 按钮新行为、评论 thread 清理）
- [ ] `prFileSystemProvider` 大文件行为实测：contents API 对大文件可能不返回 `content` 字段，PR diff 里大文件会显示为空字节（与 repoFileProvider 一致，属既有行为），值得实测一次确认
- [ ] 性能实测：激活耗时、懒加载后 bundle 实测体积（静态部分已完成并修复 P1-P4）

## 进行中

（空）
