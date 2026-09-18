# TODO

短期任务清单。已交付功能的完整记录见 `ROADMAP.md` 的「已完成」一节；更早的历史完成记录由本文件的 git 日志保存。

## 待开始

### 发布前

- [ ] 根 README 引用 `docs/screenshots/` 10 张图片，目录不存在（发布前补截图或移除引用）

### 规划中的功能

- [ ] MCP Server Phase 1 步骤 5 文档（2026-09-17 agent mode 冒烟已通过）——补 README/FAQ/ROADMAP 双语条目，`docs/architecture/mcp-server.md` 从 proposal 转 spec
- [ ] MCP Server：补 Actions 只读工具（2026-09-17 提出）——现状是 MCP 只有 8 个工具，`get_repo`（`client.getRepoDetail`）仅返回仓库信息/README/分支/最近提交，agent 完全看不到工作流运行记录。扩展侧 `ForgejoClient` 已有 `listActionRuns`、`getActionRunJobs`、`getActionJobLog` 等现成方法，缺的只是在 `mcp/tools.ts` 里注册对应工具（建议 `list_action_runs`、`get_action_run_jobs`、`get_action_job_log`，仍为只读）。注意沿用 `MIN_ACTIONS_VERSION` 的 1.19 版本闸门；落地后同步 `docs/architecture/mcp-server.md` 的工具清单
- [ ] MCP Server Phase 1.5：代码读取工具集（2026-09-17 评估，纯只读不触碰写闸门）——agent 目前看不到仓库内容，未 clone 到本地的仓库完全无法操作。`ForgejoClient` 方法全部现成：`get_file_content`/`list_repo_contents`（`getFileContent`/`getRepoContents`）、`list_branches`/`list_tags`、`list_commits`（`getRepoBranchCommits`）、`get_file_history`、`search_repo_files`、`get_pr_diff`（PR 完整 patch，review 类 agent 核心输入，走现有 10KB 截断）
- [ ] MCP Server：review/元数据补充工具（2026-09-17 评估，顺手级）——`list_pull_reviews`（PR 的 APPROVED/CHANGES_REQUESTED 状态，方案文档的 "summarize review comments" 例子需要）、`get_pull_review_comments`（行内评审评论，先确认 timeline 是否已覆盖）、`whoami`（`getCurrentUser`）、`list_releases`、`list_labels`/`list_milestones`、`list_my_repos`、Actions 顺带补 `getActionRunArtifacts`
- [ ] MCP Server Phase 2 写工具（需单独批准，方案已定调）——`create_issue`、`create_comment`、`create_pull_request`、`submit_pull_review`、`merge_pull_request`、`mark_notification_read`；默认关 + 设置逐项开启 + VS Code 逐次确认
- [ ] MCP Server：多实例 fan-out（later refinement）——每实例一个 server 或工具加 `instance` 参数；可选 MCP prompts 预置模板（如 "review 这个 PR"），锦上添花
- [ ] Forgejo v17（约 2026-10 底）发布后：实现 workflow/job rerun（2026-09-17 核对上游）——上游主干已加 `POST /repos/{o}/{r}/actions/runs/{run_id}/rerun` 和 `.../jobs/{job_id}/rerun`（forgejo#13924，仅可 rerun 已完成状态的 run/job），v16.x 不含。落地时用版本闸门（≥17.0），并同步移除 KNOWN_ISSUES 里 rerun 限制条目
- [ ] Forgejo v17 发布后：Actions 日志改 ndjson + 服务端过滤（低优先级）——`GET .../jobs/{job_id}/logs` 新增 `?format=ndjson`（#12820）和 `?q=`/`?qi=` 子串过滤（#12821），可替代纯文本解析并把日志搜索下沉到服务端

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
