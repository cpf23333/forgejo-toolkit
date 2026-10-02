# Forgejo API 实现核对清单

本清单用于逐项核对 Forgejo Toolkit 实际调用的 REST API 与 Forgejo 服务端源码实现是否一致。核对时阅读 Forgejo 源码仅用于确认行为，不复制其代码或常量。

核对状态：

- [x] PR Review / Diff
- [x] Issue / PR 详情与操作
- [x] 仓库浏览与文件
- [x] 通知与搜索
- [x] Actions / CI
- [x] 用户与实例
- [x] Release / Branch / Tag
- [x] Markdown 渲染
- [x] 覆盖率核对：客户端实际调用的端点全部在本清单中有记录（`node tools/api-audit/check.mjs` 退出码 0；2026-09-23 首次核对时为 94 个，今天为 82 个，差异见「核对方法」）

---

## 核对方法

本次核对的 Forgejo 源码版本：

- Git commit：`62c6d1c782720308d0a973435c62ce50fdebd99f`
- 本地源码路径：由用户环境决定，后续核对前请提供当前使用的 Forgejo 仓库路径
- 最近一次核对结论：当前清单中所有端点与该版本 Forgejo 源码一致；上一次 diff 复核（`b4d03e7..62c6d1c`）仅涉及代码格式化、webhook 内部事件调整以及当前未使用的新类型（`IssueSuggestion`、`RepoFundingEntry`），不影响已记录端点的行为。
- 2026-09-23 覆盖率补漏：用 `tools/api-audit/check.mjs` 反解 `src/api/client.ts` 实际调用的 94 个生成操作，发现 30 个端点在本文档中**没有任何小节**（Issue/评论附件、Issue 依赖、订阅、时间追踪与 stopwatch、`PUT labels`、`labels`/`milestones`/`assignees` 列表、`GET /version`、`GET /pulls`、`POST /user/repos`、`DELETE /issues/{index}`、release 附件删除、评论 reactions、review 评论删除）。本次仍以同一 commit `62c6d1c` 为基准逐个读源码补齐，并把原先只有概述的分类（附件、依赖、订阅、时间追踪、reactions）升级为逐端点小节；同时修正了 Actions 小节中几处按 GitHub/Gitea 语义写错的字段表（`ActionRun` 没有 `name`/`head_branch`/`conclusion`/`run_number`/`jobs`/`started_at` 等，run 名在 `title`；`ActionRunJob` **有** `name`，但没有 `conclusion`/`started_at`/`completed_at`）。当时覆盖率为 94/94，`check.mjs` 退出码为 0。客户端随后于 2026-09-24 与 2026-09-27 按固定快照重新生成（`d3e4677`、`a301201`），因此今天同一脚本反解出的是 82 个端点，仍全部有记录（退出码 0）：计数只说明客户端调用了多少个端点，端点是否被记录由退出码判定。
- 生成客户端规格来源：`packages/forgejo-api/kubb.config.ts` 现在读取仓库内的固定快照 `packages/forgejo-api/spec/swagger.v1.json`（2026-09-23 抓取，326 条路径；刷新方式见 `packages/forgejo-api/spec/README.md` 与 `spec:update` 脚本）。快照是 Forgejo `v16.0.0` tag 上 `templates/swagger/v1_json.tmpl` 的逐字节副本，因此文件里的 `info.version` 与 `basePath` 仍是模板占位符 `{{AppVer | JSEscape}}` / `{{AppSubUrl | JSEscape}}/api/v1`（`spec/swagger.v1.json:22,24`）——版本号只能从固定的 tag `v16.0.0` 读取，不能从文件内容推断。因此 `packages/forgejo-api/src/generated` 中的类型对应这份快照，可能仍落后于本清单核对的源码版本。例如 `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` 的 `step` 查询参数已存在于上游（`routers/api/v1/repo/action.go:1657-1666`），但生成类型 `RepoGetActionJobLogsQueryParams` 只有 `attempt`（`packages/forgejo-api/src/generated/types/RepoGetActionJobLogs.ts:28-34`）。生成目录首次提交于 2026-06-30（`52e21e8`），随后于 2026-08-11（`8d67aa5`，更新 Forgejo API 至 16）与 **2026-09-24（`d3e4677`，`chore(api): regenerate the client from the pinned snapshot`）** 更新，最近一次即为 `d3e4677`（`git log -1 --date=short -- packages/forgejo-api/src/generated`）。

> 历史核对记录由本文件的 git 日志保存，无需在正文中保留。

核对步骤：

1. 在 [Forgejo 源码](https://codeberg.org/forgejo/forgejo) 中找到对应路由的 handler 函数。
2. 确认请求参数校验、默认值、必填项。
3. 确认响应字段的实际构造逻辑（哪些字段一定存在、哪些条件下存在）。
4. 确认错误码和错误消息（404 含义、权限不足的表现等）。
5. 记录与本项目当前用法的差异，必要时更新 `KNOWN_ISSUES.md`。

---

## PR Review / Diff

### `GET /repos/{owner}/{repo}/pulls/{index}`

- [x] 路径与 HTTP 方法：GET，handler `GetPullRequest`
- [x] 参数 `index` 类型：int64，从 path 解析
- [x] 响应字段 `head.sha`、`base.ref`、`mergeable`、`draft`、`state`、`html_url` 稳定存在，由 `convert.ToAPIPullRequest` 构造
- [x] `mergeable` 字段是 boolean，模型字段为 `bool`；不存在时为 `false`
- [x] 404 表示 PR 不存在（`IsErrPullRequestNotExist`），非权限问题
- [x] 源码位置：`routers/api/v1/repo/pull.go:200-248`
- [x] 差异记录：无

### `GET /repos/{owner}/{repo}/issues/{index}`（用于 PR 附件）

- [x] PR 与 Issue 共享 index，issues 端点返回同一 `Issue` 模型对象
- [x] `assets` 字段在 `repoGetPullRequest` 中不加载；issues 端点通过 `issueGetIssue` 会加载 `attachments`，字段名为 `assets`（API 转换时重命名）
- [x] 源码位置：`routers/api/v1/repo/issue.go`（Issue handler）；`services/convert/issue.go`（assets 字段）
- [x] 差异记录：当前 workaround 正确，已在 `KNOWN_ISSUES.md` 记录

### `GET /repos/{owner}/{repo}/pulls/{index}/commits`

- [x] 参数 `files` 与 `verification` 默认均为 true；显式传 `files=false` 可关闭以减少响应大小
- [x] `limit` 默认值由 `utils.GetListOptions` 决定（一般为 30）
- [x] 返回 `api.Commit` 数组，每个 commit 的 `files` 字段在 `files=true` 时包含 `CommitAffectedFiles`（仅 filename + status）
- [x] 源码位置：`routers/api/v1/repo/pull.go:1406-1525`
- [x] 差异记录：无

### `GET /repos/{owner}/{repo}/pulls/{index}/files`

- [x] 返回 `api.ChangedFile` 数组，字段包括 `filename`、`previous_filename`、`status`、`additions`、`deletions`、`changes`、`html_url`、`contents_url`、`raw_url`
- [x] `status` 取值：added / deleted / changed / renamed / copied
- [x] 分页参数 `page`/`limit` 有效，默认 page=1，limit 由 listOptions 决定
- [x] 源码位置：`routers/api/v1/repo/pull.go:1528-1666`；`services/convert/convert.go:517`
- [x] 差异记录：无

### `GET /repos/{owner}/{repo}/compare/{basehead}` (`repoCompareDiff`)

- [x] `basehead` 支持 `base...head`（merge base 到 head）和 `base..head`（base 直接到 head）两种分隔符
- [x] 响应 `files` 是每个 commit 的 `CommitAffectedFiles` 简单合并，不计算净变更
- [x] `CommitAffectedFiles` 只有 `filename` 和 `status` 两个字段（`modules/structs/repo_commit.go:70-72`），status 只可能是 `added`/`removed`/`modified`（`services/convert/git_commit.go:197-205`），因此 compare 端点无法报告重命名或复制
- [x] compare 响应不含 `previous_filename`；`previous_filename` 只在 `GET /repos/{owner}/{repo}/pulls/{index}/files` 的 `api.ChangedFile` 上返回（`modules/structs/pull.go:110-113`）
- [x] 源码位置：`routers/api/v1/repo/compare.go:17-100`
- [x] 差异记录：与 `repoGetPullRequestFiles` 的 `status` 枚举不完全一致（compare 只返回 `added`/`removed`/`modified`，files 端点返回 `added`/`deleted`/`changed`/`renamed`/`copied` 等），当前 `getPullRequestFilesFromCompare` 已做兼容映射，基本正确；compare 不提供重命名信息，重命名在其中表现为不相关的 removed 与 added 两条，需要旧路径时必须走 `/pulls/{index}/files`

### `GET /repos/{owner}/{repo}/pulls/{index}.{diffType}` (`repoDownloadPullDiffOrPatch`)

- [x] `diffType` 仅支持 `diff` 和 `patch`
- [x] 响应 `Content-Type: text/plain`
- [x] `?binary=true` 可包含二进制变更，使输出适用于 `git apply`
- [x] 源码位置：`routers/api/v1/repo/pull.go:335-396`
- [x] 差异记录：无

### `GET /repos/{owner}/{repo}/pulls/{index}/reviews`

- [x] 返回所有 review，包括 PENDING review（但 PENDING review 仅对作者和管理员可见）
- [x] 响应字段 `state`、`body`、`commit_id`、`stale`、`official`、`dismissed`、`comments_count`、`submitted_at`、`updated_at`
- [x] `comments_count` 仅统计代码评论（`CodeCommentsCount`）
- [x] 源码位置：`routers/api/v1/repo/pull_review.go:27-109`；`services/convert/pull_review.go:16-80`
- [x] 差异记录：无

### `GET /repos/{owner}/{repo}/pulls/{index}/reviews/{id}/comments`

- [x] 返回 `PullReviewComment` 数组
- [x] 字段映射：
  - `path` -> `comment.TreePath`
  - `commit_id` -> `comment.CommitSHA`
  - `original_commit_id` -> `comment.OldRef`
  - `position` -> 新行号（`line > 0`）
  - `original_position` -> 旧行号（`line < 0` 时的绝对值）
  - `extra_lines_count` -> 多行评论覆盖的额外行数
  - `diff_hunk` -> 截取的 diff 片段
- [x] 行号规则：服务端存储的 `Line` 为 int64，正值为新文件行号，负值为 `-1 * 旧文件行号`
- [x] 源码位置：`routers/api/v1/repo/pull_review.go:162-209`；`services/convert/pull_review.go:82-107`
- [x] 差异记录：无

### `POST /repos/{owner}/{repo}/pulls/{index}/reviews`

- [x] `event` 取值：APPROVED / REQUEST_CHANGES / COMMENT / PENDING（空字符串也被视为 PENDING）
- [x] `event=COMMENT` 且带 `comments` 时，`body` 可为空（`needsBody=false`）
- [x] `event=PENDING` 且带 `comments` 时，`body` 必须非空（`needsBody=true`）—— 当前代码用 `.` 占位，与源码一致
- [x] `comments` 元素字段为 `path`、`body`、`old_position`、`new_position`、`extra_lines_count`；无 `side` 或 `position` 字段
- [x] 行号规则与读取时相反：`new_position` 对应正 line，`old_position` 对应负 line
- [x] `CommitID` 为空时，服务端自动取 PR head 的最新 commit id
- [x] 创建 `event=COMMENT` 时，源码会先创建 pending 评论，再调用 `SubmitReview` 转为 COMMENT review；最终 review state 为 COMMENT
- [x] 源码位置：`routers/api/v1/repo/pull_review.go:431-553`；`services/pull/review.go:119-218`
- [x] 差异记录：当前 `createPullReviewWithComment` 使用 `event: 'COMMENT'` 且 body 为空，符合源码；`createPendingPullReview` 使用 body='.' 占位，符合源码要求

### `POST /repos/{owner}/{repo}/pulls/{index}/reviews/{id}/comments`

- [x] 参数与 `.../reviews` 的 `comments` 元素一致（`CreatePullReviewCommentOptions`）
- [x] 仅允许向 PENDING review 追加 comment；对已提交 review 追加会报错或创建新 review（实际行为依赖 `prepareSingleReview` 中 review 类型检查，但源码未阻止非 pending）
- [x] 源码位置：`routers/api/v1/repo/pull_review.go:279-369`
- [x] 差异记录：当前未使用该接口向已提交 review 追加，无风险

### `POST /repos/{owner}/{repo}/pulls/{index}/reviews/{id}` (`repoSubmitPullReview`)

- [x] 仅 PENDING review 可提交；已提交 review 返回 422
- [x] `event` 取值同创建：APPROVED / REQUEST_CHANGES / COMMENT / PENDING；PENDING 会报错
- [x] `body` 为空字符串时，服务端会覆盖原有 review body 为空
- [x] 提交后 review state 变为目标 event 对应状态
- [x] 源码位置：`routers/api/v1/repo/pull_review.go:555-641`
- [x] 差异记录：当前 `submitPullReview` 默认 `event='COMMENT'` 且 `body=''`，符合源码；但如需要保留原 body，需显式传入

### `DELETE /repos/{owner}/{repo}/pulls/{index}/reviews/{id}`

- [x] 允许删除任何类型的 review（包括已提交）
- [x] 仅允许管理员或 review 作者本人删除
- [x] 源码位置：`routers/api/v1/repo/pull_review.go:371-429`
- [x] 差异记录：无

### `DELETE /repos/{owner}/{repo}/pulls/{index}/reviews/{id}/comments/{comment}`

- [x] 请求：路径参数 `owner`、`repo`、`index`（PR index）、`id`（review id）、`comment`（comment id）全部为 path 参数，无 body、无查询参数；生成客户端的参数名与服务器路由逐段一致（服务器与生成客户端都用 `comment`，旧小节写作 `{commentId}` 是错的）
- [x] 响应：**204 无响应体**（成功与「评论类型不匹配」两种情况都返回 204）；扩展不读取返回值
- [x] 作者 vs 仓库写者：评论作者本人 **或** 对该仓库 issues/PR 有写权限者（仓库 writer/admin）都能删；非作者且无写权限者得 403；`CanWriteIssuesOrPulls` 按评论所属 issue 是否为 PR 分别检查 `TypeIssues`/`TypePullRequests` 单元
- [x] 404 vs 403：评论不存在 404；评论不属于路径中的仓库、或调用者对该 issue/PR 无读权限 404；更早的中间件也会产生 404（仓库不存在、无仓库读权限、Code 单元被禁用）与 403（非 Code 单元 reader）
- [x] 作用域：`Repository`（DELETE → 需 `write:repository`）
- [x] 源码位置：`routers/api/v1/api.go:1008-1017,1027,1096`、`routers/api/v1/repo/pull_review.go:1056-1100`、`routers/api/v1/repo/issue_comment.go:699-719`、`routers/api/v1/permissions/req_valid_comment_id.go:10-20`、`models/issues/comment.go:1248-1257`、`models/perm/access/repo_permission.go:111-116`
- [x] 差异记录：URL、参数顺序与响应处理与服务器一致（403/404 经 `packages/forgejo-toolkit/src/api/errors-core.ts:89-103` 渲染为不同提示）。需注意服务端比路径暗示的更宽松：评论按**全局 comment ID** 取出，`index` 与 review `id` 完全不参与查找或一致性校验；若 `{comment}` 指向非 `CommentTypeCode` 的评论（例如普通 issue 评论），服务端返回 **204 但不删除**——调用方会误判成功

### `GET /repos/{owner}/{repo}/pulls`

- [x] 查询参数：`state`（`open`/`closed`/`all`）、`sort`（`oldest`/`recentupdate`/`recentclose`/`leastupdate`/`mostcomment`/`leastcomment`/`priority`）、`milestone`、`labels[]`、`poster`、`base`、`head`、`page`、`limit`；**没有关键字过滤参数**（`client.ts:1254` 的注释正确，带 query 时改走 issues 端点）
- [x] `state` 为空或为 `all` 时 `listPullRequestStatement` 不加 `is_closed` 过滤，返回 open + closed，swagger 的 “default: open” 不成立（`models/issues/pull_list.go:38-41`）；`poster` 指向不存在的用户 400（`routers/api/v1/repo/pull.go:129-140`）
- [x] 响应：`[]*api.PullRequest`，**可能含 `null` 元素**——`convert.ToAPIPullRequest` 在 `LoadIssue`/`LoadRepo`/`LoadBaseRepo`/`LoadHeadRepo` 失败时 `return nil`，列表直接把 nil 放进切片（`services/convert/pull.go:24-51`）
- [x] `Page <= 0` 被强制为 1，因此始终分页；默认页 30、上限 50，同时设置 `Link` 与 `X-Total-Count`
- [x] 权限：`mustAllowPulls()`（PR 单元禁用 404）+ `reqRepoReader(unit.TypeCode)`（Code 单元禁用 404、非 reader 403）+ `repoAssignment`/`repoAccess()`；作用域 `Repository`（GET → 需 `read:repository`）
- [x] 源码位置：`routers/api/v1/api.go:985-987,1027,1096`、`routers/api/v1/repo/pull.go:49-197`、`models/issues/pull_list.go:22-41,175-193`、`services/convert/pull.go:24-51`
- [x] 差异记录：扩展的 `state`/`page`/`limit` 传参正确。唯一潜在风险是上述 `null` 元素未判空——`packages/forgejo-toolkit/src/statusBar/createPrStatusBar.ts:30-31` 的 `isOpenPrForBranch(pr, …)` 直接访问 `pr.head`，理论上会抛 `TypeError`；建议在 `getRepoPullRequests` 内过滤空元素

---

## Issue / PR 详情与操作

### `GET /repos/{owner}/{repo}/issues/{index}`

- [x] PR 与 Issue 共享 index；当 index 对应 PR 时，issues 端点返回 PR 的 Issue 部分
- [x] `assets`（attachments）字段存在，由 `GetIssueWithAttrsByIndex` 加载
- [x] `state`、`labels`、`milestone`、`assignees` 结构由 `convert.ToAPIIssue` 构造
- [x] 源码位置：`routers/api/v1/repo/issue.go:619-662`
- [x] 差异记录：无

### `GET /repos/{owner}/{repo}/issues`

- [x] 支持 `state`（open/closed/all，默认 open）、`type`（issues/pulls）、`q`、`limit`、`page`
- [x] `type=issues` 过滤 `is_pull=false`，`type=pulls` 过滤 `is_pull=true`
- [x] `limit` 为 0 时默认使用 `setting.UI.IssuePagingNum`；超过 `setting.API.MaxResponseItems` 会被截断
- [x] 源码位置：`routers/api/v1/repo/issue.go:341-617`
- [x] 差异记录：无

### `POST /repos/{owner}/{repo}/issues`

- [x] 必填字段：`title`；`body` 可选
- [x] 非仓库写入者无法设置 labels；`deadline` 仅写入者可用
- [x] 附件不能随创建一起上传，必须先创建 issue 再调用附件接口（与当前 pending 附件机制一致）
- [x] 源码位置：`routers/api/v1/repo/issue.go:665-785`
- [x] 差异记录：无

### `PATCH /repos/{owner}/{repo}/issues/{index}`

- [x] 可编辑字段：title、body、ref、deadline、assignees、milestone、labels、state
- [x] labels 更新为全量替换（`ReplaceIssueLabels`）
- [x] 仅 issue 作者或具有写入权限者可编辑；关闭/打开受依赖检查限制
- [x] 源码位置：`routers/api/v1/repo/issue.go:787-966`
- [x] 差异记录：无

### `POST /repos/{owner}/{repo}/issues/{index}/comments`

- [x] 请求体字段：`body`、`updated`（可选，用于并发控制）
- [x] 响应 201 返回完整 `api.Comment`，包含 attachments
- [x] 源码位置：`routers/api/v1/repo/issue_comment.go:357-422`
- [x] 差异记录：无
- [x] MCP 写工具 `create_issue_comment`（`mcp/tools.ts`）是这条端点的**写侧**调用点，经 `ForgejoClient.createIssueComment`（`src/api/client.ts`）发起；它不做服务端幂等（Forgejo 没有幂等键概念），重复调用就重复创建，客户端侧的幂等键与审计见 `docs/architecture/mcp-server.md` 的「Write tools」一节
- [x] 第二个写侧调用点是 PR 行级评审评论的**回复**（`src/comments/pullReviewCommentController.ts` 的 `replyToComment`，同样经 `createIssueComment`，2026-10-02 起）：回复是 PR 时间线里的普通评论，正是这条端点让"Gitea/Forgejo 的 PR 就是 issue"这件事直接可用；它不需要 `write:issue` 之外的权限，也不经过任何 review 端点
- [x] 上述 MCP 调用点所需 scope 为 `write:issue`：token 缺该 scope 时服务端返回 403（`Permission denied. The access token may lack the required scope.`），而 MCP 子进程 / 宿主侧 toast 在无头路径是 no-op，因此工具结果文本本身必须带出该信息（`mcp/__tests__/server.test.ts` 锁定）

### `PATCH /repos/{owner}/{repo}/issues/comments/{id}`

- [x] 仅允许评论作者或具有 issue/pr 写入权限者编辑
- [x] 非 content 类型评论返回 204
- [x] 源码位置：`routers/api/v1/repo/issue_comment.go:490-625`
- [x] 差异记录：无

### `DELETE /repos/{owner}/{repo}/issues/comments/{id}`

- [x] 删除条件：作者本人或具有 issue/pr 写入权限者
- [x] 评论类型不匹配时返回 204 而非删除
- [x] 源码位置：`routers/api/v1/repo/issue_comment.go:627-719`
- [x] 差异记录：无

### `GET /repos/{owner}/{repo}/issues/{index}/comments`

- [x] 返回普通评论（`CommentTypeComment`），不包含 timeline 事件
- [x] `GET /repos/{owner}/{repo}/issues/{index}/timeline` 才包含 timeline 事件（`issueGetCommentsAndTimeline`）
- [x] timeline 接口支持 `page`/`limit`，过滤掉 `CommentTypeCode`（行级评论走 PR review 接口）
- [x] 源码位置：`routers/api/v1/repo/issue_comment.go:27-124`、`126-222`
- [x] 差异记录：当前使用 `issueGetCommentsAndTimeline` 获取评论+时间线，符合源码

### Issue reactions

- [x] `GET /repos/{owner}/{repo}/issues/{index}/reactions` 返回 issue 反应列表
- [x] `POST /repos/{owner}/{repo}/issues/{index}/reactions` 创建反应，`content` 取值与 comment reactions 一致
- [x] `DELETE /repos/{owner}/{repo}/issues/{index}/reactions` 按 `content` 精确匹配删除
- [x] `content` 必须命中 `setting.UI.Reactions` 白名单，否则 403（`models/issues/reaction.go:250-253`）；POST 在已存在同一 reaction 时返回 **200** 并回传已存在的 reaction，新建才 201；DELETE 即使没有匹配行也返回 **200**（`DeleteReaction` 不检查影响行数）
- [x] POST/DELETE 受 `reqIssueUnlockedOrCanWrite` 限制（issue 锁定时需写权限，否则 403）；`page` 缺省时服务端不分页（`models/issues/reaction.go:167-169`），扩展传 `page`/`limit=50` 无影响
- [x] 源码位置：`routers/api/v1/repo/issue_reaction.go:211-290,292-333,335-374,376-420`
- [x] 差异记录：无

### Comment reactions

- [x] `GET /repos/{owner}/{repo}/issues/comments/{id}/reactions` 返回评论反应列表，**无分页参数、无 `X-Total-Count`**，扩展也是不分页调用（`client.ts:1369-1371`）；GET 只需 `reqValidCommentID`（评论存在、属于该仓库、调用者可读其 issue/PR）
- [x] `POST /repos/{owner}/{repo}/issues/comments/{id}/reactions` 与 `DELETE /repos/{owner}/{repo}/issues/comments/{id}/reactions`：`content` 与 issue reactions 共用同一 `EditReactionOption` 与白名单（不在白名单 403）；受 `reqCommentIssueUnlockedOrCanWrite("id")` 限制——评论所属 issue/PR 锁定时需要写权限，否则 403；POST 已存在 200 / 新建 201，DELETE 恒 200
- [x] 源码位置：`routers/api/v1/repo/issue_reaction.go:20-80,376-420`、`routers/api/v1/api.go:1125-1126`、`models/issues/reaction.go:167-169,250-253`
- [x] 差异记录：无（扩展只消费 reaction 列表，未使用 `created_at`）

### Issue 附件 / 依赖 / 订阅 / 时间追踪（概述）

- [x] 这几类行为原先只有概述 bullet；2026-09-23 的补漏核对（仍以 `62c6d1c` 为基准）已把它们升级为下面的逐端点小节，概述结论仍然成立：订阅是 `check`/`{user}` 的 PUT/DELETE 且用户名为路径参数；依赖列表/添加/删除用 `index`/`owner`/`repo` 指定；时间追踪含 start/stop/delete stopwatch 与 times 列表/添加/删除（另有一条独立的 `DELETE .../times` 重置本人计时）
- [x] 源码位置：`routers/api/v1/repo/issue_subscription.go`、`issue_stopwatch.go`、`issue_tracked_time.go`、`issue_dependency.go`、`issue_attachment.go`、`issue_comment_attachment.go`

### `POST /repos/{owner}/{repo}/issues/{index}/assets`

- [x] 请求：`multipart/form-data`，文件字段名必须是 `attachment`（缺失时 `FormFile` 失败返回 500，不是 swagger 说的 400）；查询参数 `name` 覆盖上传文件名；`updated_at`（RFC 3339）用于改写 issue 更新时间，解析失败 500、调用者不是仓库 admin/owner 时 403；文件类型不在 `setting.Attachment.AllowedTypes` 白名单时 422。API 路径**不**校验 `setting.Attachment.MaxSize`（2048）与 `MaxFiles`（5），这两个值只经 `/settings/api` 暴露给 web 上传界面
- [x] 响应：201 + `api.Attachment`（`id`、`name`、`size`、`download_count`、`created_at`、`uuid`、`browser_download_url`、`type`）；扩展消费 `uuid`/`name`/`size`/`browser_download_url`（为空时回退 `{instanceUrl}/attachments/{uuid}`）
- [x] 权限：`reqToken()` + `mustNotBeArchived()`（归档 423）+ `EnforceQuotaAPI(LimitSubjectSizeAssetsAttachmentsIssues, QuotaTargetRepo)`（超配额 413）；`/assets` 组受 `mustEnableAttachments()`（`setting.Attachment.Enabled=false` 时 404），`/{index}` 组还受 `mustEnableLocalIssuesIfIsIssue()`；handler 内 `canUserWriteIssueAttachment` 要求 issue 作者 / repo admin / site admin / issue-pull 写权限，否则 403
- [x] 源码位置：`routers/api/v1/api.go:1179-1187`、`routers/api/v1/repo/issue_attachment.go:115-231,379-387`、`routers/api/v1/permissions/must_enable_attachments.go:10-15`、`services/context/quota.go:93-99,117-121`、`services/attachment/attachment.go:76-86`
- [x] 差异记录：请求形状与响应映射一致；唯一缺口是上传响应未被映射 `id`（`client.ts:1397-1418`），新建的 issue 附件在刷新 `GET /issues/{index}` 之前没有 `id`，删除只能靠 `assets` 列表

### `DELETE /repos/{owner}/{repo}/issues/{index}/assets/{attachment_id}`

- [x] 请求：仅路径参数 `owner`、`repo`、`index`、`attachment_id`（int64），无 body、无查询参数；响应 204 无 body（shared request 包装器把 204/205/304 归一为 `{}`，`packages/shared/src/request/index.ts:126-127`）
- [x] 权限：`reqToken()` + `mustNotBeArchived()`（423）；组级 `mustEnableAttachments()`、`mustEnableLocalIssuesIfIsIssue()`、`mustEnableIssuesOrPulls()`、`repoAccess`；`getIssueAttachmentSafeWrite` → `canUserWriteIssueAttachment`（作者/repo admin/site admin/写权限）否则 403；附件必须属于该 repo、`IssueID != 0` 且等于路径 index 对应 issue，否则 404（防止用别的 issue 的 attachment_id 越权删除）
- [x] 源码位置：`routers/api/v1/api.go:1183-1186`、`routers/api/v1/repo/issue_attachment.go:303-357,359-405`
- [x] 差异记录：无

### `GET /repos/{owner}/{repo}/issues/comments/{id}/assets`

- [x] 请求：仅路径参数 `owner`、`repo`、`id`（评论 ID），无查询参数、无 body；200 + `api.Attachment` 数组（`convert.ToAPIAttachments`），字段同 issue 附件；扩展消费 `id`/`uuid`/`name`/`size`/`browser_download_url`（`client.ts:1527-1545`）
- [x] 权限：`repoAccess` + `mustEnableIssuesOrPulls()`；`/{id}` 组受 `reqValidCommentID("id")`（评论必须存在、属于该 repo、且当前用户可读其 issue/PR，否则 404）；`/assets` 组受 `mustEnableAttachments()`；纯读，无写权限要求；**无分页、无 `X-Total-Count`**，一次返回该评论全部附件
- [x] 源码位置：`routers/api/v1/api.go:1127-1135`、`routers/api/v1/repo/issue_comment_attachment.go:77-117`、`routers/api/v1/permissions/req_valid_comment_id.go:10-20`、`services/context/api.go:294-319`
- [x] 差异记录：无。补充扩展的有意取舍：只有评论 body 命中 `ATTACHMENT_REFERENCE_REGEX`（`/attachments/<uuid>`，`client.ts:165`）时才请求该接口（`client.ts:1516-1553`），因此「上传过但正文里已取消引用」的附件不会被列出——与服务端行为不冲突

### `POST /repos/{owner}/{repo}/issues/comments/{id}/assets`

- [x] 请求：`multipart/form-data`，文件字段名 `attachment`（缺失返回 500）；查询参数 `name` 覆盖文件名；`updated_at` 语义与 issue 附件相同（非法 500、无 admin/owner 权限 403）；文件类型不在白名单 422
- [x] 响应：201 + `api.Attachment`；`IssueID` 取 `comment.IssueID`、`CommentID` 取 `comment.ID`；扩展映射 `id`/`uuid`/`name`/`size`/`browser_download_url`（`client.ts:1590-1612`）
- [x] 权限：`reqToken()` + `mustNotBeArchived()`（423）+ `EnforceQuotaAPI(...)`（413）+ `reqValidCommentID` + `mustEnableAttachments()`；handler `canUserWriteIssueCommentAttachment` 只接受「评论作者」或 `CanWriteIssuesOrPulls`——**没有** `IsUserRepoAdmin()`/`IsUserSiteAdmin()` 兜底，这是与 issue 附件写权限判定的唯一差别；上传后会调用 `UpdateComment` 刷新评论时间
- [x] 源码位置：`routers/api/v1/api.go:1127-1135`、`routers/api/v1/repo/issue_comment_attachment.go:119-246,376-384`
- [x] 差异记录：无

### `DELETE /repos/{owner}/{repo}/issues/comments/{id}/assets/{attachment_id}`

- [x] 请求：仅路径参数 `owner`、`repo`、`id`、`attachment_id`，无 body、无查询参数；响应 204 无 body
- [x] 权限：`reqToken()` + `mustNotBeArchived()`（423）+ `reqValidCommentID` + `mustEnableAttachments()`；`getIssueCommentAttachmentSafeWrite` → `canUserWriteIssueCommentAttachment`（评论作者或写权限，无 admin 兜底）否则 403；附件必须属于该 repo、`IssueID != 0`、`CommentID != 0` 且 `CommentID == comment.ID`，否则 404
- [x] 源码位置：`routers/api/v1/api.go:1131-1134`、`routers/api/v1/repo/issue_comment_attachment.go:315-367,369-415`
- [x] 差异记录：无

### `GET /repos/{owner}/{repo}/issues/{index}/dependencies`

- [x] 请求：路径参数 + 可选查询参数 `page`（缺省 1）、`limit`（为 0 时取 `setting.API.DefaultPagingNum` = 30，超过 `MaxResponseItems` = 50 时截断为 50）；无 body
- [x] 响应：200 + `api.Issue` 数组（`IssueListWithoutPagination`，**不带** `X-Total-Count`/`Link`），扩展消费整份 `ForgejoIssue[]`。不可读的 blocker 会被替换：只能读不能写时返回 `title="HIDDEN"` 的占位 issue（`index=0`），可写时返回只含 `repo_id`/`index`/`title`/`is_closed`/`is_pull` + `repository{id,name,owner_name}` 的精简 issue
- [x] 权限：`repoAccess` + `mustEnableIssuesOrPulls()` + `mustEnableLocalIssuesIfIsIssue()`，**无** `reqToken()`（公开仓库可匿名读取）；仓库 `IsDependenciesEnabled` 为 false 时 404；doer 对目标 issue 无读权限时 404
- [x] 源码位置：`routers/api/v1/api.go:1188-1189`、`routers/api/v1/repo/issue_dependency.go:21-150`（分页 76-82、HIDDEN 逻辑 118-147）、`models/repo/issue.go:52-60`、`services/convert/utils.go:15-22`
- [x] 差异记录：**扩展调用时 `params` 传 `undefined`（`client.ts:1338-1342`），服务端因此用 page=1、limit=30，且响应没有总数头**；依赖超过 30 个时列表被静默截断，扩展既拿不到分页信息也无法判断完整性。另外精简/`HIDDEN` 占位项会被原样透传到 webview（`viewProvider.ts:1490-1497`），未做过滤

### `POST /repos/{owner}/{repo}/issues/{index}/dependencies`

- [x] 请求：JSON body `api.IssueMeta{index, owner, repo}`；URL 的 `index` 是**被阻塞的 target**，body 的 `index` 才是依赖项（blocker）；扩展传 `{ index: dependencyIndex, owner, repo }`，语义正确
- [x] 响应：201 + `convert.ToAPIIssue(target)`（被修改的 target issue，不是新增的依赖 issue）
- [x] 权限：`reqToken()` + `mustNotBeArchived()`（423）；target 仓库未启用 dependencies 或不可写、依赖项不可读均为 404（不是 403）；跨仓库依赖受 `setting.Service.AllowCrossRepositoryDependencies` 控制，关闭时 400 + `CrossRepositoryDependencies not enabled`
- [x] 源码位置：`routers/api/v1/api.go:1190`、`routers/api/v1/repo/issue_dependency.go:152-212,496-568`、`modules/structs/issue.go:272-281`
- [x] 差异记录：无

### `DELETE /repos/{owner}/{repo}/issues/{index}/dependencies`

- [x] 请求：`DELETE` + JSON body `api.IssueMeta{index, owner, repo}`（服务端用同一个 bind；集成测试 `tests/integration/api_issue_test.go:905-909` 同样以 DELETE + JSON body 调用），扩展确实发送 body（`client.ts:1349-1352`）
- [x] 响应：**201** + `convert.ToAPIIssue(target)`；swagger 注释写 200，实现是 `ctx.JSON(http.StatusCreated, …)`（`issue_dependency.go:243-244,273`），文档与实现不一致
- [x] 权限：同 POST（`reqToken()` + `mustNotBeArchived()`，dependencies 未启用 / target 不可写 / dependency 不可读均 404）；按 `DependencyTypeBlockedBy` 精确删除该方向
- [x] 源码位置：`routers/api/v1/api.go:1191`、`routers/api/v1/repo/issue_dependency.go:214-274,570-594`、`tests/integration/api_issue_test.go:905-909`
- [x] 差异记录：无（扩展把返回值当 unknown，未依赖 200/201 的差异）

### `GET /repos/{owner}/{repo}/issues/{index}/subscriptions/check`

- [x] 请求：仅路径参数 `owner`、`repo`、`index`，无查询参数、无 body；200 + `api.WatchInfo`（`subscribed`、`ignored`、`reason`、`created_at`、`url`、`repository_url`），其中 `ignored` 恒为 `!subscribed`、`reason` 恒为 `null`；扩展只消费 `subscribed`（`viewProvider.ts:1188-1195`）
- [x] 权限：`reqToken()`（无 token / 匿名 403）；组级 `repoAccess` + `mustEnableIssuesOrPulls()` + `mustEnableLocalIssuesIfIsIssue()`；只查询调用者自己的订阅状态，不要求写权限；issue 不存在 404；无分页
- [x] 源码位置：`routers/api/v1/api.go:1169-1174`、`routers/api/v1/repo/issue_subscription.go:150-200`、`modules/structs/repo_watch.go:11-18`
- [x] 差异记录：无

### `PUT /repos/{owner}/{repo}/issues/{index}/subscriptions/{user}`

- [x] 请求：要订阅的用户名是**路径参数** `{user}`，无 body、无查询参数（不能用 body 指定其他用户）
- [x] 响应：状态发生变化 201、本来就是该状态 200，两者 body 均为空（扩展按 unknown 处理，`client.ts:1298-1300`）；swagger 里写的 304 实际实现是 403
- [x] 权限：`reqToken()`；handler 内只允许 `user.ID == doer.ID` 或 site admin，否则 403（`issue_subscription.go:124-127`）——普通用户只能订阅自己；`{user}` 不存在 404
- [x] 源码位置：`routers/api/v1/api.go:1172`、`routers/api/v1/repo/issue_subscription.go:18-60,106-148`
- [x] 差异记录：无（扩展传 `currentUsername`，始终是自己，满足 self-only 限制，见 `IssueDetail.vue:347-354`）

### `DELETE /repos/{owner}/{repo}/issues/{index}/subscriptions/{user}`

- [x] 请求：`DELETE`，用户名同为路径参数，无 body、无查询参数；响应：已取消订阅 200、本次取消成功 201，body 为空（swagger 的 304 实际是 403）
- [x] 权限：`reqToken()`；同样只允许本人或 site admin，否则 403；`{user}` 不存在 404；组级 `repoAccess` + `mustEnableIssuesOrPulls()` + `mustEnableLocalIssuesIfIsIssue()`
- [x] 源码位置：`routers/api/v1/api.go:1173`、`routers/api/v1/repo/issue_subscription.go:62-104,106-148`
- [x] 差异记录：无

### `PUT /repos/{owner}/{repo}/issues/{index}/labels`

- [x] 请求：JSON body `api.IssueLabelsOption{labels, updated_at}`；`labels` 是 `[]any`，元素要么全是数字（label ID）要么全是字符串（label 名），混用或其他类型返回 400；`updated_at` 非空时要求调用者是仓库 admin/owner，否则 403；空数组等价于清空所有标签。扩展只传数字 ID 数组 `{ labels }`（`client.ts:1290-1292`）
- [x] 响应：200 + `LabelListWithoutPagination`（`Label[]`：`id`、`name`、`exclusive`、`is_archived`、`color`、`description`、`url`），是替换后的完整标签列表
- [x] 权限：`reqToken()` + handler 内 `CanWriteIssuesOrPulls`（不满足 403 且 body 为空，不是 `reqRepoWriter`）；组级 `mustEnableIssuesOrPulls()` + `mustEnableLocalIssuesIfIsIssue()`；无分页
- [x] 源码位置：`routers/api/v1/api.go:1149-1155`、`routers/api/v1/repo/issue_label.go:215-270,332-393`、`models/issues/label.go:313-324`、`services/issue/label.go:70-83`
- [x] 差异记录：无；语义提示：`replaceIssueLabels` 是全量替换，传空数组会清空标签（扩展只在 `Array.isArray(labels)` 时调用，`viewProvider.ts:1119-1121`）

### `DELETE /repos/{owner}/{repo}/issues/{index}`

- [x] 请求：仅路径参数 `owner`、`repo`、`index`，无 body、无查询参数；成功 204 空 body
- [x] 权限：`reqToken()` + `reqAdmin()` + `context.ReferencesGitRepo()`——`reqAdmin` 只认仓库 admin 或站点管理员（`routers/api/v1/permissions/req_admin.go:13-24`），因此普通 issue 作者或仅有写权限者删除会 403
- [x] 删除 PR 时同时删除 `refs/pull/{index}/head` 并先取消 pin（`services/issue/issue.go:171-202`）；外层还有 issue token scope + `mustEnableIssuesOrPulls()` + `mustEnableLocalIssuesIfIsIssue()`（`api.go:1204-1221`）
- [x] 源码位置：`routers/api/v1/api.go:1139-1141`、`routers/api/v1/repo/issue.go:968-1007`、`services/issue/issue.go:171-202`
- [x] 差异记录：无（扩展用法与源码一致；此前文档缺该端点的独立小节，本次补上）

### `GET /repos/{owner}/{repo}/issues/{index}/times`

- [x] 查询参数全部可选：`user`、`since`/`before`（RFC 3339，解析失败 422）、`page`/`limit`；`page` 不传时服务端**完全不分页**（返回该 issue 全部记录），`limit` 被 clamp 到 `MaxResponseItems`=50，`limit<=0` 落到默认 30
- [x] 响应：`TrackedTimeList`（`[]*api.TrackedTime`），元素字段 `id`/`created`/`time`/`user_id`/`user_name`/`issue_id`/`issue`；扩展消费 `id`、`time`、`user_name`；服务端另设 `X-Total-Count` 但扩展不使用，靠页长度收敛翻页
- [x] 权限：整组挂 `reqToken()`（未登录 401，GET 也需要 token），外层还有 `AccessTokenScopeCategoryIssue`（GET 只需 read 级别）、`mustEnableIssuesOrPulls`、`mustEnableLocalIssuesIfIsIssue`；timetracker 关闭或 issue 不存在 404；非 site admin 且非 issue 写入者时，传他人 `user` 返回 403，不传 `user` 则被强制为调用者本人
- [x] 源码位置：`routers/api/v1/api.go:1156-1162,1204-1205,1221`、`routers/api/v1/repo/issue_tracked_time.go:24-144`、`models/issues/tracked_time.go:86-153`、`services/convert/issue.go:139-155`、`routers/api/v1/utils/page.go:13-18`
- [x] 差异记录：扩展只传 `page`/`limit=50`、从不传 `user`，因此非 issue 写入者拿到的是「只有自己」的列表，而两个详情视图把该列表求和后当作该 issue 的时间汇总展示（`IssueDetail.vue:970-975`、`PullRequestDetail.vue:1418-1423`）——不报错，但非写入者会看到偏小的「总量」；`limit=50` 恰等于服务端上限，不会因 clamp 漏页

### `POST /repos/{owner}/{repo}/issues/{index}/times`

- [x] body 必填 `time`，语义为**整数秒**（int64，没有 duration 字符串解析）；可选 `created`（RFC 3339，缺省取服务器当前时间）与 `user_name`（仅 repo admin / site admin 生效，其他角色会被静默忽略并记到调用者名下）
- [x] 响应：200 + 单个 `api.TrackedTime`（`convert.ToTrackedTime`），`issue` 已由 `LoadAttributes` 填充；扩展消费 `id`/`created`/`time`/`user_name`
- [x] 权限与校验：`CanUseTimetracker` 不满足 403、timetracker 关闭 400（`{"message":"time tracking disabled"}`）；任何绑定/校验失败统一 422（`routers/api/v1/api.go:463-473`）；`time` 只有 `binding:"Required"`，**无上下限**，负数可被接受并入库
- [x] 源码位置：`routers/api/v1/api.go:1156-1162,463-473`、`routers/api/v1/repo/issue_tracked_time.go:147-228`、`modules/structs/issue_tracked_time.go:10-19`、`models/issues/tracked_time.go:170-213`、`services/context/repo.go:158-166`
- [x] 差异记录：扩展只发 `{ time: <整数秒> }`（`client.ts:1325-1328`；UI 用小时×3600+分钟×60 换算，`seconds <= 0` 时不发请求），与 `AddTimeOption` 一致；但生成的 `IssueAddTime` 错误类型只声明 400/403/404，服务端实际还会返回 **422**（`time` 缺失或为 0），运行时仅表现为通用报错；UI hours 无上限，服务端同样无上限

### `DELETE /repos/{owner}/{repo}/issues/{index}/times/{id}`

- [x] 仅路径参数，无 body、无 query；成功 204（`APIEmpty`），扩展不消费响应体；记录以 `deleted=true` 软删除，所有列表查询固定带 `tracked_time.deleted = false`
- [x] 权限：先 `CanUseTimetracker`（关闭 400、不允许 403），再要求 **site admin 或该条记录 `UserID == ctx.Doer().ID`**，否则 403——repo admin/owner 也不能删他人的计时；`id` 不存在或已删除 404
- [x] 源码位置：`routers/api/v1/api.go:1161`、`routers/api/v1/repo/issue_tracked_time.go:293-374`、`models/issues/tracked_time.go:282-341`、`tests/integration/api_issue_tracked_time_test.go:81-102`
- [x] 差异记录：请求形状一致；服务端 `GetTrackedTimeByID` 只按全局 `id` 查询、**不校验该记录是否属于 URL 中的 issue**（`issue_tracked_time.go:348`），正常路径无影响；扩展 UI 未按 `user_name` 隐藏他人条目的删除按钮（`IssueDetail.vue:1014-1026`、`PullRequestDetail.vue:1462-1474`），点击他人条目必然 403

### `DELETE /repos/{owner}/{repo}/issues/{index}/times`

- [x] 仅路径参数，无 body、无 query；成功 204（`APIEmpty`）
- [x] 语义是「重置调用者本人在该 issue 的所有计时」：`DeleteIssueUserTimes(ctx, issue, ctx.Doer())` 软删除这些记录并追加一条总秒数的 `CommentTypeDeleteTimeManual` 时间线——与 `DELETE .../times/{id}`（删单条、按全局 id、需本人或 site admin）是两个不同操作
- [x] 权限：`CanUseTimetracker`（关闭 400、不允许 403）；调用者在该 issue 没有任何记录时 `removedTime == 0` → 404（与 `{id}` 版 404 的成因不同）
- [x] 源码位置：`routers/api/v1/api.go:1160`、`routers/api/v1/repo/issue_tracked_time.go:231-290`、`models/issues/tracked_time.go:243-320`
- [x] 差异记录：扩展 `resetIssueTime` 在 host/composable 已实现（`client.ts:1330-1332`、`viewProvider.ts:1406-1435`、`useAppState.ts:4024-4027`），但两个详情视图都没有调用它，当前不会被触发；接入 UI 时文案必须是「重置我的计时」，服务端只删调用者本人的记录

### `DELETE /repos/{owner}/{repo}/issues/{index}/stopwatch/delete`

- [x] 仅路径参数，无 body、无 query；成功 204（`APIEmpty`）；副作用是「取消」：删除该 stopwatch 行并追加 `CommentTypeCancelTracking` 时间线，**不产生任何 tracked time**（与 `/stopwatch/stop` 的关键区别）
- [x] 权限与状态机：`prepareIssueStopwatch(ctx, true)` 要求 issue/pull 写权限（403）+ `CanUseTimetracker`（此处关闭也是 403），并要求该用户在该 issue 存在 stopwatch，否则 409
- [x] 源码位置：`routers/api/v1/api.go:1164-1168`、`routers/api/v1/repo/issue_stopwatch.go:114-160,162-188`、`models/issues/stopwatch.go:100-104,243-281`、`tests/integration/api_issue_stopwatch_test.go:64-79`
- [x] 差异记录：请求形状一致；扩展没有 UI 入口（视图只有 start/stop 两个按钮，`IssueDetail.vue:977-992`），且 host 侧确认文案写成 "Delete the tracked time recorded for issue #{0}?"（`viewProvider.ts:1264-1279`），与服务端「取消计时、不记时间」的语义不符，接入 UI 时会误导用户

### `POST /repos/{owner}/{repo}/issues/{index}/stopwatch/start`

- [x] 无 body、无 query；成功返回 **201**（空 body），不是 200/204；扩展把它当 `unknown` 不解析，成功后由 webview 重新拉取 `/user/stopwatches` 与该 issue 的 times
- [x] 权限与唯一性：需 `CanWriteIssuesOrPulls(issue.IsPull)`（403）+ `CanUseTimetracker`（403）；同一用户在同一 issue 已有 stopwatch → 409；stopwatch 表**每用户全局只有一个**——若在其他 issue 有运行中的计时，`CreateIssueStopwatch` 会先 `FinishIssueStopwatch` 结束它（写入一条 tracked time + `CommentTypeStopTracking` 时间线）再开始新的
- [x] 源码位置：`routers/api/v1/api.go:1165`、`routers/api/v1/repo/issue_stopwatch.go:16-62`、`models/issues/stopwatch.go:100-127,154-197,200-240`、`tests/integration/api_issue_stopwatch_test.go:81-96`
- [x] 差异记录：请求完全一致；扩展的 `isStopwatchRunning` 只按当前 owner/repo/issue 匹配（`IssueDetail.vue:86-90`、`PullRequestDetail.vue:112-116`），因此「别的 issue 正在计时」时这里仍显示启动按钮，点击会静默结束另一条并为其记账，UI 无提示——与服务端全局唯一语义的交互差异。附带小瑕疵：三个 stopwatch 命令的 catch 分支把回包 `action` 硬编码为 `'start'`（`viewProvider.ts:1304-1311`），webview 在 error 分支不读它，无可见影响

### `POST /repos/{owner}/{repo}/issues/{index}/stopwatch/stop`

- [x] 无 body、无 query；成功返回 **201**（空 body），不是 204；副作用是结束计时并**新增一条 tracked time**（`Time = now - Stopwatch.CreatedUnix` 秒）+ `CommentTypeStopTracking` 时间线，随后删除 stopwatch 行
- [x] 权限：与 start 相同（写权限 403 + `CanUseTimetracker` 403）；该用户在该 issue 没有运行中的 stopwatch 时 409（重复调用也是 409）
- [x] 源码位置：`routers/api/v1/api.go:1166`、`routers/api/v1/repo/issue_stopwatch.go:65-111`、`models/issues/stopwatch.go:154-197`、`tests/integration/api_issue_stopwatch_test.go:47-62`
- [x] 差异记录：请求形状与状态码一致（扩展不解析返回值）；唯一可用性差异是 409 只以通用 `Conflict: …` 呈现，未区分「没有运行中的计时器」与其他冲突原因

### `GET /repos/{owner}/{repo}/labels`

- [x] 请求：路径 `owner`/`repo` 必填；查询参数 `sort`（`mostissues`/`leastissues`/`reversealphabetically`，省略按 `name` 升序）、`page`、`limit`；扩展传 `page`、`limit: 50`，不传 `sort`
- [x] 响应：`convert.ToLabelList` 产生的 `[]*api.Label`；`color` 去掉 `#`（形如 `00aabb`），扩展消费 `id`/`name`/`color`（渲染时自行补 `#`）；`X-Total-Count` 为仓库标签总数
- [x] 权限与分页：作用域是 **`Issue`**（GET → 需 `read:issue`，不是 `read:repository`）；`limit<=0` 取默认 30，超过 `MaxResponseItems`=50 截断为 50；服务端**仅在 `page > 0` 时才套用分页**
- [x] 源码位置：`routers/api/v1/api.go:1206-1212,1220-1221`、`routers/api/v1/repo/label.go:21-70`、`models/issues/label.go:406-429`、`services/convert/issue.go:209-246`、`modules/structs/issue_label.go:13-24`
- [x] 差异记录：无实质性差异。作用域是 `read:issue`，受限 token 会 403，扩展依赖服务端 body 的 scope 提示 + `client.ts:1915-1921` 的正则来展示原因；扩展的 `_fetchAllPages` 从 `page=1` 开始，始终命中分页分支

### `GET /repos/{owner}/{repo}/milestones`

- [x] 请求：路径 `owner`/`repo` 必填；查询参数 `state`、`name`、`page`、`limit`；扩展显式传 `state: 'open'`、`page`、`limit: 50`
- [x] 响应：`convert.ToAPIMilestone` 产生的 `[]*api.Milestone`（`title` ← 模型 `Name`、`description` ← `Content`、`due_on` ← `Deadline`）；扩展消费 `id`/`title`；`X-Total-Count` 为符合条件总数
- [x] 权限与分页：作用域 **`Issue`**（`read:issue`）；默认 30 / 上限 50；`db.FindAndCount` **仅在 `page >= 1` 时**才套用 `LIMIT/OFFSET`
- [x] 源码位置：`routers/api/v1/api.go:1213-1219,1220-1221`、`routers/api/v1/repo/milestone.go:24-88`、`models/issues/milestone_list.go:28-57`、`models/db/list.go:186-191`、`services/convert/issue.go:249-262`、`modules/structs/issue_milestone.go:11-26`
- [x] 差异记录：swagger 注释写 “Defaults to open”，但实现里 `state` 为空或为 `all` 时**不加 `is_closed` 过滤**，会同时返回 open 与 closed——服务端文档与实际行为不一致；扩展显式传 `state: 'open'`，不依赖该默认值，无风险

### `GET /repos/{owner}/{repo}/assignees`

- [x] 请求：仅路径参数 `owner`、`repo`；**没有任何查询参数**（生成客户端也只传路径），该端点**不分页**，响应即全量列表
- [x] 响应：`[]*api.User`（裸数组、无包装对象、无 `X-Total-Count`）；扩展只消费 `login` 并映射为 `string[]`，`users ?? []` 兜底使空响应不会崩溃
- [x] 返回范围：所有对该仓库具 **write** 权限的用户（含组织 team 授予的写权限，并按 `team_unit` 规则补入 PR 只读成员），另加仓库 owner 本人；`is_active = false` 的用户被排除；结果按用户名排序
- [x] 权限：`reqToken()`（401）+ `reqAnyRepoReader()`（无仓库权限且非站点管理员 403）；外层叠加 `repoAssignment`（404）、`repoAccess()`（404）与 `checkTokenPublicOnly()`，作用域 `Repository`（需 `read:repository`）
- [x] 源码位置：`routers/api/v1/api.go:847,1095-1096`、`routers/api/v1/repo/collaborators.go:351-380`、`models/repo/user_repo.go:66-114`、`services/convert/user.go:30-36`、`routers/api/v1/permissions/req_any_repo_reader.go:10-15`、`routers/api/v1/permissions/repo_access.go:53-56`
- [x] 差异记录：无（未用 `_fetchAllPages` 是正确的，服务端本就不提供分页）

### `POST /repos/{owner}/{repo}/pulls`

- [x] 必填字段：`title`、`head`、`base`
- [x] `head` 支持跨仓库格式（`owner:branch` 或 `owner/repo:branch`）
- [x] `head` 与 `base` 不能相同
- [x] 重复创建同 base/head 的未合并 PR 返回 409
- [x] 源码位置：`routers/api/v1/repo/pull.go:398-585`
- [x] 差异记录：无

### `PATCH /repos/{owner}/{repo}/pulls/{index}`

- [x] 可编辑字段与 Issue 类似，额外支持 `base`（修改目标分支）、`allow_maintainer_edit`
- [x] 修改 `base` 仅在不与已存在 PR 冲突且 PR 未合并时允许
- [x] 已合并 PR 不能修改 state
- [x] 源码位置：`routers/api/v1/repo/pull.go:587-815`
- [x] 差异记录：无

### `POST /repos/{owner}/{repo}/pulls/{index}/merge`

- [x] `Do` 取值：merge / rebase / squash / manually-merged
- [x] 支持 `MergeTitleField`、`MergeMessageField`、`merge_when_checks_succeed`、`force_merge`、`delete_branch_after_merge`（前两个在快照里的 JSON 字段名首字母大写，没有下划线拼法）
- [x] 409 表示无法合并（冲突、WIP、检查未通过等）；405 表示用户无权限或状态不允许
- [x] 源码位置：`routers/api/v1/repo/pull.go:863-1100`
- [x] 差异记录：当前 `mergePullRequest` 仅传 `Do`，未传标题/消息，服务端会自动生成默认消息，符合源码

### `GET /repos/{owner}/{repo}/branch_protections/{name}`

- [x] 返回字段包括 `required_approvals`、`enable_status_check`、`status_check_contexts`、`apply_to_admins`
- [x] 无保护规则时返回 404
- [x] 字段 `apply_to_admins` 在 API 中为 `boolean`，模型中对应 `bp.ApplyToAdmins`
- [x] 源码位置：`routers/api/v1/repo/branch.go:469-510`；`services/convert/convert.go:135-188`
- [x] 差异记录：无

### `GET /repos/{owner}/{repo}/commits/{ref}/status`

- [x] 返回 `CombinedStatus`，`state` 取值：pending / success / error / failure / warning / skipped（`CommitStatusState` 的说明里含 `skipped`，`packages/forgejo-api/spec/swagger.v1.json:24313-24314`；webview 已按 `checksState.skipped` 渲染）
- [x] `statuses` 包含 `id`、`context`、`description`、`status`、`target_url`、`created_at`、`updated_at`
- [x] 源码位置：`routers/api/v1/repo/status.go`（`GetCombinedStatusByRef`）
- [x] 差异记录：无

---

## 仓库浏览与文件

### `GET /repos/{owner}/{repo}`

- [x] 返回 `api.Repository`，包含 `empty`、`permissions`、`default_branch`、`html_url`、`clone_url`、`owner` 等
- [x] `permissions` 字段由 `convert.ToRepo` 根据当前用户权限构造，始终存在
- [x] 源码位置：`routers/api/v1/repo/repo.go:566-595`；`services/convert/repo.go`
- [x] 差异记录：无

### `GET /repos/{owner}/{repo}/contents/{filepath}`

- [x] `filepath` 为空时等价于根目录内容列表
- [x] `ref` 支持 branch / tag / commit sha；为空时使用默认分支
- [x] 文件不存在返回 404；空仓库返回 404
- [x] 文件返回 `ContentResponse`（包含 base64 content），目录返回 `ContentsListResponse`（数组）
- [x] 源码位置：`routers/api/v1/repo/file.go:958-1012`
- [x] 差异记录：当前 `getRepoContents` 对空 path 调用 `repoGetContentsList`，非空 path 调用 `repoGetContents`，与源码一致

### `GET /repos/{owner}/{repo}/contents`

- [x] 与 `GET /contents/{filepath}` 在 `filepath` 为空时行为完全一致（handler 直接调用 `GetContents`）
- [x] 源码位置：`routers/api/v1/repo/file.go:1014-1045`
- [x] 差异记录：无

### `GET /repos/{owner}/{repo}/git/trees/{sha}`

- [x] 参数：`recursive`（boolean）、`page`、`per_page`
- [x] `truncated=true` 表示还有未返回的项
- [x] `tree` 项 `type` 取值：blob / tree / commit（submodule）
- [x] 源码位置：`routers/api/v1/repo/tree.go:14-70`
- [x] 差异记录：无

### `GET /repos/{owner}/{repo}/commits`

- [x] 参数：`sha`（默认默认分支）、`path`、`not`、`limit`、`page`、`stat`/`verification`/`files`（默认 true）
- [x] `path` 非空时返回该路径的历史提交
- [x] `files` 为 true 时返回 `CommitAffectedFiles`，`status` 取值为 `added`/`removed`/`modified`（`services/convert/git_commit.go:197-205`）
- [x] `limit` 超过 `setting.Git.CommitsRangeSize` 会被截断
- [x] 源码位置：`routers/api/v1/repo/commits.go:94-377`
- [x] 差异记录：无

### `GET /repos/{owner}/{repo}/branches`

- [x] 返回 `api.Branch` 数组，包含 `name`、`commit`、`protected`、`required_approvals` 等
- [x] 支持 `page`/`limit` 分页，limit 默认 50
- [x] 源码位置：`routers/api/v1/repo/branch.go`（ListBranches）
- [x] 差异记录：无

### `POST /repos/{owner}/{repo}/branches`

- [x] 请求体：`branch_name`、`old_branch_name` 或 `old_ref_name`
- [x] 默认从默认分支创建；分支已存在返回 409
- [x] 源码位置：`routers/api/v1/repo/branch.go:174-260`
- [x] 差异记录：无

### `DELETE /repos/{owner}/{repo}/branches/{branch}`

- [x] 不能删除默认分支，不能删除受保护分支，mirror 仓库不能删除
- [x] 需要写入权限
- [x] 源码位置：`routers/api/v1/repo/branch.go:91-172`
- [x] 差异记录：无

### `GET /repos/{owner}/{repo}/tags`

- [x] 返回 `api.Tag` 数组，包含 `name`、`message`、`commit`、下载链接
- [x] 支持 `page`/`limit`，默认 limit 50
- [x] 源码位置：`routers/api/v1/repo/tag.go:25-78`
- [x] 差异记录：无

### `POST /repos/{owner}/{repo}/tags`

- [x] 请求体：`tag_name`（必填）、`target`（默认默认分支）、`message`
- [x] 会创建 git tag；如 tag 已存在返回 409
- [x] 与 release 的关系：创建 tag 不会自动创建 release
- [x] 源码位置：`routers/api/v1/repo/tag.go:181-258`
- [x] 差异记录：无

### `DELETE /repos/{owner}/{repo}/tags/{tag}`

- [x] 仅可删除未关联 release 的 tag（`IsTag=true`）
- [x] 关联 release 的 tag 返回 409
- [x] 受保护 tag 返回 422
- [x] 源码位置：`routers/api/v1/repo/tag.go:260-323`
- [x] 差异记录：无

---

## 通知与搜索

### `GET /notifications`

- [x] 参数：`status-types`（multi，默认 unread & pinned）、`subject-type`（multi：issue/pull/repository）、`since`/`before`、`page`/`limit`
- [x] 响应 `NotificationThread` 数组，包含 `subject`（含类型和 URL）、`repository`、`unread`、`updated_at`、`pinned`
- [x] `status-types` 取值：unread / read / pinned
- [x] 源码位置：`routers/api/v1/notify/user.go:17-91`
- [x] 扩展侧用法：`NotificationPoller._fetchUnreadSet`（`packages/forgejo-toolkit/src/notifications/notificationPoller.ts`）在服务端报告总数（`X-Total-Count`）时按 `before` 游标翻页——首屏之后每页以「已持有行中最旧的 `updated_at`」作为 `before`，页大小 `POLL_PAGE_LIMIT = 50`，最多 `ceil(total / 50)` 页并受共享列表上限约束；`ForgejoClient.getNotifications`（`packages/forgejo-toolkit/src/api/client.ts`）为此暴露 `before` 参数，webview 的「加载更多」用同一游标。这是扩展侧的取数方式，不构成与服务端实现的差异
- [x] 差异记录：无

### `PUT /notifications`

- [x] 参数：`all`（boolean）、`status-types`（multi，默认 unread）、`to-status`（默认 read）、`last_read_at`
- [x] 仅标记 `updated_at <= last_read_at` 的通知
- [x] 响应 205 返回被修改的线程数组
- [x] 源码位置：`routers/api/v1/notify/user.go:93-175`
- [x] 差异记录：源码路由组是 `m.Combo("").Get(notify.ListNotifications).Put(notify.ReadNotifications)`（`routers/api/v1/api.go:582-584`），即 `PUT /notifications`，不存在 `PATCH /notifications`；当前 `markAllNotificationsRead` 经生成的 `notifyReadList` 发 `PUT /notifications`，传 `all: true, to-status: read`，与源码一致

### `PATCH /notifications/threads/{id}`

- [x] 参数：`to-status`（默认 read），支持 unread / read / pinned
- [x] 仅允许本人或管理员操作
- [x] 响应 205 返回更新后的线程
- [x] 源码位置：`routers/api/v1/notify/threads.go:53-103`
- [x] 差异记录：无

### `GET /repos/search`

- [x] 参数：`q`、`limit`、`page`、`uid`、`topic`、`includeDesc`、`sort`、`order` 等
- [x] 响应结构：`{ ok: true, data: Repository[] }`；总条数不在 JSON 体内，由 `X-Total-Count` 响应头返回（`routers/api/v1/repo/repo.go:248-253`）
- [x] 源码位置：`routers/api/v1/repo/repo.go:44-260`
- [x] 差异记录：当前 `searchRepositories` 取 `result.data`，与源码一致

### `GET /repos/issues/search`

- [x] 路径：实际是 `/repos/issues/search`，不是 `/issues/search`
- [x] 参数：`q`、`state`、`type`、`limit`、`page`、`labels`、`milestones`、`assigned`、`created` 等
- [x] 与 `issueSearchIssues` 是同一端点；`type=issues`/`pulls` 过滤 is_pull
- [x] `limit` 默认 `setting.UI.IssuePagingNum`，最大 `setting.API.MaxResponseItems`
- [x] 响应结构：**直接返回 `Issue[]` 数组**，总条数通过响应头 `X-Total-Count` 返回，不是 `{ ok, data, total_count }`
- [x] 源码位置：`routers/api/v1/repo/issue.go:35-339`
- [x] 差异记录：当前 `getUserIssues` / `getUserPullRequests` / `searchIssues` / `searchPullRequests` 直接返回数组，与源码一致

### `GET /users/search`

- [x] 参数：`q`、`uid`、`sort`、`page`、`limit`
- [x] 响应结构：`{ ok: true, data: User[] }`
- [x] 支持按 email 搜索
- [x] 源码位置：`routers/api/v1/user/user.go:21-108`
- [x] 差异记录：当前 `userSearch` 取 `result.data`，与源码一致

---

## Actions / CI

> 版本提示：本节中的 `/actions/runs/{run_id}/jobs`、`/actions/runs/{run_id}/artifacts`、`/actions/jobs/{job_id}/logs`、`/actions/runs/{run_id}/cancel`、`DELETE /actions/runs/{run_id}` 与 `/actions/artifacts/{artifact_id}/zip` 六个端点均随 **Forgejo v16.0.0** 引入，可由发布说明坐实：`/actions/runs/{run_id}/jobs`（`release-notes-published/16.0.0.md:57`，PR 11915）、Actions artifacts REST 端点（同文件 `:61`，PR 12140）、`jobs/{job_id}/logs` 与 `runs/{run_id}/logs`（同文件 `:62`，PR 12666）、`runs/{run_id}/cancel`（同文件 `:72`，PR 12957）、`DELETE runs/{run_id}`（同文件 `:87`，PR 12478）。因此这六个端点要求 Forgejo v16+，对 v15 实例调用会返回 404；路由与中间件见 `routers/api/v1/api.go:893-920`。

### `GET /repos/{owner}/{repo}/actions/runs`

- [x] 返回 `{ total_count, workflow_runs: ActionRun[] }`（`ListActionRunResponse`，`modules/structs/action.go:116-119`）
- [x] 支持 `page`/`limit`；默认页大小 30（`modules/setting/api.go:25` 的 `DefaultPagingNum`），上限 50（同文件 `:24` 的 `MaxResponseItems`），由 `services/convert/utils.go:15-22` 的 `ToCorrectPageSize` 夹取（`routers/api/v1/utils/page.go:13-18`）；扩展默认传 `limit=30`（`client.ts:432`）
- [x] 支持 `status`、`event`、`run_number`、`head_sha`、`ref`、`workflow_id` 过滤
- [x] 源码位置：`routers/api/v1/repo/action.go:869-976`、`routers/api/v1/utils/page.go:13-18`、`modules/structs/action.go:115-119`
- [x] 差异记录：源码返回 `{ total_count, workflow_runs }`；扩展直接返回原始响应体（`packages/forgejo-toolkit/src/api/client.ts:432-435`），消费方读 `result.workflow_runs`（`packages/forgejo-toolkit/src/webview/viewProvider.ts:2731`），与源码一致

### `GET /repos/{owner}/{repo}/actions/runs/{runId}`

- [x] 返回单个 `ActionRun`（`modules/structs/action.go:66-113`）：`id`、`title`、`repository`、`workflow_id`、`index_in_repo`、`trigger_user`、`ScheduleID`（无 json tag）、`prettyref`、`is_ref_deleted`、`commit_sha`、`is_fork_pull_request`、`need_approval`、`approved_by`、`event`、`event_payload`、`trigger_event`、`status`、`started`、`stopped`、`created`、`updated`、`duration`、`html_url`。**不存在** `name`/`head_branch`/`head_sha`/`conclusion`/`run_number`/`jobs`/`created_at`/`updated_at`；run 号字段是 `index_in_repo`，提交字段是 `commit_sha`，分支字段是 `prettyref`。转换见 `services/convert/action.go:17-49`
- [x] `run_id` 不属于该仓库时返回 404（action run 是独立表，需显式校验 `RepoID`）
- [x] 读取权限仅由 actions 路由组的 `reqRepoReader(unit.TypeActions)` 把守，公开仓库可匿名读；Actions 单元未启用时 404
- [x] 源码位置：`routers/api/v1/repo/action.go:1012-1035`、`routers/api/v1/api.go:920`、`routers/api/v1/permissions/req_repo_reader.go:12-21`、`services/convert/action.go:17-49`
- [x] 差异记录：扩展消费 `title`/`workflow_id`/`index_in_repo`/`prettyref`/`event`/`status`/`duration`/`created`/`html_url`（`packages/forgejo-toolkit/webview/src/views/ActionRunDetail.vue:443,467-488`），全部存在

### `GET /repos/{owner}/{repo}/actions/runs/{runId}/jobs`

- [x] 返回 `ActionRunJob[]` 直接数组，不分页、无 `page`/`limit` 参数，一次返回该 run 的全部 job
- [x] 每个 job 为 `ActionRunJob`（`modules/structs/action.go:12-39`）：`id`、`run_id`、`attempt`、`handle`、`repo_id`、`owner_id`、`name`、`needs`、`runs_on`、`task_id`、`status`。**不存在** `conclusion`/`started_at`/`completed_at`；时间信息只能从单 job 端点的 `steps[].started/stopped` 取
- [x] `steps` 字段在列表端点恒不返回：handler 以 `nil` 调用 `convert.ToActionRunJob`，`Steps` 因 `omitempty` 被省略；只有 `GET /actions/jobs/{job_id}` 才填充
- [x] 源码位置：`routers/api/v1/repo/action.go:1211-1222`、`services/convert/action.go:72-104`、`modules/structs/action.go:12-39`
- [x] 差异记录：扩展消费 `id`/`name`/`status`（`ActionRunDetail.vue:95,508,517`）以及 `attempt`/`handle`/`needs`/`runs_on`/`task_id`/`repo_id`/`owner_id`/`run_id`（`packages/forgejo-toolkit/src/api/types.ts:247-259`），均存在；旧版「以 `.jobs` 降级」的写法已不成立（源码直接返回数组）

### `GET /repos/{owner}/{repo}/actions/runs/{runId}/artifacts`

- [x] 返回的是「聚合 artifact」：按 `(run_id, artifact_name)` 分组，`id` = `MIN(id)`、`size_in_bytes` = `SUM(file_size)`，时间为 min/max 聚合，按 id 倒序
- [x] 只暴露 `UploadConfirmed` 与 `Expired` 两种状态
- [x] 支持 `name` 过滤和 `page`/`limit` 分页；响应带 `X-Total-Count` 与 `Link` 头，但扩展按条数判断翻页（`client.ts:324-349`），未使用这两个头
- [x] 源码位置：`routers/api/v1/repo/action.go:1287-1370`、`models/actions/artifact.go:237-278`、`services/convert/action.go:53-65`、`modules/structs/action.go:123-142`
- [x] 差异记录：源码直接返回数组，扩展曾以 `.artifacts` 降级、现已按数组处理，与源码一致

### `GET /repos/{owner}/{repo}/actions/jobs/{jobId}/logs`

- [x] 响应头固定 `Content-Type: text/plain; charset=utf-8`（显式 pin，避免 `.log` 被嗅探成 `text/x-log`）与 `Accept-Ranges: bytes`，正文由 `http.ServeContent` 输出，支持 Range/206
- [x] 支持 `?attempt=N`（1-based，省略即最新 attempt）与 `?step=N`（`routers/api/v1/repo/action.go:1651-1666`、`services/actions/job_logs.go:43-119`）；`?step=` 的 N 取自 `GET /actions/jobs/{job_id}` 的 `steps[].number`（0 是 "Set up job"，末位是 "Complete job"），返回该 step 的字节切片，切片内仍支持 Range
- [x] 404 的三种业务原因：job 尚未被 runner 领取（`ErrJobNotExecuted`）、日志已过期（`ErrLogsExpired`）、step 越界（`ErrStepOutOfRange`）；其余错误 500。`?attempt=` 指向不存在的 attempt 也走 404
- [x] 生成的 client 无法表达 `step`：`RepoGetActionJobLogsQueryParams` 只声明 `attempt`（`packages/forgejo-api/src/generated/types/RepoGetActionJobLogs.ts:28-34`），传 `{ step }` 会触发 TS 类型错误
- [x] 源码位置：`routers/api/v1/repo/action.go:1620-1720`、`services/actions/job_logs.go:22-119`、`models/actions/task.go:195-205`
- [x] 差异记录：当前使用 `responseType: 'text'`（`client.ts:467-471`）与源码一致；但调用时 `params` 传 `undefined`（`client.ts:467`），既不传 `attempt` 也不传 `step`，恒取最新 attempt 的完整日志——服务端的 step/attempt 能力未被使用（有意为之，非缺陷）

### `POST /repos/{owner}/{repo}/actions/workflows/{workflowfilename}/dispatches`

- [x] 请求体：`ref`（必填）、`inputs`（map）、`return_run_info`（boolean）
- [x] `return_run_info` 是 Forgejo 特有扩展；为 true 时返回 201 和 `{ id, run_number, jobs }`
- [x] 为 false 时返回 204
- [x] 源码位置：`routers/api/v1/repo/action.go:786-867`
- [x] 差异记录：当前 `dispatchWorkflow` 传 `return_run_info: true` 并解析返回，与源码一致

### `POST /repos/{owner}/{repo}/actions/runs/{runId}/cancel`

- [x] 已完成的 run 不做任何改动且仍返回 204（handler 不校验 run 状态，`routers/api/v1/repo/action.go:1104-1107,1151-1157`；已完成的 job 由 `cancelSingleJob` 提前 return，`services/actions/rerun.go:251-253`）；run 不属于该仓库时 404（`action.go:1146-1149`）
- [x] 权限：需要 token 且需对该仓库的 Actions 单元有写权限（`reqToken()` + `reqRepoWriter(unit.TypeActions)`，`routers/api/v1/api.go:909`）；非 writer 403，Actions 单元禁用 404（`routers/api/v1/permissions/req_repo_writer.go:13-23`）
- [x] 取消只作用于未完成的 job：已完成的 job 原样跳过，`NeedApproval` 的 run 会被清掉待批准标记，随后重算 commit status
- [x] 源码位置：`routers/api/v1/api.go:909`、`routers/api/v1/permissions/req_repo_writer.go:13-23`、`routers/api/v1/repo/action.go:1099-1158`、`services/actions/run.go:17-43`、`services/actions/rerun.go:244-273`、`models/actions/status.go:28-37`
- [x] 差异记录：`canCancelRun` 的状态白名单为 `['running','waiting','pending','requested']`（`packages/forgejo-toolkit/webview/src/views/ActionRunDetail.vue:354-356`），漏掉了服务端真实状态 `blocked`，「等待批准 / 被阻塞」的 run 在 UI 上看不到取消按钮，而 API 实际可以取消；`pending`/`requested` 并非 Forgejo 状态
- [x] MCP 写工具 `cancel_action_run`（`mcp/tools.ts`）是这条端点的**写侧**调用点，经 `ForgejoClient.cancelActionRun`（`src/api/client.ts`）发起，对应 `forgejoToolkit.mcpWriteTools.cancelActionRun` 开关（默认关闭，且与其他写开关彼此独立）；该端点是**无请求体的 POST、成功返回 204 无响应体**，因此该工具的审计行不带 `bytes`/`sha256`（按既有规则是「缺失」而非 0）；因为已知「已完成的 run 也返回 204 且不改动」，工具结果只能说明「服务端接受了取消请求」，run 的真实状态以 `list_action_runs` 或网页界面为准；重复取消在 10 分钟幂等窗口内直接回放（同一次逻辑操作），未复用 key 的重试也不会重复取消（端点对已完成 run 是 no-op）。客户端侧的动作版本闸门同样适用：v15 实例上该端点不存在（404）

### rerun（重新运行 workflow run）—— REST API 不存在（负向核对）

- [x] `routers/api/v1/api.go` 的 actions 路由组中未注册任何 rerun 路由；仅有 cancel（`api.go:909`）与 dispatch（`api.go:917`）
- [x] rerun 仅以 web 路由存在：`POST /{owner}/{repo}/actions/runs/{run}/rerun`（`routers/web/web.go:1636`、`1649`，handler `routers/web/repo/actions/view.go:502`），属 session 认证组，不接受 API token
- [x] 差异记录：扩展不提供「重新运行」按钮，已作为平台限制记录在 `KNOWN_ISSUES.md` / `KNOWN_ISSUES.zh.md`；不建议模拟 web 表单请求

### `GET /repos/{owner}/{repo}/actions/artifacts/{artifactId}/zip`

- [x] 只保证「返回 ZIP 二进制」：Content-Type 不是固定值——v4 单文件走 `httplib.ServeContentByReadSeeker`（`services/actions/download.go:35-55`），默认 `MimeTypeMap.Enabled=false`（`modules/setting/mime_type_map.go:13`）下 zip 不属于 browsable binary（`modules/typesniffer/typesniffer.go:117-118`），最终写成 `application/octet-stream`（`modules/httplib/serve.go:95-119,52-60`）；v1–v3 聚合路径不显式设置 Content-Type（`services/actions/download.go:57-70`），由 net/http 嗅探为 `application/zip`。不要按 `application/zip` 做强断言
- [x] 只有 path 参数，无 query 参数（无 `attempt`/`step`/`name`）；`artifact_id` 是实例内唯一的聚合 artifact ID（`MIN(id)`）
- [x] 当 artifact 走 v4 后端且 `[storage.actions_artifacts] SERVE_DIRECT = true`（minio）时，响应是 303 See Other 跳转到预签名直链，而不是直接回二进制
- [x] 浏览器下载可在 URL 上带 `?token=` 或 `?access_token=` 完成认证（`services/auth/method/util.go:17-32`、`services/auth/method/access_token.go:60-68`），但该方式已弃用并会返回 `Warning` 响应头（`routers/api/shared/middleware.go:190-194`），且 `DISABLE_QUERY_AUTH_TOKEN=true`（默认 false，`modules/setting/security.go:487-495`）时会被忽略导致 401/403
- [x] artifact 未确认上传完成时返回 404；服务端返回的 `archive_download_url` 形如 `{repoAPIURL}/actions/artifacts/{id}/zip`（指向 `/api/v1/repos/...`，需带认证）
- [x] 源码位置：`routers/api/v1/repo/action.go:1419-1484`、`services/actions/download.go:30-95`、`models/actions/artifact.go:176-180,280-290`、`services/context/base.go:260-265`
- [x] 差异记录：当前使用 `responseType: 'stream'` 流式写盘（带 2GB 防御上限与 30s 空闲 watchdog），与源码一致；`ActionRunDetail.vue:350-352` 的 `artifactDownloadUrl` 无任何调用方（实际下载走 `downloadActionArtifactToFile`），属冗余

### `DELETE /repos/{owner}/{repo}/actions/runs/{runId}`

- [x] 仅 `success`/`failure`/`cancelled`/`skipped`（`IsDone`）可删；`unknown`/`waiting`/`running`/`blocked` 一律失败，且 handler 返回 **500** 而非 swagger 声明的 400（`services/actions/run.go:195-206`、`routers/api/v1/repo/action.go:1090-1094`、`models/actions/status.go:49-51`）
- [x] 权限：需要 token 且需仓库 admin 或站点管理员（`reqToken()` + `reqAdmin(unit.TypeActions)`，`routers/api/v1/api.go:908`）；普通 writer 403，Actions 单元禁用 404（`routers/api/v1/permissions/req_admin.go:13-23`）
- [x] 删除会同时把该 run 的 artifacts 置为待删除、删除 jobs/tasks/logs
- [x] 源码位置：`routers/api/v1/api.go:908`、`routers/api/v1/permissions/req_admin.go:13-23`、`routers/api/v1/repo/action.go:1037-1097`、`services/actions/run.go:195-220`、`models/actions/status.go:49-51`
- [x] 差异记录：无

---

## 用户与实例

### `GET /user`

- [x] 返回当前认证用户 `api.User`，包含 `id`、`login`、`full_name`、`email`、`avatar_url`、`is_admin` 等
- [x] Token 无效时返回 401
- [x] 源码位置：`routers/api/v1/user/user.go:137-153`
- [x] 差异记录：无

### `GET /users/{username}`

- [x] 返回指定用户信息，字段与 `/user` 一致
- [x] 不可见用户返回 404（不泄露存在性）
- [x] 源码位置：`routers/api/v1/user/user.go:110-135`
- [x] 差异记录：无

### `GET /user/repos`

- [x] 返回当前用户拥有的仓库数组 `Repository[]`
- [x] 不包含 collaborator 仓库（仅 `OwnerID=currentUser`）
- [x] 支持 `page`/`limit`/`order_by` 分页排序
- [x] 源码位置：`routers/api/v1/user/repo.go:88-170`
- [x] 差异记录：当前 `getUserRepositories` 经 `_fetchAllPages` 以 `limit: 50` 分页拉取，未指定 `order_by`，与源码默认行为一致

### `GET /user/stopwatches`

- [x] 返回当前用户所有进行中的 stopwatch 列表
- [x] 字段：`issue`、`issue_index`、`issue_title`、`repo_name`、`repo_owner_name`、`duration`（秒）
- [x] 支持 `page`/`limit`
- [x] 源码位置：`routers/api/v1/repo/issue_stopwatch.go:192-235`
- [x] 差异记录：无

---

### `GET /version`

- [x] 请求：无路径参数、无查询参数、无 body；注册在无中间件的 "Misc (public accessible)" 分组内，**不需要 token**，匿名可调用；不参与任何鉴权中间件链
- [x] 响应：`structs.ServerVersion`，唯一字段 `version`（无 `omitempty`，任何成功响应都带该字段）；扩展消费并缓存原始版本串
- [x] 版本串来源：`setting.AppVer` ← `main.Version` ← 链接期注入的 `FORGEJO_VERSION`；兼容标记 `GITEA_COMPATIBILITY = gitea-1.22.0` 会在缺失时追加，故发行版形如 `16.0.0+gitea-1.22.0`；`AppVer` 为空时回退 `dev`。另有 `/api/forgejo/v1/version` 返回 `setting.ForgejoVersion`（取值来源不同），扩展未使用
- [x] 源码位置：`routers/api/v1/api.go:555-578`、`routers/api/v1/misc/version.go:15-25`、`modules/structs/miscellaneous.go:74-77`、`main.go:29,39`、`modules/setting/setting.go:42-45`、`Makefile:87,98-105,119`
- [x] 差异记录：`parseServerVersion`（`^v?(\d+)\.(\d+)(?:\.(\d+))?`）能容忍 `1.21.5`、`v1.19.2`、`16.0.0+gitea-1.22.0`，`+gitea-…` 后缀被整体忽略，比较的是 Forgejo 自身版本号；`serverVersion.ts:11` 的注释把示例写成 `7.0.1+gitea-1.22`（实际标记是 `gitea-1.22.0`），仅注释不精确。无 tag 的源码检出让 `/version` 返回 `62c6d1c+gitea-1.22.0`，正则返回 undefined → 两个闸门都放行（fail-open，符合约定）。**唯一隐患**：显式以 `GITEA_VERSION` 构建时该端点返回纯 `X.Y.Z`，扩展会把它与 `MIN_SUPPORTED_VERSION = {16,0,0}` 比较，可能误报「实例版本过低」——该分支未通过实际构建确认

### `POST /user/repos`

- [x] 请求体为 `api.CreateRepoOption`：`name` 必填且受 `Required;AlphaDashDot;MaxSize(100)` 约束、`description` 上限 2048，其余可用字段 `private`、`issue_labels`、`auto_init`、`template`、`gitignores`、`license`、`readme`、`default_branch`、`trust_model`、`object_format_name`
- [x] 扩展只发 `{ name, private, auto_init: false }`，**从不发送 `description`**（`packages/forgejo-toolkit/src/commands/publish.ts:213`）；`auto_init=false` 时不会自动补 README，创建的是空仓库，需扩展推送首个提交（与 `publish.ts` 后续流程一致）
- [x] 响应：201 + `convert.ToRepo(…)`（`api.Repository`），扩展消费 `clone_url` 与 `full_name`；重名 **409** + `The repository with the same name already exists.`，扩展的 `isNameConflictError` 同时匹配 409 与「422 + already exists」（422 对应保留名/命名规则不符）；组织账号调用 422，配额超限 413
- [x] 权限：`/user` 分组要求 `tokenRequiresScopes(User)` + `reqToken()`（无 token 401），路由再叠加 `tokenRequiresScopes(Repository)`
- [x] 源码位置：`routers/api/v1/api.go:727-728,634,765`、`routers/api/v1/repo/repo.go:257-341`、`modules/structs/repo.go:136-168`、`packages/forgejo-api/src/generated/client/createCurrentUserRepo.ts:19-56`
- [x] 差异记录：无字段错误；仅记录扩展不发 `description`（服务端可选，不影响），以及重名只会得到 409 而 422 分支实际对应命名规则校验失败，代码注释可更精确

### Issue / PR / Comment 附件

- [x] 上传使用 `multipart/form-data`，文件字段名 `attachment`
- [x] 查询参数 `name` 可覆盖原始文件名
- [x] 返回 `api.Attachment`，字段：`id`、`name`、`size`、`download_count`、`created_at`、`uuid`、`browser_download_url`、`type`（`modules/structs/attachment.go:12-23`；下载地址的 JSON 字段名是 `browser_download_url`，不是 `download_url`；时间字段是 `created_at`，不是 `created`）
- [x] `browser_download_url` 实际为 `{appURL}/attachments/{uuid}`（由模型 `DownloadURL()` 生成，经 `APIAssetDownloadURL` 写入；`services/convert/attachment.go:36-57`）
- [x] 创建 issue/comment 附件后，服务端会同步更新 issue/content 的更新时间
- [x] 删除附件需要是附件所属 issue/comment 的作者或具有写入权限
- [x] 源码位置：`routers/api/v1/repo/issue_attachment.go`、`issue_comment_attachment.go`；`models/repo/attachment.go:78-88`；`services/convert/attachment.go:36-58`
- [x] 差异记录：当前附件 URL fallback 为 `{instanceUrl}/attachments/{uuid}`，与源码一致；图片显示需转换为 base64 的问题与 API 行为无关，是 webview 缺少 cookie 导致，已记录

### `GET /repos/{owner}/{repo}/releases`

- [x] 返回 `Release` 数组，包含 `id`、`tag_name`、`name`、`body`、`draft`、`prerelease`、`author`、`assets`
- [x] 默认不包含 draft（除非有写入权限）；支持 `draft`/`pre-release`/`q` 过滤
- [x] 源码位置：`routers/api/v1/repo/release.go:116-194`
- [x] 差异记录：无

### `POST /repos/{owner}/{repo}/releases`

- [x] 请求体：`tag_name`（必填）、`target`（默认默认分支）、`title`（默认 tag_name）、`note`、`draft`、`prerelease`
- [x] 如果 tag 已存在但只是 tag（`IsTag=true`），则将其转换为 release；如果 release 已存在则 409
- [x] 附件不能随创建一起上传，需先创建 release 再调用附件接口
- [x] 源码位置：`routers/api/v1/repo/release.go:196-298`
- [x] 差异记录：当前 pending 附件机制与源码一致

### `PATCH /repos/{owner}/{repo}/releases/{id}`

- [x] 可编辑字段：`tag_name`、`target`、`title`、`note`、`draft`、`prerelease`、`hide_archive_links`
- [x] 空字符串字段不会被更新（除了显式传的会覆盖）
- [x] 源码位置：`routers/api/v1/repo/release.go:300-385`
- [x] 差异记录：无

### `POST /repos/{owner}/{repo}/releases/{id}/assets`

- [x] 支持 `multipart/form-data` 和 `application/octet-stream`
- [x] 文件字段名 `attachment`，或表单字段 `external_url`（二选一）
- [x] `name` 查询参数指定文件名
- [x] 返回 `api.Attachment`
- [x] 源码位置：`routers/api/v1/repo/release_attachment.go:158-315`
- [x] 差异记录：当前 `createReleaseAttachment` 使用 multipart + `attachment` 字段 + `name` 参数，与源码一致

### `DELETE /repos/{owner}/{repo}/releases/{id}`

- [x] 删除 release 会级联删除其附件（`DeleteReleaseByID` 内部逻辑）
- [x] 受保护 tag 会阻止删除
- [x] 源码位置：`routers/api/v1/repo/release.go:387-436`
- [x] 差异记录：无

---

### `DELETE /repos/{owner}/{repo}/releases/{id}/assets/{attachment_id}`

- [x] 请求：路径参数 `owner`、`repo`、`id`（release id）、`attachment_id`，无 body、无查询参数；生成客户端签名与服务器路由逐段一致
- [x] 响应：**204 无响应体**；扩展不读取返回值（`Promise<void>`）
- [x] 权限：`reqRepoWriter(unit.TypeReleases)`——Releases 单元被禁用 404；非 writer / 非仓库 admin / 非站点管理员 403；分组还叠加 `reqRepoReader(unit.TypeReleases)` 与 `repoAssignment`/`repoAccess()`；作用域 `Repository`（DELETE → 需 `write:repository`）
- [x] 另外两个 404 来源：release 不存在或不属于路径仓库；附件不存在，或附件存在但其 `ReleaseID != {id}`
- [x] 附件列表影响：删除同时移除数据库行与磁盘文件（`DeleteAttachment(ctx, attach, true)`）；release 的 `assets` 不是快照字段，而是每次按 `release_id` 重新查询 `attachment` 表，因此删除后同一 release 的附件列表不再包含该附件
- [x] 源码位置：`routers/api/v1/api.go:960-966,973,1095-1096`、`routers/api/v1/repo/release_attachment.go:26-41,409-472`、`models/repo/attachment.go:134-142,234-263`、`models/repo/release.go:99-122,414-450`、`routers/api/v1/permissions/req_repo_writer.go:13-24`、`routers/api/v1/permissions/req_repo_reader.go:12-21`
- [x] 差异记录：无。扩展删除后按流程重新拉取 release，与服务端「附件按 `release_id` 实时查询」的行为一致；错误路径把 `error` 回传 webview 而不是静默成功，符合 403/404 都可能出现的情况

## Markdown 渲染

### `POST /markdown`

- [x] 请求体字段：`Text`、`Mode`、`Context`、`Wiki`
- [x] `Mode` 取值：`markdown`、`gfm`、`comment`；默认 `markdown`
- [x] `Context` 影响相对链接和 mention 解析的前缀
- [x] 响应为 HTML，Content-Type `text/html`
- [x] 源码位置：`routers/api/v1/misc/markup.go:56-96`；`modules/structs/miscellaneous.go:51-67`
- [x] 差异记录：当前 `renderMarkdown` 使用大写 `Text`/`Mode`/`Context`，与 Forgejo 结构体字段名一致，符合源码

---

## 全局发现

- [x] 所有 `limit` 参数的最大值（Forgejo 是否有硬限制）
  - Issue/PR 搜索：`limit` 默认 `setting.UI.IssuePagingNum`，最大被 `setting.API.MaxResponseItems` 截断
  - Commit 列表：`limit` 超过 `setting.Git.CommitsRangeSize` 会被截断
  - 其余列表默认多为 30/50，同样受 `setting.API.MaxResponseItems` 限制
- [x] 所有列表接口的响应类型（直接数组 vs `{ ok: true, data: [] }` vs `{ xxx: [] }`）
  - 直接数组：`/notifications`、`/repos/{owner}/{repo}/actions/runs/{runId}/jobs`、分支/tag、评论等
  - 直接返回数组 + `X-Total-Count` 响应头：`/repos/issues/search`（`routers/api/v1/repo/issue.go:337-338`）
  - `{ ok: true, data: [] }` + `X-Total-Count` 响应头：`/repos/search`、`/users/search`（`routers/api/v1/repo/repo.go:248-253`、`routers/api/v1/user/user.go:101-107`）
  - `{ total_count, workflow_runs: [...] }`：`/repos/{owner}/{repo}/actions/runs`
- [x] 所有 `status` / `state` 枚举值的一致性
  - PR 文件接口：`added`/`deleted`/`changed`/`renamed`/`copied`
  - Compare diff：`added`/`removed`/`modified`（`CommitAffectedFiles` 不携带重命名/复制信息）
  - Commit affected files：`added`/`removed`/`modified`（`services/convert/git_commit.go:197-205`）
  - Combined status：`pending`/`success`/`error`/`failure`/`warning`/`skipped`
  - Issue/PR state：`open`/`closed`
- [x] 附件 URL 是否需要 token 鉴权（Cookie vs Header）
  - `/attachments/{uuid}` 需要认证；API token 放在 `Authorization: token {token}` header 中可访问
  - VS Code webview 不共享 extension host 的 cookie，因此不能直接在 `<img src>` 中使用附件 URL，需扩展宿主代理并转换为 base64 data URL
- [x] 中文字符在 URL path 中的编码要求
  - REST path 参数（如文件名、分支名）需使用 `encodeURIComponent` 编码；源码使用标准 URL 路由解析，非 ASCII 字符必须 percent-encode

---

## 2026-09-23 代码审查后的状态更新

本清单的逐端点「差异记录」写于代码审查之前；审查（含交叉核对）确认的问题已全部修复，因此下面这些条目不再代表当前代码，遇到冲突时以本节为准：

- 依赖列表不再「静默截断 30 条」：`listIssueDependencies` 改为经 `_fetchAllPages(page/limit)` 取全量（`e1bbc40`）。
- timeline 的分页收尾改为有界前瞻：`_fetchAllPages` 的 `shortPageMarksEnd: false` 现在容忍一个被过滤空的整页（连续两页为空才停），不再因过滤发生在取页之后而少取（`e1bbc40` + 本轮修复）。
- `GET /pulls` 的 `null` 元素已在 client 层过滤（`_definedPullRequests`），状态栏不再可能解引用崩溃（`e1bbc40`）。
- Actions 取消规则由 `webview/src/utils/actionStatus.ts` 的 `isActionRunCancellable` 实现（含服务端真实状态 `blocked`），`canCancelRun` 与其 `pending`/`requested` 白名单已删除；删除按钮另有 `isActionRunDeletable` 闸门（只允许 success/failure/cancelled/skipped）（`ad02973` + 本轮修复）。
- 计时面板：合计会按「总计／我的工时」标注（`isTrackedTimeTotal`）、他人条目的删除按钮不再显示（`canDeleteTrackedTime`）、在别的 issue 有计时时给出提示（`findStopwatchElsewhere`）；`stopwatch/delete` 的确认文案已改为「取消正在运行的计时器」（`3fe67b9`）。
- issue 附件上传的回复已带上 `id`，编辑框内删除不再静默无效；评论编辑/删除的作用域已限定到当前实例与仓库（本轮修复）。
- 子路径实例（`https://host/a` 与 `https://host/b`）不再共用 id 与 token secret（`instanceIdFor`，本轮修复）。
- 上表中形如 `client.ts:1338-1342` 的行号引用写于 `e1bbc40` 之前，已随该提交失效；以方法名（`listIssueDependencies`、`getPullRequestCommentsAndTimeline` 等）为准。

---

## 后续维护策略

当上游有新的 Forgejo 版本时，按以下方式更新本清单：

1. **日常更新：以固定的上游版本为基准复核**
   - 本地参考检出是 shallow clone（存在 `.git/shallow`）、`git tag` 为空、且不含上游完整历史：`git diff <old>..<new>` 只能比较本地已经存在的提交，无法对比尚未拉取的上游版本。不要为了比较而 `git fetch` / `git pull`，参考检出必须保持只读、不被改动。
   - 选定一个固定的上游 tag/release 或 commit（例如 `v15.0.0`，或本清单顶部记录的 `62c6d1c782720308d0a973435c62ce50fdebd99f`），以只读方式取得该版本的源码：另建一个该 tag 的 shallow clone，或直接读 Codeberg 上该 tag 的 raw 文件。
   - 逐目录比对 `routers/api/v1/`、`services/convert/`、`modules/structs/`，查看是否有影响已记录端点的变更；需要机器可读的完整规格时读取 `templates/swagger/v1_json.tmpl`（仓库中不存在 `templates/swagger/v1.json`）。
   - 只对受影响的端点重新核对并补充说明；完成后把「核对方法」中记录的 Git commit 换成本次实际对比的上游 commit 或 tag，未固定版本就不要声称「已复核」。
   - 如果相关改动导致现有 workaround 失效，同步更新 `KNOWN_ISSUES.md` / `KNOWN_ISSUES.zh.md`。

2. **大版本升级：全量重新核对**
   - 当 Forgejo 发布 major 版本、API 路由结构重排、或 diff 涉及大量路由/转换层文件时，建议全量重新走一遍本清单。
   - 全量核对前先备份旧版本清单，便于对比差异。

3. **新增 API 调用**
   - 在扩展代码中新增 Forgejo API 调用前，先在本地源码中找到对应 handler。
   - 在本清单对应分类下新增条目，按「核对方法」逐条确认后标记 `[x]`。
   - 若新增端点与现有 workaround 相关，同步更新 `KNOWN_ISSUES`。
   - 覆盖率由 `node tools/api-audit/check.mjs` 把守：它从 `src/api/client.ts` 反解出实际调用的生成操作，逐个在本文档里按路径形状（占位符名可不同）查找，缺一个就以非零退出——新增调用后先跑它，再补对应小节。

4. **提交前检查**
   - 每次更新清单后，同步修改顶部的 Git commit ID，并在「最近一次核对结论」中写一句摘要。
   - 不需要在正文里保留历史核对表格；历史版本由本文件的 git 日志保存。
   - 如只涉及 markdown 文档，无需运行 build；如因此次核对结果修改了 TypeScript/Vue 代码，按项目规范运行 `pnpm check`。

---

## 核对结论

本次核对覆盖了 Forgejo Toolkit 当前实际调用的主要 REST API 端点，并对照 Forgejo 服务端源码确认了请求参数、响应字段、错误码及行为边界。

- 未发现与源码实现相悖的重大差异。
- 现有 workaround（PR 详情通过 issues 端点合并 `assets`、PR 级别变更文件改用 compare 端点、webview 图片通过 extension host 代理为 base64）与源码一致，已在 `KNOWN_ISSUES.md` / `KNOWN_ISSUES.zh.md` 中记录。
- 状态枚举映射（compare diff 的 `modified` vs PR files 的 `changed`）已在代码中做兼容处理，无需额外用户侧说明。
- 2026-09-23 的覆盖率补漏核对（同一 commit，当时客户端共 94 个端点，重新生成后为 82 个，见「核对方法」）新增 30 个端点小节，并记录了若干**服务端行为与 swagger 注释不符**、以及**扩展侧语义偏差**：
  - `DELETE .../issues/{index}/dependencies` 实际返回 201（注释写 200）；订阅 `PUT`/`DELETE .../subscriptions/{user}` 的 304 实际是 403；`GET .../milestones` 的 `state` 缺省并**不**默认 `open`（会同时返回 open 与 closed）；`DELETE .../actions/runs/{run_id}` 对未完成的 run 返回 500（swagger 声明 400）。
  - `GET .../issues/{index}/dependencies` 在扩展未传 `page`/`limit` 时只返回前 30 条且无总数头 → 依赖超过 30 个会被静默截断；`GET .../issues/{index}/timeline` 的过滤发生在分页之后，配合 `_fetchAllPages` 的「短页即结束」判定，大量行级评论时可能少取。
  - 时间追踪：非 issue 写入者的 `GET .../times` 只返回本人记录，而 UI 把它当作该 issue 的时间汇总；`DELETE .../times/{id}` 只允许记录本人或 site admin，UI 未按作者隐藏按钮；stopwatch 是**每用户全局唯一**，扩展按单个 issue 判断导致「在别的 issue 正计时时启动会静默结束另一条」；`stopwatch/delete` 只取消计时、不记时间，但 host 确认文案写成了「删除已记录的时间」。
  - Actions：`canCancelRun` 的状态白名单漏了服务端真实状态 `blocked`，并包含并非 Forgejo 状态的 `pending`/`requested`；`GET /pulls` 的响应可能含 `null` 元素，而 `createPrStatusBar.ts:30-31` 未判空。
  - 这些偏差都是「不报错但语义/展示不对」或「需要配套 UI 修正」，已逐条写入对应端点的「差异记录」，并已全部修复——见下方「2026-09-23 代码审查后的状态更新」。
- 全局发现中的 limit 限制、响应类型、认证方式、URL 编码等结论已汇总到「全局发现」一节。

如后续新增 API 调用，应先在本地 Forgejo 源码中定位对应 handler，然后将该端点补充到本清单并重新核对。
