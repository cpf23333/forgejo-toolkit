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

---

## 核对方法

本次核对的 Forgejo 源码版本：

- Git commit：`62c6d1c782720308d0a973435c62ce50fdebd99f`
- 本地源码路径：由用户环境决定，后续核对前请提供当前使用的 Forgejo 仓库路径
- 最近一次核对结论：当前清单中所有端点与该版本 Forgejo 源码一致；上一次 diff 复核（`b4d03e7..62c6d1c`）仅涉及代码格式化、webhook 内部事件调整以及当前未使用的新类型（`IssueSuggestion`、`RepoFundingEntry`），不影响已记录端点的行为。

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
- [x] 响应 `files` 是每个 commit 的 `CommitAffectedFiles` 简单合并，不计算净变更；status 仅 `added`/`removed`/`modified`/`renamed`/`copied` 中的简化值
- [x] 重命名文件返回 `previous_filename`
- [x] 源码位置：`routers/api/v1/repo/compare.go:17-100`
- [x] 差异记录：与 `repoGetPullRequestFiles` 的 `status` 枚举不完全一致（compare 可能返回 `modified`，files 端点返回 `changed`），当前 `getPullRequestFilesFromCompare` 已做兼容映射，基本正确

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

### `DELETE /repos/{owner}/{repo}/pulls/{index}/reviews/{id}/comments/{commentId}`

- [x] 实际调用 `deleteIssueComment` 删除，权限与 issue comment 一致
- [x] 源码位置：`routers/api/v1/repo/pull_review.go:1055-1100`
- [x] 差异记录：无

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
- [x] 源码位置：`routers/api/v1/repo/issue_reaction.go`
- [x] 差异记录：无

### Issue 订阅 / 时间追踪 / 依赖

- [x] 订阅：`check`/`{user}` PUT/DELETE，用户名为路径参数
- [x] 时间追踪：start/stop/delete stopwatch；times 列表、添加、删除
- [x] 依赖：列表、添加、删除，依赖项用 `index`、`owner`、`repo` 指定
- [x] 源码位置：`routers/api/v1/repo/issue_subscription.go`、`issue_stopwatch.go`、`issue_tracked_time.go`、`issue_dependency.go`
- [x] 差异记录：无

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
- [x] 支持 `merge_title_field`、`merge_message_field`、`merge_when_checks_succeed`、`force_merge`、`delete_branch_after_merge`
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

- [x] 返回 `CombinedStatus`，`state` 取值：pending / success / error / failure / warning
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
- [x] `files` 为 true 时返回 `CommitAffectedFiles`，`status` 取值同 diff status
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
- [x] 差异记录：无

### `PATCH /notifications`

- [x] 参数：`all`（boolean）、`status-types`（multi，默认 unread）、`to-status`（默认 read）、`last_read_at`
- [x] 仅标记 `updated_at <= last_read_at` 的通知
- [x] 响应 205 返回被修改的线程数组
- [x] 源码位置：`routers/api/v1/notify/user.go:93-175`
- [x] 差异记录：当前 `markAllNotificationsRead` 传 `all: true, to-status: read`，与源码一致

### `PATCH /notifications/threads/{id}`

- [x] 参数：`to-status`（默认 read），支持 unread / read / pinned
- [x] 仅允许本人或管理员操作
- [x] 响应 205 返回更新后的线程
- [x] 源码位置：`routers/api/v1/notify/threads.go:53-103`
- [x] 差异记录：无

### `GET /repos/search`

- [x] 参数：`q`、`limit`、`page`、`uid`、`topic`、`includeDesc`、`sort`、`order` 等
- [x] 响应结构：`{ ok: true, data: Repository[], total_count: N }`（通过 link/total 头）
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

### `GET /repos/{owner}/{repo}/actions/runs`

- [x] 返回 `{ total_count, workflow_runs: ActionRun[] }`（`ListActionRunResponse`）
- [x] 支持 `page`/`limit`，默认 limit 50；支持 `status`、`event`、`run_number`、`head_sha`、`ref`、`workflow_id` 过滤
- [x] 源码位置：`routers/api/v1/repo/action.go:869-976`
- [x] 差异记录：当前 `listActionRuns` 取 `result.entries`（源码字段 `workflow_runs`），与源码一致

### `GET /repos/{owner}/{repo}/actions/runs/{runId}`

- [x] 返回单个 `ActionRun`，包含 `id`、`name`、`head_branch`、`head_sha`、`event`、`status`、`conclusion`、`created_at`、`updated_at`、`run_number`、`jobs` 等
- [x] 源码位置：`routers/api/v1/repo/action.go:978-1035`
- [x] 差异记录：无

### `GET /repos/{owner}/{repo}/actions/runs/{runId}/jobs`

- [x] 返回 `ActionRunJob[]` 直接数组
- [x] 每个 job 包含 `id`、`run_id`、`status`、`conclusion`、`name`、`started_at`、`completed_at` 等
- [x] 源码位置：`routers/api/v1/repo/action.go:1160-1223`
- [x] 差异记录：当前 `getActionRunJobs` 将 `.jobs` 字段作为降级，源码直接返回数组，当前兼容处理正确

### `GET /repos/{owner}/{repo}/actions/runs/{runId}/artifacts`

- [x] 返回 `ActionArtifact[]` 直接数组
- [x] 支持 `name` 过滤和 `page`/`limit` 分页
- [x] 源码位置：`routers/api/v1/repo/action.go:1287-1370`
- [x] 差异记录：当前 `getActionRunArtifacts` 将 `.artifacts` 字段作为降级，源码直接返回数组，当前兼容处理正确

### `GET /repos/{owner}/{repo}/actions/jobs/{jobId}/logs`

- [x] 响应 `Content-Type: text/plain; charset=utf-8`
- [x] 支持 `?attempt=N` 和 `?step=N` 过滤
- [x] 支持 Range 请求
- [x] 源码位置：`routers/api/v1/repo/action.go:1620-1720`
- [x] 差异记录：当前使用 `responseType: 'text'`，与源码一致

### `POST /repos/{owner}/{repo}/actions/workflows/{workflowfilename}/dispatches`

- [x] 请求体：`ref`（必填）、`inputs`（map）、`return_run_info`（boolean）
- [x] `return_run_info` 是 Forgejo 特有扩展；为 true 时返回 201 和 `{ id, run_number, jobs }`
- [x] 为 false 时返回 204
- [x] 源码位置：`routers/api/v1/repo/action.go:786-867`
- [x] 差异记录：当前 `dispatchWorkflow` 传 `return_run_info: true` 并解析返回，与源码一致

### `POST /repos/{owner}/{repo}/actions/runs/{runId}/cancel`

- [x] 取消 pending / running 的 run；已完成 run 不变，仍返回 204
- [x] 源码位置：`routers/api/v1/repo/action.go:1099-1158`
- [x] 差异记录：无

### rerun（重新运行 workflow run）—— REST API 不存在（负向核对）

- [x] `routers/api/v1/api.go` 的 actions 路由组中未注册任何 rerun 路由；仅有 cancel（`api.go:909`）与 dispatch（`api.go:917`）
- [x] rerun 仅以 web 路由存在：`POST /{owner}/{repo}/actions/runs/{run}/rerun`（`routers/web/web.go:1636`、`1649`，handler `routers/web/repo/actions/view.go:502`），属 session 认证组，不接受 API token
- [x] 差异记录：扩展不提供「重新运行」按钮，已作为平台限制记录在 `KNOWN_ISSUES.md` / `KNOWN_ISSUES.zh.md`；不建议模拟 web 表单请求

### `GET /repos/{owner}/{repo}/actions/artifacts/{artifactId}/zip`

- [x] 响应 `Content-Type: application/zip`，直接返回 ZIP 二进制
- [x] 不需要特殊 `Accept` header
- [x] artifact 未确认上传完成时返回 404
- [x] 源码位置：`routers/api/v1/repo/action.go:1419-1484`
- [x] 差异记录：当前使用 `responseType: 'stream'` 流式写盘（带 2GB 防御上限与 30s 空闲 watchdog），与源码行为一致

### `DELETE /repos/{owner}/{repo}/actions/runs/{runId}`

- [x] 删除完成的 workflow run（成功/失败/取消）
- [x] 未完成的 run 删除可能失败
- [x] 源码位置：`routers/api/v1/repo/action.go:1037-1097`
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

## 附件与 Release

### Issue / PR / Comment 附件

- [x] 上传使用 `multipart/form-data`，文件字段名 `attachment`
- [x] 查询参数 `name` 可覆盖原始文件名
- [x] 返回 `api.Attachment`，字段：`id`、`name`、`size`、`uuid`、`download_url`、`created`
- [x] `download_url` 实际为 `{appURL}/attachments/{uuid}`（由模型 `DownloadURL()` 生成）
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
- [x] 所有列表接口的响应类型（直接数组 vs `{ data: [], total: N }` vs `{ xxx: [] }`）
  - 直接数组：`/notifications`、`/repos/{owner}/{repo}/actions/runs/{runId}/jobs`、分支/tag、评论等
  - `{ data: [], total_count: N }`：`/repos/search`、`/issues/search`、`/users/search`
  - `{ total_count, workflow_runs: [...] }`：`/repos/{owner}/{repo}/actions/runs`
- [x] 所有 `status` / `state` 枚举值的一致性
  - PR 文件接口：`added`/`deleted`/`changed`/`renamed`/`copied`
  - Compare diff：`added`/`removed`/`modified`/`renamed`/`copied`
  - Commit affected files：`added`/`removed`/`modified`/`renamed`
  - Combined status：`pending`/`success`/`error`/`failure`/`warning`
  - Issue/PR state：`open`/`closed`
- [x] 附件 URL 是否需要 token 鉴权（Cookie vs Header）
  - `/attachments/{uuid}` 需要认证；API token 放在 `Authorization: token {token}` header 中可访问
  - VS Code webview 不共享 extension host 的 cookie，因此不能直接在 `<img src>` 中使用附件 URL，需扩展宿主代理并转换为 base64 data URL
- [x] 中文字符在 URL path 中的编码要求
  - REST path 参数（如文件名、分支名）需使用 `encodeURIComponent` 编码；源码使用标准 URL 路由解析，非 ASCII 字符必须 percent-encode

---

## 后续维护策略

当本地 Forgejo 源码拉取到新提交时，按以下方式更新本清单：

1. **小版本 / 日常更新：diff 驱动**
   - 记录旧 commit ID（即本清单当前记录的版本）与新 commit ID。
   - 在 Forgejo 仓库执行 `git diff <old>..<new> -- routers/api/v1/ services/convert/ modules/structs/` 等目录，查看是否有影响已记录端点的变更。
   - 仅对 diff 中涉及的端点重新核对，更新对应条目的 `[x]` 时间戳或补充说明。
   - 如果相关改动导致现有 workaround 失效，同步更新 `KNOWN_ISSUES.md` / `KNOWN_ISSUES.zh.md`。

2. **大版本升级：全量重新核对**
   - 当 Forgejo 发布 major 版本、API 路由结构重排、或 diff 涉及大量路由/转换层文件时，建议全量重新走一遍本清单。
   - 全量核对前先备份旧版本清单，便于对比差异。

3. **新增 API 调用**
   - 在扩展代码中新增 Forgejo API 调用前，先在本地源码中找到对应 handler。
   - 在本清单对应分类下新增条目，按「核对方法」逐条确认后标记 `[x]`。
   - 若新增端点与现有 workaround 相关，同步更新 `KNOWN_ISSUES`。

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
- 全局发现中的 limit 限制、响应类型、认证方式、URL 编码等结论已汇总到「全局发现」一节。

如后续新增 API 调用，应先在本地 Forgejo 源码中定位对应 handler，然后将该端点补充到本清单并重新核对。
