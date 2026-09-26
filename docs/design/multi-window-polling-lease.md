# 多窗口「一个窗口主导」租约（polling lease）

- 状态：**设计（未实现）**，默认关闭，落地前需维护者裁决 §12 的开放问题
- 关联：`TODO.md` 的 P4 条目（「多窗口重复轮询 / 探测」）、`KNOWN_ISSUES.md` 的
  "Every window polls and probes each instance on its own"（及 `KNOWN_ISSUES.zh.md` 对应条目）
- 基线代码：HEAD `b14d764`，行号按**当前工作树**（含其他 agent 的在途改动）核对

> 工作树里有其他 agent 的在途改动，行号会漂移，所以每条断言都同时给出**可搜索的标识符 /
> 代码片段**；以标识符为准，行号只用于加速定位。核对清单见 §13。

---

## 1. 问题

### 1.1 现状：每个窗口各跑一份

`onStartupFinished` 是**按窗口**生效的激活事件（`packages/forgejo-toolkit/package.json:342-347`），
而它存在的原因是 MCP 服务器需要可发现性（`TODO.md:24`、`TODO.md:48`）。于是激活路径上三件
"应该全机器只做一次"的事，每个窗口都做了一次：

1. **版本探测**：`src/extension.ts:96-98` 对每个实例各 `void probeServerVersion(...)`。
   探测结果写进**进程内**的 Map（`src/api/serverVersion.ts:66-67` 的 `serverVersions`），
   所以窗口之间不共享，10 个窗口就是 10 倍请求。
   `src/api/versionProbe.ts:40-42` 在版本过低时会 `notifyUnsupportedInstance`，而那条提示的去重集
   也是进程内的（`src/api/vscodeClientHost.ts:13-15` 的 `shownUnsupportedVersionUrls`）——
   **同一个"版本过低"警告会每窗口弹一次**。
2. **通知轮询**：`src/extension.ts:124-126` 构造并启动 `NotificationPoller`。轮询节奏见
   `src/notifications/notificationPoller.ts:155-164`（`setInterval`，间隔
   `getNotificationPollingInterval() * 1000` 秒），配置范围 60–3600 秒、默认 300 秒
   （`src/config.ts:15-17`、`packages/forgejo-toolkit/package.json:118-124`）。
   `_pollAll` 对每个实例并发发一次请求（`notificationPoller.ts:229-241`）。
   **每个窗口都会为新通知弹一次聚合提示**（`notificationPoller.ts:456-484`）。
3. **首次运行向导标记**：`src/extension.ts:104-108` 调 `maybeShowWelcomeOnboarding`，其实现是
   典型的 read-then-write（`src/welcome.ts:35-48`）；`KNOWN_ISSUES.zh.md:212` 已经如实记录了
   "同时恢复的多个窗口可能各自打开一次该面板"。

### 1.2 现状：`globalState` 的跨窗口语义（必须诚实的部分）

- `globalState` 没有跨窗口变更事件。仓库自己在两处写明了这一点：
  `src/config.ts:351-358`（"globalState 没有跨窗口变更事件，所以另一个窗口可能已更新列表"）与
  `notificationPoller.ts:404-435`（"另一个窗口的 reconcile"会覆盖本窗口写回的 map）。
- `context.globalState.update(key, value)` 是**整键覆盖**，核心上是一个 Map 的赋值。它**没有**
  compare-and-swap、没有多键事务、也没有"仅当仍等于我读到的值时才写入"的形式。
- 它是**异步**的：`await update(...)` 只保证"这次写入已完成"，不保证这期间没有别的窗口写入
  （写完即可能被覆盖），也不保证写入之间有任何顺序可见性。
- 于是"读 → 改 → 写"在跨窗口时**不是原子的**，两次调用之间有一个真实的窗口期。仓库对此的
  既有处置是"缩小窗口期 + 合并式写回"，而不是假装原子：
  - 实例列表：`_writeInstancesMerged` 在写之前紧邻着重读一次
    （`src/config.ts:366-383`），注释自认"merge 无法完全关闭竞态（get→update 不是原子的），
    只是把窗口缩到两次调用之间的同步跨度"。
  - worktree 列表：同样在写回前重读（`src/worktree/worktreeManager.ts:193-204`），
    并明确写出"队列只序列化**本**扩展宿主，而两个窗口是共享同一批 globalState 键的两个进程"。
- **反例（本文顺带发现的一个真实缺口）**：通知的已读基线是**整表覆盖**
  （`notificationPoller.ts:412-433`：把 `allSeen` 全量序列化后 `update`）。
  `allSeen` 来自本窗口读过（或自己维护的）快照，所以窗口 A 在 10 分钟前读到
  `{instA: [...]}`、期间窗口 B 加了一个实例并写入 `{instA, instB}`，
  A 的下一次 reconcile 会把 B 的条目**整条丢掉**。后果不是崩溃，而是**少一次提示**：
  基线没了 ⇒ `hadBaseline === false` 走 `notificationPoller.ts:416-420` 的抑制分支，
  于是这一轮**不报**；A 写完新基线后下一轮才恢复正常判定。这条属于**同类基础设施缺陷**，
  本文的租约不会修它，但建议用同一套"单写者"思路收敛（见 §9 与 §12.6）。

### 1.3 结论

需要一个"一个窗口主导"的机制，让**全机器只有一份**轮询与探测，同时**不允许**任何失败模式
导致"没人轮询"。

---

## 2. 决策（摘要）

1. **租约放在文件里，不放 `globalState`。** 位置：扩展的 `globalStorageUri` 目录下的固定名
   `mcp-leader-lease.json`（与既有的 `mcp-broker.json` / `mcp-instances.json` 同目录、
   同一套权限约定，见 `src/mcpWorkspaceState.ts:59-75`、`src/mcpBroker.ts:42-44`）。
   理由见 §3：`globalState` 的读改写不原子，而 `fs.open(path, 'wx')` 在同机同文件系统上是
   **真正的互斥**（核心保证"不存在则创建"是一次原子操作），这把"抢占"从概率问题变成确定问题。
2. **心跳 10 秒，过期 35 秒**（3 个心跳），与轮询间隔（≥ 60 秒）解耦。
3. **`deactivate()` 主动让位**（删租约文件），崩溃/强杀则靠过期超时接管；接管竞争由
   `wx` 文件创建裁决，输家继续当 follower。
4. **follower 不会静默停止轮询**：follower 仍持有一个退避计时器，租约不可用时按
   全速轮询兜底。宁可多轮询，绝不少通知。
5. **主导者可见**：日志 + 一个命令/状态栏入口可以告诉用户"哪个窗口在轮询"，并提供
   "本窗口强制接管"。
6. **默认关闭**，通过设置项 `forgejoToolkit.multiWindowLease` 开启（先例：
   `packages/forgejo-toolkit/package.json:113-124` 的两个轮询设置），并要求 §11 的证据才转默认开启。

---

## 3. 租约在哪里、长什么样

### 3.1 位置与权限

- 路径：`path.join(context.globalStorageUri.fsPath, 'mcp-leader-lease.json')`。
- 目录按既有约定收紧到 `0700`，文件 `0600`：先例 `src/mcpBroker.ts:190-199`
  （`mkdir(mode 0o700)` + `chmod` + `writeFileAtomically(..., { mode: 0o600 })`）。
- **为什么不用 `globalState`**：见 §1.2。另外 `globalState` 是编辑器的状态库，用户清缓存
  （Profile / "清除工作区状态"）会让租约莫名消失——那其实是**安全**的失败方向（会退化成
  全速轮询），但会让"为什么突然又多轮询了"难以解释。文件在 globalStorage 里语义更直白，
  而且已有三个同目录文件的先例。
- **不用 `mcp-broker.json` 复用**：broker 是"全机器唯一的管道监听者"，它确实也是一个强互斥
  （`src/mcpBroker.ts:163-174`，`EADDRINUSE` 让位），但 (a) broker 只在一个窗口里跑，
  意图是"提供 MCP 转发"，不是"代表轮询"；(b) broker 的注册表在
  `docs/architecture/mcp-server.md:303-312` 描述的语义下是"描述一个活着的监听器"，
  把轮询主导权塞进它会同时改两个子系统的语义。**保持两件事分开**，但可以互相借鉴
  （见 §3.4 的"为什么不拿 broker 当选主器"）。

### 3.2 内容

```jsonc
{
  "version": 1,
  "ownerNonce": "<per-window random hex，进程内生成一次，模块级>", // 区分同 pid 的不同窗口
  "pid": 12345, // 便于日志与人工排查，也是崩溃粗筛
  "windowId": "…", // 可选：VS Code 没有稳定的窗口标识，展示用工作区名即可
  "claimedAt": 1767225600000, // Date.now()，epoch ms
  "heartbeatAt": 1767225610000, // 每次心跳刷新
  "releaseReason": null, // "deactivate" / "takeover-requested" / "stepped-down"
  "appVersion": "0.0.1",
  "instancesFingerprint": "…", // 实例集合的指纹，见 §3.3
}
```

字段只用 JSON 基本类型（与仓库其他文件一致的风格）。**不写 token、不写 URL 凭据**：
`ownerNonce` 是本地随机量，不是凭据；`instancesFingerprint` 只用于判断"租约是否描述了我关心的
那批实例"，不含用户名/地址（可用 `instance.id` 的排序拼接后哈希，id 本身不是秘密但没必要
外泄地址）。

### 3.3 实例集合变化的处理

- 租约里记一个实例集合指纹。**指纹变化不触发重新选主**：主导者在下一次心跳时把指纹更新到
  最新即可（它的职责是"代表本机轮询所有已配置实例"，实例增删由本窗口的
  `config.onInstancesChanged` 驱动，`notificationPoller.ts:104-114` 已经在监听）。
- follower 发现指纹不同**不** takeover。理由：两个窗口共享同一份
  `forgejoToolkit.instances`（`src/config.ts:13`），指纹不同的窗口期通常只是"另一个窗口刚写完
  而我还没重读"。为它触发选主只会制造抖动。
- 如果实现时发现"多窗口实例列表长时间不一致"是真实问题（例如导入后另一个窗口一直没刷新），
  那属于 `globalState` 没有变更事件这一既有缺陷，应当按 §12.2 的边界单独立项（它超出了本文
  的"轮询主导权"范围）。

### 3.4 候选方案对比（为什么不用别的）

| 方案                                                               | 结论                 | 理由                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `globalState` 读改写 + 时间戳                                      | **不采用为唯一机制** | 竞态真实存在，见 §1.2。仓库自己的注释也这么说（`config.ts:351-358`）。                                                                                                                                                                 |
| `globalState` 两阶段"写候选 → 等一个 settle 期 → 重读确认自己还在" | 不采用               | 概率性、需要引入魔法延时，而且在"重读时看到的是我还是别人"上仍依赖写入落盘顺序。                                                                                                                                                       |
| 复用 broker 的命名管道/Unix socket 绑定当互斥                      | **不作为选主器**     | 它确实原子（`src/mcpBroker.ts:163-174`），但 broker 只有"扩展宿主需要转发 MCP"时才启动，且默认路径就是"第一个窗口赢"——把轮询主导权绑上去会让"关掉 MCP 前端"意外改变轮询拓扑。**借鉴它的原子原语（`wx` / bind），不绑定它的生命周期**。 |
| 用 `wx` 独占创建文件                                               | **采用**             | 同机同文件系统上"不存在则创建"是原子的；失败即 `EEXIST`，语义清晰；与仓库既有的"原子写 + 收紧权限"风格一致（`src/utils/atomicWrite.ts:33-65`）。                                                                                       |
| 用 `LockFile` 类库 / `flock`                                       | 不采用               | Node 无跨平台的 `flock`；引依赖违背"能不加就不加"的既有取向。                                                                                                                                                                          |

---

## 4. 抢占协议（claim）

### 4.1 当前主导者的心跳

主导者每 **10 秒**：

1. 读租约文件。
2. 若 `ownerNonce` 不是自己（说明有人接管过：时钟跳变、手工接管、旧进程残留）→ **主动降级**为
   follower，打日志，停掉自己的轮询。
3. 否则用"原子写 + rename"（`writeFileAtomically`，`src/utils/atomicWrite.ts:33`）把
   `heartbeatAt` 刷成 `Date.now()`，并顺带更新指纹。

### 4.2 follower 的抢占

follower 的状态机：

```
每 tick（10 秒，带抖动）:
  读租约文件
  ├─ 文件不存在                → 尝试 claim
  ├─ 解析失败 / 字段不合法      → 视为过期，尝试 claim（安全方向：回到全速轮询）
  ├─ heartbeatAt 距今 > 35 秒  → 视为过期，尝试 claim
  └─ 否则                      → 继续当 follower（不轮询服务器）
```

`claim()` 的实现是唯一需要原子性的地方：

1. 生成 `ownerNonce`（若尚无）；
2. `fs.promises.open(leasePath, 'wx', 0o600)`：
   - **成功** → 写入完整记录（`claimedAt` = `heartbeatAt` = now）→ 本窗口成为主导者 →
     立刻启动/恢复轮询与探测；
   - **`EEXIST`** → 竞争失败 → 关掉 fd、不写任何东西 → 重新读一次文件并回到 follower 分支
     （若这次读到的是过期记录，说明赢家刚写完，也是正常结果）；
   - 其它错误（`EACCES`、`ENOSPC`、`EROFS`…）→ **放弃租约机制**，本窗口按全速轮询兜底
     （§8），并记一条 info 级日志（只报一次失败连串）。
3. `unlink` 陈旧租约再 `wx` 创建：**只在"读到过期"这条路径上做**，并且 `unlink` 失败
   （`ENOENT`）直接吞掉继续重试一次。**不要在 `EEXIST` 后立刻 `unlink` 重试**——那会在两个
   follower 同时抢时互相删掉刚被赢家写入的记录。这一点是本协议最需要写进注释的地方。
4. 抖动：follower tick 间隔取 `[8s, 12s]` 均匀随机，避免 N 个窗口在同一个毫秒一起抢。

### 4.3 为什么这个协议是确定的

- 同机同文件系统上，`wx` 创建由内核裁决，**恰好一个**调用成功。这是唯一需要的原子原语。
- 抢占不依赖时间戳正确：时间戳只用于"是否过期"的判断，而"谁赢"由 `wx` 决定。
  即便两个窗口的时钟都错了（比如手工改表），最坏结果是**假过期**引发一次接管，
  而原主导者在下一个心跳（≤10 秒）发现自己不是 owner 就降级（§4.1.2）——**撤销一次抖动最多
  10 秒**，不会长期出现两个主导者。
- 网络文件系统 / 云同步目录是例外：`wx` 的语义在那里可能不可靠。这属于 §8 的"机制不可用"
  分支，退化为全速轮询。

---

## 5. 被主导者关闭时会发生什么（逐场景）

| 场景                                                 | 行为                                                                                                                                                                                                                               | 用户可感知的后果                                                                                                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **正常关闭**（`deactivate()`）                       | 在 `src/extension.ts:170-178` 的 `deactivate` 里（与 `cleanupMcpBroker` 同处）删掉自己拥有的租约文件；**只有 `ownerNonce` 是自己的才删**，避免删掉继任者的文件（同 `cleanupMcpBroker` 的所有权判断，`src/mcpBroker.ts:344-368`）。 | follower 的下一次 tick（≤12 秒，抖动上限）就能 `claim`。**唯一需要 `deactivate` 可靠执行**；注意 VS Code 不保证 `deactivate` 被 await 到结束，所以删除失败也不影响正确性，只是慢 35 秒。 |
| **崩溃 / 强杀 / 断电**                               | 租约文件留着，`heartbeatAt` 不再刷新。35 秒后过期，第一个 tick 到的 follower 抢走。                                                                                                                                                | 最长 47 秒（35 + 12 抖动）的轮询空窗。**这是本设计的核心权衡**：这段时间内没有新通知提示；用户看到的只是"晚一点弹"。                                                                     |
| **两个 follower 同时抢**                             | `wx` 只有一个赢；输家 `EEXIST` → 重读 → follower。                                                                                                                                                                                 | 无。                                                                                                                                                                                     |
| **三个以上窗口**                                     | 同上，与窗口数无关。                                                                                                                                                                                                               | 无。                                                                                                                                                                                     |
| **租约无人认领**（文件不存在）                       | 每个窗口都进入 §4.2 的 claim 分支；赢家立刻开始轮询，输家等下一个 tick 再评估。                                                                                                                                                    | 最多 12 秒（抖动上限）后才有人开始轮询，且这段时间**没有**服务器请求。这是有意的：比"每个窗口都在猜"更省，也比"太久没人轮询"更短。若要更保守，可以让窗口数 > 1 时立即 claim（§12.4）。   |
| **时间戳过期但主导者其实活着**（时钟跳变、挂起唤醒） | 新窗口接管；旧主导者下一个心跳（≤10 秒）发现 `ownerNonce` 变了 → 降级。                                                                                                                                                            | 最多 10 秒的双主导者窗口，期间可能多一次请求与一次重复提示。可接受。                                                                                                                     |
| **follower 在等租约时用户点开通知视图**              | 视图的数据来自 `getNotifications` 命令（宿主与 webview 的正常消息路径），与轮询是两条路；follower 的窗口仍能手动刷新看到通知。                                                                                                     | 不丢功能，只少"自动提示"。落地时必须**实测确认**这一点（§11.5）。                                                                                                                        |

---

## 6. 时钟、挂起与休眠

- **同一台机器上的窗口共享一个系统时钟**（窗口是同一 VS Code 安装、同一用户会话下的独立
  extension host 进程）。所以正常情况下"时间戳比较"是自洽的，不存在"两台机器的时钟偏差"问题。
  这是本设计敢用 `Date.now()` 的前提，必须写在文档里，因为读者第一反应往往是"分布式时钟"。
- **挂起/休眠**：进入睡眠时所有窗口一起停。主导者的心跳计时器在唤醒后触发，写入一个新的
  `heartbeatAt`；follower 在同一时刻醒来时，若它先 tick，可能读到"距今 > 35 秒"的旧值并尝试
  接管。两种结果都不坏：抢到了 → 新主导者立即轮询，旧主导者 10 秒内降级；没抢到 → 继续
  follower。真正的风险是"唤醒后 35 秒内**没有任何人**轮询"——如果所有窗口的计时器都因为休眠
  被节流，这正是 §8 兜底要覆盖的情形（见 §8.1 的轮询饥饿看门狗）。
- **时钟回拨**：`heartbeatAt` 变小会让过期判断**更保守**（更不容易被抢）。安全方向。
- **时钟前跳**（手工改表、NTP 大跳）：可能触发一次假接管；由 §4.1.2 的"每心跳校验 owner"在
  10 秒内收敛。
- **实现上必须避免**用 `performance.now()` / `process.hrtime()` 做跨窗口比较：它们只在进程内
  有意义，与 §3.2 的 epoch 字段混用会造成"永远不过期"或"立刻过期"这类灾难性错误。
  单进程内的计时（心跳间隔、抖动）用 `setTimeout` 就够，不需要额外时钟。

---

## 7. 主导者如何被用户看见，以及如何强制接管

### 7.1 可见性

- **日志**：主导者启动/接管/降级各写一条 info，内容含 `pid`、`ownerNonce` 前 8 位、
  触发原因（`claimed` / `takeover-expired` / `stepped-down-owner-changed` / `lease-unavailable`）。
  follower 只在**状态变化**时写（避免每 10 秒刷屏）；轮询本身已有
  `notificationPoller.ts:276` 的 debug 行可对照。
- **一个查询入口**：加命令 `forgejoToolkit.showPollingLeader`（或用既有的
  `forgejoToolkit.showLog`，`packages/forgejo-toolkit/package.json:181-182`），读租约文件并展示
  "哪个窗口（pid / 工作区名）在轮询、心跳距今多少毫秒"。这是用户回答"为什么这个窗口不弹提示 /
  为什么那个窗口弹了两次"的唯一可靠途径。
- **状态栏**：`§12.3` 待定。倾向**不做**常驻状态栏（轮询主导权是基础设施细节，
  常驻图标会变成噪音）；至少在没有租约/机制降级时给一次轻量提示。

### 7.2 强制接管

- 命令 `forgejoToolkit.forcePollingLeadership`（可在命令面板搜到，**不做**通知提示）：
  1. 读租约；若自己已经是 owner，什么都不做并提示"本窗口已在轮询"；
  2. 若租约属于别的窗口，写一个 `takeoverRequested` 标记（放在租约文件的一个独立键，
     或写一个独立的 `mcp-leader-lease.request.json`——**倾向独立文件**，因为它不改变租约的
     互斥语义，也就不需要额外的原子性）；
  3. 当前主导者在下一个心跳（≤10 秒）看到请求 → 走"自愿让位"：删租约 → 日志 →
     按 follower 运行；
  4. 请求方在下一次 tick 里正常 `claim`（此时文件已被删，走 §4.2 的"文件不存在"分支）。
- 超时兜底：如果 20 秒后租约仍然属于对方（主导者卡住但心跳还在跳），提示用户
  "对方仍在心跳，无法接管"，并给出"关闭那个窗口"的建议。**不要**在心跳新鲜时强行删除文件——
  那会制造真正的双主导者。

---

## 8. 失败模式与降级方向（逐个说明往哪边退化）

**总原则：宁可多轮询，不可静默停止通知。** 任何**不确定**都退化为"照旧轮询"，
只有**确定**地读到"另一个窗口正持有有效租约"时才停止本窗口的轮询与提示。

| 失败                                                           | 行为                                                                                                        | 退化方向                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 租约目录不存在 / 不可写；`open` 返回 `EACCES`/`ENOSPC`/`EROFS` | 整个租约机制停用，本窗口按**全速**轮询（与今天完全一致），日志报一次失败连串                                | **多轮询**（安全）                       |
| 租约文件解析失败 / 字段缺失                                    | 视为过期 → 尝试 claim；claim 也失败则全速轮询                                                               | 多轮询                                   |
| 租约文件被外部删除（用户清理、`globalStorage` 被清）           | 下一 tick 走"文件不存在" → claim                                                                            | 多轮询（谁抢到谁干活）                   |
| 心跳写失败（磁盘满、文件被占用）                               | 记 info；**不**停止自己的轮询（自己仍是主导者的概率更高）；若连续失败超过一个过期周期则主动降级并重走 claim | 可能双轮询；不会无人轮询                 |
| `wx` 在某个文件系统上不原子（网络盘）                          | 可能两个窗口都"成功"→ 靠"每心跳校验 owner"在 10 秒内收敛到一个                                              | 短暂双轮询                               |
| follower 的定时器被节流/休眠                                   | 见 §6：可能导致一段无人轮询的空窗；缓解见 §8.1                                                              | **这是唯一可能"少通知"的方向，必须实测** |
| 主机名/paths 变化（用户移动 profile）                          | 租约文件随之移动，最坏是重新选主                                                                            | 多轮询                                   |
| `instancesFingerprint` 不一致但对面心跳新鲜                    | **不**抢占（§3.3）                                                                                          | 不变                                     |

### 8.1 "少通知"的唯一来源与缓解

唯一可能"少通知"的路径是：**主导者挂了，而所有 follower 都没在 35 秒 + 抖动内跑到 tick**。
缓解措施（按性价比排序）：

1. 把 leader 的 `deactivate()` 让位做可靠（§5 第 1 行）——覆盖绝大多数关闭场景。
2. follower 的退避 tick 用 `setInterval` 而不是"一次性 `setTimeout` 链"
   （链条在一次异常后容易断掉；既有 poller 用的就是 `setInterval`，
   `notificationPoller.ts:161-163`）。
3. 在"最近一次成功轮询距现在 > 2 × 轮询间隔"时，无论租约状态如何都**强制轮询一次**
   （一个"轮询饥饿"看门狗）。它把"所有窗口都以为别人在干活"变成一个可自愈的状态，
   代价是极端情况下可能重复一次请求。**这条建议加进首版**，它是本设计"宁可多轮询"原则
   最直接的体现。
4. 真正的兜底：设置里保留关掉租约的开关（本来就是默认关），并让
   `forgejoToolkit.notificationPollingInterval` 继续有效。

---

## 9. 与首次运行向导、版本探测的关系

- **版本探测**：主导者的探测结果仍然只写在自己的进程内 Map
  （`src/api/serverVersion.ts:66-67`），follower 的窗口**不会**因此获得版本信息 → 那台窗口的
  功能闸门会停在"未知版本、一律放行"（`serverVersion.ts:102-106` 的 fail-open）。这意味着
  **"版本探测也纳入租约"会顺带削弱 follower 窗口的闸门**。两条路：
  1. 只把"低版本提示"的去重纳入租约（主导者负责提示），探测本身每窗口照做；
  2. 让主导者把探测结果写进一个共享文件（例如租约文件的一个 `versions` 字段，或同目录
     `server-versions.json`），follower 启动时读一次。
     **建议先做 1**（改动最小、语义最清楚：避免重复**提示**，探测请求的重复量本来就只有一次/窗口），
     把 2 列为后续（§12.5）。
- **首次运行向导**：它的问题是 read-then-write（`src/welcome.ts:35-48`），本质上与租约
  **同类**但**生命周期完全不同**（一次性标记 vs 持续租约）。**不建议**把它塞进租约协议；
  建议复用同一个原语——用 `fs.open(..., 'wx')` 写一个 `first-run-shown` 标记文件：
  只有创建成功的那个窗口打开向导，其余窗口静默跳过。这比"再设计一套分布式标记"简单得多。
  这一条是可选扩展项（与 §12.6 的"顺带修基线"同属"借用同一个原语"的后续项），不属于租约本体。
- **通知已读基线**：见 §1.2 的反例。如果租约落地，可以让**只有主导者**写
  `forgejoToolkit.seenNotificationIds`（单写者），从而顺带消除那个整表覆盖的缺口；
  follower 仍读它来更新自己的徽标。这是把"单写者"从"省请求"升级为"修正确性"的额外收益，
  但会让 follower 的徽标依赖另一个进程的写入时机，需要单独设计与实测。

---

## 10. 测试能覆盖什么、不能覆盖什么

### 10.1 能自动化（建议作为实现的门槛）

1. **纯决策函数**：`decideLeaseAction(leaseRecord | undefined, now, ownNonce)` →
   `{action: 'claim' | 'follow' | 'renew' | 'step-down'}`。表驱动测试覆盖：无文件、心跳新鲜、
   心跳过期、owner 是自己、解析失败、字段不合法、时钟回拨、时钟前跳。
2. **互斥性（真实 fs）**：在临时目录里用两个 `LeaseStore` 实例（同一进程、不同 nonce）
   并发 `claim()`，断言恰好一个成功。再重复 50 次以抓偶发。
3. **跨进程互斥**：用 `child_process`/`worker_threads` 起 N 个真实进程同时 `claim()`，
   断言恰好一个赢。这是唯一能证明"`wx` 在真实文件系统上原子"的测试。
4. **接管状态机**：用可注入的时钟与 fs 门面，模拟"主导者停止心跳"→"follower 在 35 秒后接管"；
   模拟"旧主导者心跳时发现 owner 变了 → 降级"。既有 poller 测试的写法可复用：
   `vi.useFakeTimers()` + 内存 store（`src/notifications/__tests__/notificationPoller.test.ts:63-101`）。
5. **降级兜底**：让 `open` 抛 `EACCES`，断言窗口**仍然**全速轮询且只记一条失败日志。
6. **饥饿看门狗**（若采纳 §8.1.3）：租约永远读不到时，断言超过 2 × 间隔后会强制轮询一次。

### 10.2 覆盖不到、只能人工实测

- **真实的两个 extension host 进程**行为（VS Code 的激活顺序、`deactivate` 的可靠性、
  窗口关闭时的实际时序）。单测里的"两个 store"是同一进程，跨进程只覆盖到 fs 原语，
  覆盖不到 VS Code 的宿主生命周期。
  可行的人工手段：`tools/ui-review/` 的隔离 dev host 已经用独立的 `--user-data-dir`
  （`tools/ui-review/README.md:88-92`），若两个 dev host 指向**同一个** profile 即可制造
  "两个窗口共享 globalStorage"的真实场景（需要 harness 支持；见 §12.7）。
- **真实睡眠/唤醒**下的计时器节流。
- **用户可感知的"少一次提示"**：这一条只能靠人工观察日志 + 长时间运行积累，见 §11。

### 10.3 不应写的测试

不要写"模拟两个窗口各自 `globalState.update`"来验证租约——那验证的是 **被否决的方案**。
如果实现里出现了任何"用 globalState 抢租约"的代码路径，测试应当直接失败（§12.2 的守卫）。

---

## 11. 发布计划与"什么证据才配默认开启"

### 11.1 阶段

1. **阶段 0（无行为变化）**：只加 `LeaseStore` + 纯决策函数 + 测试，不接入 extension.ts。
2. **阶段 1（影子模式）**：接入但不改变行为——每个窗口照旧轮询，只是**额外**参与选主并打日志
   （"我本可以是主导者 / 我本可以是 follower"）。跑一周，收集"选主是否稳定、有无抖动"。
   这一阶段零风险，也是唯一能证明"抖动不严重"的方式。
3. **阶段 2（默认关闭的开关）**：`forgejoToolkit.multiWindowLease`（默认 `false`）开启后，
   follower 停止轮询与提示。文档化发布（`CHANGELOG` + `KNOWN_ISSUES` 的对应条目更新）。
4. **阶段 3（默认开启）**：仅在 §11.2 的证据齐备后考虑，并且要在
   `KNOWN_ISSUES.md` / `KNOWN_ISSUES.zh.md` 里把"每个窗口各自轮询"改写成
   "默认一个窗口轮询；可在设置中关闭租约"。

### 11.2 转入默认开启需要的证据

- 阶段 1 的影子日志里，**≥ 1 周、≥ 3 个真实多窗口会话**中：选主抖动（10 分钟内 owner 变化）
  为 0；无"机制不可用"记录（除非用户环境真的不可写）。
- 人工实测**关闭主导窗口**后，follower 在下一次 poll 间隔内接管（用命令查询 pid 变化作为证据）。
- 人工实测**强杀**（任务管理器结束该 extension host）后，接管发生在 35–47 秒内。
- 人工实测"轮询饥饿看门狗"路径：人为让所有窗口都不主导，断言 2 × 间隔后有人开始轮询。
- 明确的无回归证据：follower 窗口手动打开通知视图仍能看到最新通知（§5 最后一行）。
- 一个**反证据**也要收：跟随者窗口在"另一个窗口正在轮询"时，其徽标/通知视图是否会在合理时间
  内更新到最新（因为推送路径按窗口独立）。若这里出现明显延迟，代价可能大于收益。

### 11.3 什么证据会推翻整份设计

1. **多窗口轮询的实际开销远低于预期**（例如用户实测"3 个窗口、4 个实例、5 分钟间隔"的额外
   请求量可以忽略）→ 那么正确做法是删掉这个机制，改为文档里建议调大间隔/关轮询
   （`KNOWN_ISSUES.zh.md:214` 已经给出这两条规避方法）。
2. **`wx` 在用户实际使用的 globalStorage 位置上不可靠**（网络 profile、被同步的目录）→
   退回"不选主"；或者只保留"重复提示去重"这一半——那也需要一个共享标记，只是不需要完整的
   租约协议（同一个 `wx` 原语，用一次性的"本实例已提示过"文件即可）。
3. **follower 的"少一次自动提示"被证明是用户可感知的损失** → 那么应当转向
   "每个窗口都轮询、但只让一个窗口弹提示"（保留请求量，去掉噪音），那是另一种设计。
4. **VS Code 未来提供官方的主窗口/多窗口 API**（例如某处暴露 active window 或跨窗口事件）
   → 优先用平台能力，删掉自建租约。

---

## 12. 留给维护者的开放问题

1. **默认值**：`multiWindowLease` 起手默认 `false` 是否可接受？还是希望直接默认开启并接受
   §11.2 之前没有证据？（本文建议 `false` + 阶段 1 影子模式。）
2. **是否禁止 `globalState` 参与选主**？本文主张"租约只用 `wx` 文件"，如果维护者认为
   `globalState` 可接受（例如为了少一个文件），需要重写 §3、§4，并承担 §1.2 的竞态。
3. **状态栏入口**：要不要一个常驻状态栏项显示"本窗口在轮询"？本文倾向不做（噪音），
   但"机制降级为全速轮询"时是否要给一次性提示？
4. **单窗口场景的优化**：只有一个窗口时，是否可以跳过整个租约流程直接轮询（少一个 claim
   往返）？"窗口数"在 VS Code 里没有官方 API，只能用租约文件本身推断——这会让逻辑变复杂。
   是否值得？
5. **版本探测结果是否共享**（§9 的路线 2）？如果做，共享文件放哪、谁负责写入、follower
   读到旧值时闸门怎么表现？
6. **顺带修 `seenNotificationIds` 的整表覆盖**（§1.2 反例 / §9）是否纳入同批？它属于"同类
   基础设施缺陷"，但会改动通知语义（谁写、谁读、徽标何时更新），风险高于租约本体。
   本文建议**单独立项**。
7. **harness 支持**：`tools/ui-review/` 目前每次 launch 用独立 `--user-data-dir`
   （`tools/ui-review/README.md:88-92`）。要不要加一个"共享 profile 的双窗口"模式，
   让多窗口场景可以走查？否则 §10.2 / §11.2 的人工验证会很别扭。
8. **强制接管的语义**：用户点"强制接管"时，是否应当**立即**轮询一次再走正常流程
   （用户体验更好，但会在租约未定时产生额外请求）？

---

## 13. 事实核对清单

| 断言                                              | 位置                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 激活事件按窗口生效                                | `packages/forgejo-toolkit/package.json:342-347`                                                 |
| 每个窗口都探测版本                                | `packages/forgejo-toolkit/src/extension.ts:96-98`                                               |
| 版本缓存在进程内 Map                              | `packages/forgejo-toolkit/src/api/serverVersion.ts:66-67`                                       |
| 版本过低提示                                      | `packages/forgejo-toolkit/src/api/versionProbe.ts:40-42`                                        |
| 该提示的去重集是进程内的                          | `packages/forgejo-toolkit/src/api/vscodeClientHost.ts:13-15`                                    |
| 每个窗口都启动通知轮询                            | `packages/forgejo-toolkit/src/extension.ts:124-126`                                             |
| 轮询用 `setInterval`                              | `packages/forgejo-toolkit/src/notifications/notificationPoller.ts:155-164`                      |
| 每实例并发一次请求                                | `packages/forgejo-toolkit/src/notifications/notificationPoller.ts:229-241`                      |
| 每窗口各自弹聚合提示                              | `packages/forgejo-toolkit/src/notifications/notificationPoller.ts:456-484`                      |
| 轮询间隔常量与钳制                                | `packages/forgejo-toolkit/src/config.ts:15-17`、`:425-433`                                      |
| 轮询设置项与范围                                  | `packages/forgejo-toolkit/package.json:113-124`                                                 |
| 轮询开关的读取                                    | `packages/forgejo-toolkit/src/config.ts:421-423`                                                |
| 首次运行标记是 read-then-write                    | `packages/forgejo-toolkit/src/welcome.ts:35-48`                                                 |
| 首次运行挂载点                                    | `packages/forgejo-toolkit/src/extension.ts:104-108`                                             |
| 已读基线是整表覆盖                                | `packages/forgejo-toolkit/src/notifications/notificationPoller.ts:412-433`                      |
| 首轮无基线时的抑制分支                            | `packages/forgejo-toolkit/src/notifications/notificationPoller.ts:416-420`                      |
| `globalState` 无跨窗口变更事件                    | `packages/forgejo-toolkit/src/config.ts:351-358`                                                |
| 实例列表写回是"紧邻重读 + 合并"，且自认非原子     | `packages/forgejo-toolkit/src/config.ts:366-383`                                                |
| worktree 写回同样重读，并写明队列只序列化本宿主   | `packages/forgejo-toolkit/src/worktree/worktreeManager.ts:193-204`                              |
| 原子写实现（`.part` + rename + fsync + 保权限位） | `packages/forgejo-toolkit/src/utils/atomicWrite.ts:33-65`                                       |
| 队列/串行化既有先例                               | `packages/forgejo-toolkit/src/worktree/worktreeManager.ts:42-50`                                |
| globalStorage 里已有的固定名文件与权限约定        | `packages/forgejo-toolkit/src/mcpWorkspaceState.ts:59-75`、`src/mcpBroker.ts:42-44`、`:190-199` |
| "第一个窗口赢"的既有原子原语（broker 绑定）       | `packages/forgejo-toolkit/src/mcpBroker.ts:122-131`、`:163-174`                                 |
| 陈旧 socket 的"探测再接管"先例                    | `packages/forgejo-toolkit/mcp/brokerServer.ts:418-452`                                          |
| 所有权判断后才删除（避免删掉继任者文件）          | `packages/forgejo-toolkit/src/mcpBroker.ts:344-368`                                             |
| 陈旧状态文件的 pid 存活探测先例                   | `packages/forgejo-toolkit/src/mcpWorkspaceState.ts:292-337`                                     |
| 单测里可共享的内存 `globalState` + fake timers    | `packages/forgejo-toolkit/src/notifications/__tests__/notificationPoller.test.ts:63-101`        |
| `deactivate()` 的位置                             | `packages/forgejo-toolkit/src/extension.ts:170-178`                                             |
| dev host 用独立 `--user-data-dir`                 | `tools/ui-review/README.md:88-92`                                                               |
| 平台代价与规避方法的既有记录                      | `KNOWN_ISSUES.md:210-214`、`KNOWN_ISSUES.zh.md:210-214`                                         |
| P4 条目与"可选方向：globalState 时间戳租约"       | `TODO.md:22`                                                                                    |
