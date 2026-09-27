# 多窗口「一个窗口主导」租约（polling lease）

- 状态：**设计（未实现）**，默认关闭，落地前需维护者裁决 §12 的开放问题
- 关联：`TODO.md` 的 P4 条目（「多窗口轮询租约」）、`KNOWN_ISSUES.md` 的
  "Every window polls and probes each instance on its own"（及 `KNOWN_ISSUES.zh.md` 对应条目）、
  `ROADMAP.md` 的「多窗口通知基线合并」（已交付，它修掉的正是本文初版误判为缺口的那个竞态）
- 基线代码：HEAD `c5118a6`，行号按**当前工作树**核对（本次逐条重核，见 §13）

> 工作树里可能有其他 agent 的在途改动，行号会漂移，所以每条断言都同时给出**可搜索的标识符 /
> 代码片段**；以标识符为准，行号只用于加速定位。核对清单见 §13。
>
> 本次修订（2026-09-27）的背景：broker 的窗口间自动交接已交付并端到端实测（§3.5），
> 且仓库里已经有一套"改动前先量"的实测习惯。本文按同一标准重核：**改对了 3 处事实错误、
> 新增 1 处只有实测才暴露的 Windows 行为，并把可复用的实测数字折进 §5 / §10.2 / §11.2。**

---

## 1. 问题

### 1.1 现状：每个窗口各跑一份

`onStartupFinished` 是**按窗口**生效的激活事件（`packages/forgejo-toolkit/package.json:344-349`
的 `activationEvents`，除它以外还有三条 `onFileSystem:` / `onView:` 事件），而它存在的原因是 MCP
服务器需要可发现性（`TODO.md:45` 与 `TODO.md:21` 记录了这一平台代价）。于是激活路径上三件
"应该全机器只做一次"的事，每个窗口都做了一次：

1. **版本探测**：`src/extension.ts:96-98` 对每个实例各 `void probeServerVersion(...)`。
   探测结果写进**进程内**的 Map（`src/api/serverVersion.ts:65-67` 的 `serverVersions`），
   所以窗口之间不共享，10 个窗口就是 10 倍请求。
   `src/api/versionProbe.ts:40-42` 在版本过低时会 `notifyUnsupportedInstance`，而那条提示的去重集
   也是进程内的（`src/api/vscodeClientHost.ts:13-15` 的 `shownUnsupportedVersionUrls`，
   去重判断在 `vscodeClientHost.ts:182-186`）——**同一个"版本过低"警告会每窗口弹一次**。
2. **通知轮询**：`src/extension.ts:124-126` 构造并启动 `NotificationPoller`。轮询节奏见
   `src/notifications/notificationPoller.ts:188-197`（`_scheduleAll` 里的 `setInterval`，间隔
   `getNotificationPollingInterval() * 1000` 毫秒），配置范围 60–3600 秒、默认 300 秒
   （`src/config.ts:15-17` 的常量、`config.ts:425-433` 的钳制、
   `packages/forgejo-toolkit/package.json:119-125` 的设置项）。
   一轮里对每个实例并发发一次请求（`notificationPoller.ts:263-274` 的 `Promise.all`）。
   **每个窗口都会为新通知弹一次聚合提示**（`notificationPoller.ts:546-574` 的
   `_showAggregatedNotification`）。
3. **首次运行向导标记**：`src/extension.ts:104-108` 调 `maybeShowWelcomeOnboarding`，其实现是
   典型的 read-then-write（`src/welcome.ts:35-48`）；`KNOWN_ISSUES.zh.md:212` 已经如实记录了
   "同时恢复的多个窗口可能各自打开一次该面板"。

### 1.2 现状：`globalState` 的跨窗口语义（必须诚实的部分）

- `globalState` 没有跨窗口变更事件。仓库自己在两处写明了这一点：
  `src/config.ts:351-358`（"globalState 没有跨窗口变更事件，所以另一个窗口可能已更新列表"）与
  `notificationPoller.ts:494-509`（`_mergeBaselineForWrite` 的说明：存储的 map 与每个窗口共享，
  且 `get`→`update` 不是原子的）。
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
  - 通知已读基线：同样是"重读 + 只覆盖本窗口拥有的条目"的合并写
    （`notificationPoller.ts:430-492` 的 `_reconcileSeenIds`、
    `notificationPoller.ts:514-533` 的 `_mergeBaselineForWrite`，写入点在 `:464-469`、
    以及 `:522-525` 的"本窗口未落盘条目优先"覆盖）。

> **一处必须纠正的旧判断。** 本文初版把通知已读基线列为"整表覆盖"的真实缺口，并据此在
> §9/§12.6 提出"顺带修基线"的后续项。**这条已经过时且当时就是错的**：那个竞态在本文初版
> 之前就已由 `9a041b0`（"let the extension activate, settle every state write, and keep two
> windows' baselines"）修掉，`ROADMAP.md:195` 也把它记在了「已完成」里。现在写入的数据源是
> `_getAllSeenIds()` **在队列内**读回的那一份（`notificationPoller.ts:447-451`），本窗口只覆盖
> 自己拥有的条目，删除还要求"配置里没有了 **且** 本窗口拥有"（`notificationPoller.ts:526-531`）。
> 那个"少一次提示"的场景已不成立，§9 与 §12.6 相应改写。

### 1.3 结论

需要一个"一个窗口主导"的机制，让**全机器只有一份**轮询与探测，同时**不允许**任何失败模式
导致"没人轮询"。

注意本文的范围边界：租约决定的是**谁发请求、谁弹提示**。它**不**决定窗口能否看到通知——
follower 窗口手动打开通知视图仍走宿主与 webview 的正常消息路径（§5 最后一行、§11.2 的"无回归证据"一条）。
"同类问题的先行实现"（broker 的窗口间交接）见 §3.5，那里也说明为什么它**不能**直接替本文的
抢占协议背书。

---

## 2. 决策（摘要）

1. **租约放在文件里，不放 `globalState`。** 位置：扩展的 `globalStorageUri` 目录下的固定名
   `mcp-leader-lease.json`（与既有的 `mcp-broker.json` / `mcp-instances.json` 同目录、
   同一套权限约定，见 `src/mcpWorkspaceState.ts:59-75`、`src/mcpBroker.ts:42-49`、
   `src/mcpBroker.ts:270-272`）。
   理由见 §3：`globalState` 的读改写不原子，而 `fs.open(path, 'wx')` 在同机同文件系统上是
   **真正的互斥**（内核把"不存在则创建"实现为一次原子检查并创建），这把"抢占"从概率问题变成
   确定问题。
2. **心跳 10 秒，过期 35 秒**（3 个心跳），与轮询间隔（≥ 60 秒）解耦。
3. **`deactivate()` 主动让位**（删租约文件），崩溃/强杀则靠过期超时接管；接管竞争由
   `wx` 文件创建裁决，输家继续当 follower。
4. **follower 不会静默停止轮询**：follower 仍持有一个退避计时器，租约不可用时按
   全速轮询兜底。宁可多轮询，绝不少通知。
5. **主导者可见**：日志 + 一个命令/状态栏入口可以告诉用户"哪个窗口在轮询"，并提供
   "本窗口强制接管"。
6. **默认关闭**，通过设置项 `forgejoToolkit.multiWindowLease` 开启（先例：
   `packages/forgejo-toolkit/package.json:114-125` 的两个轮询设置），并要求 §11 的证据才转默认开启。

---

## 3. 租约在哪里、长什么样

### 3.1 位置与权限

- 路径：`path.join(context.globalStorageUri.fsPath, 'mcp-leader-lease.json')`。
- 目录按既有约定收紧到 `0700`，文件 `0600`：先例 `src/mcpBroker.ts:270-272`
  （`mkdir(mode 0o700)` + `chmod` + `writeFileAtomically(..., { mode: 0o600 })`）。
  **注意这两项在 Windows 上基本是空操作**：Node 的 `mode` 只映射到 POSIX 位，
  Windows 上的实际访问控制来自目录 ACL（`%APPDATA%` 下的用户目录默认只有本人可读）。
  权限承诺要按平台分别陈述，不要写成"跨平台 0600 强制生效"。
- **`wx` 是本设计唯一的原子原语，而它不是仓库里的 `writeFileAtomically`。**
  `src/utils/atomicWrite.ts:33-65` 的实现是"写 `<target>.part` → `fsync` → `rename` 覆盖"，
  它**不创建目标文件**，因此**任何窗口都能调用它**（`fs.rename` 对已存在的目标是无条件替换，
  见该文件 `:60`）。两者分工必须写清：
  - **互斥创建**（`claim()`）：只能用 `fs.promises.open(leasePath, 'wx', 0o600)`；
  - **心跳刷新**（已是 owner）：可以用 `writeFileAtomically`，它不会重新创建文件，
    因此不会破坏互斥语义，并且会保留既有权限位（`atomicWrite.ts:50-58` 先 `stat` 目标、
    把目标 mode 复制到 `.part`）。
- **为什么不用 `globalState`**：见 §1.2。另外 `globalState` 是编辑器的状态库，用户清缓存
  （Profile / "清除工作区状态"）会让租约莫名消失——那其实是**安全**的失败方向（会退化成
  全速轮询），但会让"为什么突然又多轮询了"难以解释。文件在 globalStorage 里语义更直白，
  而且已有三个同目录文件的先例。
- **不把 `mcp-broker.json` 复用为选主器**：broker 确实是"全机器唯一的管道监听者"，
  也确实是强互斥（`src/mcpBroker.ts:230-247`，`EADDRINUSE` 让位），但 (a) broker 只在一个
  窗口里跑，意图是"提供 MCP 转发"，不是"代表轮询"；(b) broker 的注册表在
  `docs/architecture/mcp-server.md:265-273` 描述的语义下是"描述一个活着的监听器"，
  把轮询主导权塞进它会同时改两个子系统的语义。**保持两件事分开**——但它的 pid 存活判定与
  定时器生命周期可以直接借鉴（§3.5）。

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
外泄地址）。`pid + ownerNonce` 的组合与 `mcpWorkspaceState.ts:41-48` 的
"pid + per-window nonce" 是同一个理由：pid 会被回收。

### 3.3 实例集合变化的处理

- 租约里记一个实例集合指纹。**指纹变化不触发重新选主**：主导者在下一次心跳时把指纹更新到
  最新即可（它的职责是"代表本机轮询所有已配置实例"，实例增删由本窗口的
  `config.onInstancesChanged` 驱动，`notificationPoller.ts:137-147` 已经在监听）。
- follower 发现指纹不同**不** takeover。理由：两个窗口共享同一份
  `forgejoToolkit.instances`（`src/config.ts:13` 的 `INSTANCES_KEY`），指纹不同的窗口期通常只是
  "另一个窗口刚写完而我还没重读"。为它触发选主只会制造抖动。
- 如果实现时发现"多窗口实例列表长时间不一致"是真实问题（例如导入后另一个窗口一直没刷新），
  那属于 `globalState` 没有变更事件这一既有缺陷，应当按 §12.2 的边界单独立项（它超出了本文
  的"轮询主导权"范围）。

### 3.4 候选方案对比（为什么不用别的）

| 方案                                                               | 结论                 | 理由                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `globalState` 读改写 + 时间戳                                      | **不采用为唯一机制** | 竞态真实存在，见 §1.2。仓库自己的注释也这么说（`config.ts:351-358`）。                                                                                                                                                                           |
| `globalState` 两阶段"写候选 → 等一个 settle 期 → 重读确认自己还在" | 不采用               | 概率性、需要引入魔法延时，而且在"重读时看到的是我还是别人"上仍依赖写入落盘顺序。                                                                                                                                                                 |
| 复用 broker 的命名管道/Unix socket 绑定当互斥                      | **不作为选主器**     | 它确实原子（`src/mcpBroker.ts:230-247`），但 broker 只有"扩展宿主需要转发 MCP"时才启动，且默认路径就是"第一个窗口赢"——把轮询主导权绑上去会让"关掉 MCP 前端"意外改变轮询拓扑。**借鉴它的 pid 存活判定与定时器写法（§3.5），不绑定它的生命周期。** |
| 用 `wx` 独占创建文件                                               | **采用**             | 同机同文件系统上"不存在则创建"由内核裁决；失败即 `EEXIST`，语义清晰。见 §3.1 的分工说明。                                                                                                                                                        |
| 用 `LockFile` 类库 / `flock`                                       | 不采用               | Node 无跨平台的 `flock`；引依赖违背"能不加就不加"的既有取向。                                                                                                                                                                                    |

### 3.5 同类问题的先行实现：broker 的窗口间自动交接

先交付的是**近亲问题**，不是同一个问题：broker 需要"全机唯一的监听者"。它的实现
（`src/mcpBroker.ts`，架构描述见 `docs/architecture/mcp-server.md:304-330`，
用户可见行为见 `KNOWN_ISSUES.zh.md:228-234`）与本文的关系要精确切开——

**可以直接借鉴（且已被实测证明够用）的部分：**

- **注册文件 + pid 存活探测**：让位窗口每次 tick 读固定的注册文件，用
  `process.kill(pid, 0)` 判断持有者还在不在；`EPERM` 计为"活着"
  （`mcpBroker.ts:413-420` 的 `isProcessAlive`、`:430-448` 的
  `brokerRegistrationOwnerIsAlive`）。这与 `mcpWorkspaceState.ts:287-297` 的
  `isPidAlive` 是同一规则，两处刻意重复（注释说明了理由）。**"文件消失"与"文件在但 pid 死了"
  都要视为可接管**——本文 §5 的两个场景正好对应这两条。
- **5 秒轮询 + 生命周期收口**：`BROKER_TAKEOVER_POLL_MS = 5_000`（导出，`:88`）、
  `setInterval` + `timer.unref()`（`:338-348`）、单飞守卫防重入（`:366-371`）、
  `cleanupMcpBroker()` 先清定时器再等 in-flight 尝试（`:589-604`）。
  **定时器必须 `unref()` 且随停用/关闭设置清理**，否则一个已经让位的窗口会被一个恢复用定时器
  留在进程里。
- **健康时保持沉默**：持有者健在时，让位窗口一个 tick 只做"读文件 + 探 pid"，**不写日志**
  （`:373-375`）。实测：持有者健在的 20 秒内注册文件零变化、看门狗零日志（`TODO.md:9`）。
  本文 §7.1 的"follower 只在状态变化时写日志"就是抄这一条。
- **"接管 = 走一遍正常启动路径"**：接管成功后的注册内容与首次绑定**没有区别**——自己的活 pid、
  重新生成的 per-launch 密钥、同一条 info 日志（`mcpBroker.ts:210-284` 的
  `attemptMcpBrokerStart`）。这样客户端侧不需要知道发生过交接。本文的接管也应如此：
  新主导者不做任何特殊标记。
- **失败不重试**：非 `EADDRINUSE` 的失败（`EACCES`）记一次 info、**不启动看门狗**
  （`mcpBroker.ts:236-247`）；接管时"能拿到端点但写不出注册"则**停止看门狗**，
  因为每 5 秒重复一次注定失败的写只会重复同一条日志（`:379-383`）。

**不能借鉴、必须自己论证的部分：**

- **仲裁者不同。** broker 的互斥是**内核仲裁的资源**：多个窗口一起 `listen`，恰好一个成功，
  其余拿到 `EADDRINUSE` 并继续等待——所以它**刻意没有文件锁、没有选举协议**，
  连"误判持有者已死"都只值一次失败的 `listen`（`mcpBroker.ts:301-306` 的原话）。
  **租约文件不是这种资源。** 两个窗口同时 `wx` 创建租约，同样只有一个成功，
  但"陈旧租约会永久挡住接管"这件事内核不管：没有 `listen` 这样的二次仲裁替我们兜底。
  因此本文的抢占协议（§4：只读过期才 `unlink`、**绝不在 `EEXIST` 后立刻 `unlink` 重试**、
  follower 的抖动区间）**仍然需要自己的论证与测试**，不能拿 broker 的先例把 §4 一笔带过。
- **代价不同。** broker 交接失败的代价是"这一个 MCP 会话结束"（实测 31 ms 内以一行 info
  退出，退出码 0，见 §11.2）；租约交接失败的代价是"一段时间内没人轮询"。
  两者都不可怕，但不能互相替代论证。
- **失效信号不同。** broker 的持有者死亡会被转发方**立刻**看到（socket 断开）；
  租约的持有者死亡只能靠**心跳超时**推断，所以 §6 的时钟讨论在这里才有意义，在 broker 那里没有。

---

## 4. 抢占协议（claim）

### 4.1 当前主导者的心跳

主导者每 **10 秒**：

1. 读租约文件。
2. 若 `ownerNonce` 不是自己（说明有人接管过：时钟跳变、手工接管、旧进程残留）→ **主动降级**为
   follower，打日志，停掉自己的轮询。
3. 否则用"原子写 + rename"（`writeFileAtomically`，`src/utils/atomicWrite.ts:33`）把
   `heartbeatAt` 刷成 `Date.now()`，并顺带更新指纹。

**心跳写失败必须有除"降级"以外的中间档。** 这是本次修订新增的一条，理由是实测发现
Windows 上"目标文件被任何进程以读句柄打开"会让 `fs.rename` 失败并返回 `EPERM`
（§13 的实测条目；同一目录内"读一下再 rename"的 1771 次竞态里 `EPERM` 为 0，
但只要读句柄在 rename 那一刻还开着就必然 `EPERM`，关掉后立刻重试即可成功）。
`EPERM`/`EBUSY` 因此既可能是"磁盘/占用问题"，也可能是"恰好有人在读"，
**不能一次失败就降级**（那会制造一段无人轮询的空窗）。建议：短重试（例如 3 次、间隔数百毫秒）
后再判定失败，并把"心跳连续失败"的降级阈值定得明显长于一个过期周期（§8 的失败表已按此改写）。

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
5. **陈旧 `.part` 不构成障碍**（实测）：`writeFileAtomically` 崩溃后留下的
   `mcp-leader-lease.json.part` 与 `wx` 创建的目标名不同名，因此不影响后继 `claim`；
   它会在下一次心跳时被覆盖，或作为无主文件留在目录里（无害，但可以在接管时顺手清掉）。

### 4.3 为什么这个协议是确定的

- 同机同文件系统上，`wx` 创建由内核裁决，**恰好一个**调用成功。这是唯一需要的原子原语。
- 抢占不依赖时间戳正确：时间戳只用于"是否过期"的判断，而"谁赢"由 `wx` 决定。
  即便两个窗口的时钟都错了（比如手工改表），最坏结果是**假过期**引发一次接管，
  而原主导者在下一个心跳（≤10 秒）发现自己不是 owner 就降级（§4.1.2）——**撤销一次抖动最多
  10 秒**，不会长期出现两个主导者。
- **这条收敛依赖"旧主导者还能写出/读到租约文件"**：它的降级判断来自"读到的 `ownerNonce`
  不是自己"。若接管者把文件删掉重建，旧主导者读到的是新内容（nonce 不同）→ 正常降级；
  若文件一度不可读，它必须**保持现状而不是自认 owner**（读失败不等于"我还是 owner"，
  也**不等于**"我可以继续轮询"）。
- 网络文件系统 / 云同步目录是例外：`wx` 的语义在那里可能不可靠。这属于 §8 的"机制不可用"
  分支，退化为全速轮询。

---

## 5. 被主导者关闭时会发生什么（逐场景）

| 场景                                                       | 行为                                                                                                                                                                                                                               | 用户可感知的后果                                                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **正常关闭**（`deactivate()`）                             | 在 `src/extension.ts:170-178` 的 `deactivate` 里（与 `cleanupMcpBroker` 同处）删掉自己拥有的租约文件；**只有 `ownerNonce` 是自己的才删**，避免删掉继任者的文件（同 `cleanupMcpBroker` 的所有权判断，`src/mcpBroker.ts:589-617`）。 | follower 的下一次 tick（≤12 秒，抖动上限）就能 `claim`。**唯一需要 `deactivate` 可靠执行**；注意 VS Code 不保证 `deactivate` 被 await 到结束（`mcpBroker.ts:56-62` 的 in-flight 等待就是为这个不确定写 的防御），所以删除失败也不影响正确性，只是慢 35 秒。 |
| **崩溃 / 强杀 / 断电**                                     | 租约文件留着，`heartbeatAt` 不再刷新。35 秒后过期，第一个 tick 到的 follower 抢走。                                                                                                                                                | 最长 47 秒（35 + 12 抖动）的轮询空窗。**这是本设计的核心权衡**：这段时间内没有新通知提示；用户看到的只是"晚一点弹"。**类比实测见 §11.2。**                                                                                                                  |
| **两个 follower 同时抢**                                   | `wx` 只有一个赢；输家 `EEXIST` → 重读 → follower。                                                                                                                                                                                 | 无。                                                                                                                                                                                                                                                        |
| **三个以上窗口**                                           | 同上，与窗口数无关。                                                                                                                                                                                                               | 无。                                                                                                                                                                                                                                                        |
| **租约无人认领**（文件不存在）                             | 每个窗口都进入 §4.2 的 claim 分支；赢家立刻开始轮询，输家等下一个 tick 再评估。                                                                                                                                                    | 最多 12 秒（抖动上限）后才有人开始轮询，且这段时间**没有**服务器请求。这是有意的：比"每个窗口都在猜"更省，也比"太久没人轮询"更短。若要更保守，可以让窗口数 > 1 时立即 claim（§12.4）。                                                                      |
| **时间戳过期但主导者其实活着**（时钟跳变、挂起唤醒）       | 新窗口接管；旧主导者下一个心跳（≤10 秒）发现 `ownerNonce` 变了 → 降级。                                                                                                                                                            | 最多 10 秒的双主导者窗口，期间可能多一次请求与一次重复提示。可接受。                                                                                                                                                                                        |
| **主导者心跳写失败但进程仍在**（Windows 上被读句柄占住等） | 见 §4.1：短重试 → 仍失败则继续轮询（它仍是主导者的概率更高），超阈值才降级。                                                                                                                                                       | 可能短暂双轮询；不会无人轮询。                                                                                                                                                                                                                              |
| **follower 在等租约时用户点开通知视图**                    | 视图的数据来自 `getNotifications` 命令（宿主与 webview 的正常消息路径），与轮询是两条路；follower 的窗口仍能手动刷新看到通知。                                                                                                     | 不丢功能，只少"自动提示"。落地时必须**实测确认**这一点（§11.2 的"无回归证据"一条）。                                                                                                                                                                        |

> **近亲问题的实测（可作预期，但不是本设计的证据）。** broker 的同类场景已端到端测过
> （`TODO.md:9`、`KNOWN_ISSUES.zh.md:230-234`）：两个窗口共享同一 profile，持有者被硬杀后
> **1,400 ms** 完成接管（另一次交接 **124 ms**），新持有者用自己的活 pid 与新的 per-launch
> 密钥重新注册，之后启动的客户端 **4/4** 认证通过，全程**不重载、不改设置**。
> 差别在于 broker 的探测周期是 5 秒且没有"过期"概念（pid 一死即可接管），
> 所以 1,400 ms 不能直接当作"租约接管也是秒级"的证据——租约的乐观情形是"`deactivate` 可靠"
> （≤12 秒），悲观情形是"崩溃"（35–47 秒）。

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
  单进程内的计时（心跳间隔、抖动）用 `setTimeout` / `setInterval` 就够，不需要额外时钟。

---

## 7. 主导者如何被用户看见，以及如何强制接管

### 7.1 可见性

- **日志**：主导者启动/接管/降级各写一条 info，内容含 `pid`、`ownerNonce` 前 8 位、
  触发原因（`claimed` / `takeover-expired` / `stepped-down-owner-changed` / `lease-unavailable`）。
  follower 只在**状态变化**时写（避免每 10 秒刷屏）——这正是 broker 看门狗的做法，
  它健在时实测**零日志**（§3.5、`TODO.md:9`）；轮询本身已有
  `notificationPoller.ts:309` 的 debug 行可对照。
- **一个查询入口**：加命令 `forgejoToolkit.showPollingLeader`（或用既有的
  `forgejoToolkit.showLog`，`packages/forgejo-toolkit/package.json:182-183`），读租约文件并展示
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
- 先例可参考的用户动作：broker 侧的等价物是"重载窗口，或把 `forgejoToolkit.mcpEnabled`
  关掉再打开"（`KNOWN_ISSUES.zh.md:234`）。本命令的目标是**不**需要这类绕路。

---

## 8. 失败模式与降级方向（逐个说明往哪边退化）

**总原则：宁可多轮询，不可静默停止通知。** 任何**不确定**都退化为"照旧轮询"，
只有**确定**地读到"另一个窗口正持有有效租约"时才停止本窗口的轮询与提示。

| 失败                                                                 | 行为                                                                                                                                                 | 退化方向                                 |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 租约目录不存在 / 不可写；`open` 返回 `EACCES`/`ENOSPC`/`EROFS`       | 整个租约机制停用，本窗口按**全速**轮询（与今天完全一致），日志报一次失败连串                                                                         | **多轮询**（安全）                       |
| 租约文件解析失败 / 字段缺失                                          | 视为过期 → 尝试 claim；claim 也失败则全速轮询                                                                                                        | 多轮询                                   |
| 租约文件被外部删除（用户清理、`globalStorage` 被清）                 | 下一 tick 走"文件不存在" → claim                                                                                                                     | 多轮询（谁抢到谁干活）                   |
| 心跳写失败（`EPERM`/`EBUSY`/磁盘满）                                 | **先短重试**（见 §4.1）；仍失败则记 info，**不**停止自己的轮询（自己仍是主导者的概率更高）；只在连续失败明显超过一个过期周期后才主动降级并重走 claim | 可能双轮询；不会无人轮询                 |
| `wx` 在某个文件系统上不原子（网络盘）                                | 可能两个窗口都"成功"→ 靠"每心跳校验 owner"在 10 秒内收敛到一个                                                                                       | 短暂双轮询                               |
| follower 的定时器被节流/休眠                                         | 见 §6：可能导致一段无人轮询的空窗；缓解见 §8.1                                                                                                       | **这是唯一可能"少通知"的方向，必须实测** |
| 主机名/paths 变化（用户移动 profile）                                | 租约文件随之移动，最坏是重新选主                                                                                                                     | 多轮询                                   |
| `instancesFingerprint` 不一致但对面心跳新鲜                          | **不**抢占（§3.3）                                                                                                                                   | 不变                                     |
| 平台差异：Windows 上"目标被读句柄打开时 rename 失败"（实测，见 §13） | 归类为"心跳写失败"的多重试路径，**不**是"机制不可用"                                                                                                 | 短暂心跳变旧；治理见 §4.1                |

### 8.1 "少通知"的唯一来源与缓解

唯一可能"少通知"的路径是：**主导者挂了，而所有 follower 都没在 35 秒 + 抖动内跑到 tick**。
缓解措施（按性价比排序）：

1. 把 leader 的 `deactivate()` 让位做可靠（§5 第 1 行）——覆盖绝大多数关闭场景。
2. follower 的退避 tick 用 `setInterval` 而不是"一次性 `setTimeout` 链"
   （链条在一次异常后容易断掉；既有 poller 用的就是 `setInterval`，
   `notificationPoller.ts:194-196`；broker 看门狗同样用 `setInterval` + `unref()`，
   `mcpBroker.ts:338-348`）。
3. 在"最近一次成功轮询距现在 > 2 × 轮询间隔"时，无论租约状态如何都**强制轮询一次**
   （一个"轮询饥饿"看门狗）。它把"所有窗口都以为别人在干活"变成一个可自愈的状态，
   代价是极端情况下可能重复一次请求。**这条建议加进首版**，它是本设计"宁可多轮询"原则
   最直接的体现。
4. 真正的兜底：设置里保留关掉租约的开关（本来就是默认关），并让
   `forgejoToolkit.notificationPollingInterval` 继续有效。

---

## 9. 与首次运行向导、版本探测的关系

- **版本探测**：主导者的探测结果仍然只写在自己的进程内 Map
  （`src/api/serverVersion.ts:65-67` 的 `serverVersions`），follower 的窗口**不会**因此获得
  版本信息 → 那台窗口的功能闸门会停在"未知版本、一律放行"
  （`serverVersion.ts:54-63` 的 `isVersionSupported` 对 `undefined`/不可解析都返回 `true`）。
  这意味着 **"版本探测也纳入租约"会顺带削弱 follower 窗口的闸门**。两条路：
  1. 只把"低版本提示"的去重纳入租约（主导者负责提示），探测本身每窗口照做；
  2. 让主导者把探测结果写进一个共享文件（例如租约文件的一个 `versions` 字段，或同目录
     `server-versions.json`），follower 启动时读一次。
     **建议先做 1**（改动最小、语义最清楚：避免重复**提示**，探测请求的重复量本来就只有一次/窗口），
     把 2 列为后续（§12.5）。
- **首次运行向导**：它的问题是 read-then-write（`src/welcome.ts:35-48`），本质上与租约
  **同类**但**生命周期完全不同**（一次性标记 vs 持续租约）。**不建议**把它塞进租约协议；
  建议复用同一个原语——用 `fs.open(..., 'wx')` 写一个 `first-run-shown` 标记文件：
  只有创建成功的那个窗口打开向导，其余窗口静默跳过。这比"再设计一套分布式标记"简单得多。
  这一条是可选扩展项，不属于租约本体。
- **通知已读基线**：**这条已在 `9a041b0` 交付**，不再是本文的后续项。
  `_reconcileSeenIds` 现在是"队列内重读 + 只覆盖本窗口拥有的条目"的合并写
  （`notificationPoller.ts:430-492`），`ROADMAP.md:195` 记录了它
  （"窗口之间不再互相清空基线"）。**租约落地后它仍然成立**：多个窗口可以各自写自己的条目，
  租约只减少**请求与提示**的重复，不改变基线的所有权规则。本文初版把它写成"顺带修正确性"
  的收益，是错的——它已经是对的，**不要**把"只有主导者写基线"混进来，那会破坏现有的
  所有权规则（一个 follower 窗口观察到的新通知将无人记录）。

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
   模拟"旧主导者心跳时发现 owner 变了 → 降级"。既有测试的写法可复用：
   `vi.useFakeTimers()` + 内存 store（`src/notifications/__tests__/notificationPoller.test.ts:63-96`，
   其中 `createFakeContext` 在 `:63-73`）；broker 侧的同类测试可直接照搬结构
   （`src/__tests__/mcpBroker.test.ts:399-630`：清理后接管、被杀后靠死 pid 接管、
   持有者健在时保持让位、两个让位窗口竞争只有一个赢、`unref` 断言）。
5. **降级兜底**：让 `open` 抛 `EACCES`，断言窗口**仍然**全速轮询且只记一条失败日志。
6. **饥饿看门狗**（若采纳 §8.1.3）：租约永远读不到时，断言超过 2 × 间隔后会强制轮询一次。
7. **心跳的 `EPERM` 路径**（本次新增，因为实测确认它是可达的）：注入一个"rename 抛
   `EPERM` 一次随后成功"的 fs 门面，断言**先重试、不降级**；再注入"持续 `EPERM`"，
   断言超过阈值后才降级，且降级期间本窗口没有停止轮询。

### 10.2 覆盖不到、只能人工实测

- **真实的两个 extension host 进程**行为（VS Code 的激活顺序、`deactivate` 的可靠性、
  窗口关闭时的实际时序）。单测里的"两个 store"是同一进程，跨进程只覆盖到 fs 原语，
  覆盖不到 VS Code 的宿主生命周期。
  **harness 手法（本次实测确认，值得记录）：**
  - 同一个 profile 的**第二个窗口**用运行中实例内的 **Ctrl+Shift+N** 打开；
    `code --new-window <folder>` 对同一 profile **只是把已有窗口带到前台**
    （实测无效，不要再试这条路）。
  - 杀掉**某个窗口的 extension host**（对 exthost 进程 `Stop-Process -Force`）能让那一个窗口
    下线而应用保留其余窗口——这正是租约崩溃场景与 broker 看门狗要处理的形状。
  - 平台差异会改变"持有者消失"的观感：unix socket 把 broker 的死亡表现为 `ECONNRESET`，
    Windows 命名管道则是**有序关闭**（见 `mcp/brokerForwarder.ts:148-164` 与
    `mcp/__tests__/broker.test.ts:486-496`）。租约本身不走 socket，但同一台机器上
    "窗口怎么死"的差异是同一批平台差异，值得在两次实测里分别记录。
  - `tools/ui-review/` 的隔离 dev host 用独立的 `--user-data-dir`
    （`tools/ui-review/README.md:88-90`），因此**需要共享 profile 的双窗口模式**才能制造
    "两个窗口共享 globalStorage"的真实场景；而 broker 的端点由 `sha256(username + homedir)`
    派生，**不随 `--user-data-dir` 变化**（`tools/ui-review/README.md:239-248`），
    所以同一用户的**两个 profile** 也会争同一个端点——与"一个 profile 的两个窗口"同类。
    租约没有这一层：它的路径来自 `globalStorageUri`，**逐 profile 独立**。
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
   `KNOWN_ISSUES.md` / `KNOWN_ISSUES.zh.md` 里把"每个窗口各自轮询"
   （现为 `KNOWN_ISSUES.zh.md:210-214`）改写成
   "默认一个窗口轮询；可在设置中关闭租约"。

### 11.2 转入默认开启需要的证据

broker 的交接已提供了**同形状证据的样板**（下面每条都注明"对应 broker 侧的哪次实测"），
照这个粒度收集即可：

- 阶段 1 的影子日志里，**≥ 1 周、≥ 3 个真实多窗口会话**中：选主抖动（10 分钟内 owner 变化）
  为 0；无"机制不可用"记录（除非用户环境真的不可写）。
  _样板_：broker 侧测过"持有者健在时，四个轮询间隔内注册文件逐字节不变、看门狗零日志"
  （`TODO.md:9`）——"健康时绝对安静"是可以量出来的，不是感觉。
- 人工实测**关闭主导窗口**后，follower 在下一次 poll 间隔内接管（用命令查询 pid 变化作为证据）。
  _样板_：broker 侧的正常关闭接管。
- 人工实测**强杀**（对 exthost 进程 `Stop-Process -Force`，见 §10.2）后，接管发生在
  35–47 秒内。_样板_：broker 侧硬杀后 **1,400 ms** 接管、第二次 **124 ms**（`TODO.md:9`）；
  租约因为要等过期，数字应当明显更大——**这正是要量出来的对照**。
- 人工实测"轮询饥饿看门狗"路径：人为让所有窗口都不主导，断言 2 × 间隔后有人开始轮询。
- 明确的无回归证据：follower 窗口手动打开通知视图仍能看到最新通知（§5 最后一行）。
- 一个**反证据**也要收：跟随者窗口在"另一个窗口正在轮询"时，其徽标/通知视图是否会在合理时间
  内更新到最新（因为推送路径按窗口独立）。若这里出现明显延迟，代价可能大于收益。
- **交付时的收尾行为也要量**：broker 侧测过"持有者死亡时已在转发的会话 31 ms 后以一行 info
  结束、退出码 0、**不降级为匿名**"（`TODO.md:9`、`KNOWN_ISSUES.zh.md:232`）。
  租约的对应物是**follower 窗口在接管前后会不会漏弹一次提示**——按本文设计 follower 本来
  就不弹，所以这里要量的是"接管后第一轮轮询是否在预期时间内发生"，而不是"有没有报错"。

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
6. ~~顺带修 `seenNotificationIds` 的整表覆盖~~ **已作废**：该竞态已由 `9a041b0` 修掉
   （§1.2 的纠正、`ROADMAP.md:195`）。除非有新的证据，租约**不应**改动基线的所有权规则
   （理由见 §9 末尾）。
7. **harness 支持**：`tools/ui-review/` 目前每次 launch 用独立 `--user-data-dir`
   （`tools/ui-review/README.md:88-90`）。要不要加一个"共享 profile 的双窗口"模式
   （Ctrl+Shift+N 的手法见 §10.2），让多窗口场景可以走查？否则 §10.2 / §11.2 的人工验证
   会很别扭。
8. **强制接管的语义**：用户点"强制接管"时，是否应当**立即**轮询一次再走正常流程
   （用户体验更好，但会在租约未定时产生额外请求）？
9. **心跳写失败的中间档**（§4.1 新增）：短重试几次、阈值定多长？本文建议"重试 3 次、
   每次间隔数百毫秒；连续失败超过 2 × 过期周期才降级"，但这需要与 §11.2 的实测一起定。

---

## 13. 事实核对清单

本次逐条重核（HEAD `c5118a6`，工作树干净）。**标 ⚠ 的是本次修订改动的行号或结论。**

| 断言                                                                  | 位置                                                                                                 |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 激活事件按窗口生效                                                    | `packages/forgejo-toolkit/package.json:344-349` ⚠                                                    |
| 每个窗口都探测版本                                                    | `packages/forgejo-toolkit/src/extension.ts:96-98`                                                    |
| 版本缓存在进程内 Map                                                  | `packages/forgejo-toolkit/src/api/serverVersion.ts:65-67` ⚠                                          |
| 版本过低提示                                                          | `packages/forgejo-toolkit/src/api/versionProbe.ts:40-42`                                             |
| 该提示的去重集是进程内的（判断在 `:182-186`）                         | `packages/forgejo-toolkit/src/api/vscodeClientHost.ts:13-15`                                         |
| 每个窗口都启动通知轮询                                                | `packages/forgejo-toolkit/src/extension.ts:124-126`                                                  |
| 轮询用 `setInterval`（`_scheduleAll`）                                | `packages/forgejo-toolkit/src/notifications/notificationPoller.ts:188-197` ⚠                         |
| 每实例并发一次请求                                                    | `packages/forgejo-toolkit/src/notifications/notificationPoller.ts:263-274` ⚠                         |
| 每窗口各自弹聚合提示                                                  | `packages/forgejo-toolkit/src/notifications/notificationPoller.ts:546-574` ⚠                         |
| 轮询间隔常量与钳制                                                    | `packages/forgejo-toolkit/src/config.ts:15-17`、`:425-433`                                           |
| 轮询设置项与范围                                                      | `packages/forgejo-toolkit/package.json:114-125` ⚠                                                    |
| 轮询开关的读取                                                        | `packages/forgejo-toolkit/src/config.ts:421-423`                                                     |
| 首次运行标记是 read-then-write                                        | `packages/forgejo-toolkit/src/welcome.ts:35-48`                                                      |
| 首次运行挂载点                                                        | `packages/forgejo-toolkit/src/extension.ts:104-108`                                                  |
| 已读基线是"队列内重读 + 只覆盖本窗口条目"的合并写（**不是**整表覆盖） | `packages/forgejo-toolkit/src/notifications/notificationPoller.ts:430-492`、`:514-533`、`:447-451` ⚠ |
| 该修复的交付记录                                                      | `ROADMAP.md:195`                                                                                     |
| 首轮无基线时的抑制分支                                                | `packages/forgejo-toolkit/src/notifications/notificationPoller.ts:455-459` ⚠                         |
| `globalState` 无跨窗口变更事件                                        | `packages/forgejo-toolkit/src/config.ts:351-358`                                                     |
| 实例列表写回是"紧邻重读 + 合并"，且自认非原子                         | `packages/forgejo-toolkit/src/config.ts:366-383`                                                     |
| worktree 写回同样重读，并写明队列只序列化本宿主                       | `packages/forgejo-toolkit/src/worktree/worktreeManager.ts:193-204`                                   |
| 原子写实现（`.part` + rename + fsync + 保权限位，**不创建目标**）     | `packages/forgejo-toolkit/src/utils/atomicWrite.ts:33-65`                                            |
| 队列/串行化既有先例                                                   | `packages/forgejo-toolkit/src/worktree/worktreeManager.ts:42-52` ⚠                                   |
| globalStorage 里已有的固定名文件与权限约定                            | `packages/forgejo-toolkit/src/mcpWorkspaceState.ts:59-75`、`src/mcpBroker.ts:42-49`、`:270-272` ⚠    |
| "第一个窗口赢"的既有原子原语（broker 绑定）                           | `packages/forgejo-toolkit/src/mcpBroker.ts:230-247` ⚠                                                |
| 陈旧 socket 的"探测再接管"先例                                        | `packages/forgejo-toolkit/mcp/brokerServer.ts:415-451` ⚠                                             |
| 所有权判断后才删除（避免删掉继任者文件）                              | `packages/forgejo-toolkit/src/mcpBroker.ts:589-617` ⚠                                                |
| 陈旧状态文件的 pid 存活探测先例（`isPidAlive`）                       | `packages/forgejo-toolkit/src/mcpWorkspaceState.ts:287-297` ⚠                                        |
| 单测里可共享的内存 `globalState` + fake timers                        | `packages/forgejo-toolkit/src/notifications/__tests__/notificationPoller.test.ts:63-96` ⚠            |
| `deactivate()` 的位置                                                 | `packages/forgejo-toolkit/src/extension.ts:170-178`                                                  |
| dev host 用独立 `--user-data-dir`（broker 端点不吃它）                | `tools/ui-review/README.md:88-90`、`:239-248` ⚠                                                      |
| 平台代价与规避方法的既有记录                                          | `KNOWN_ISSUES.md:210-214`、`KNOWN_ISSUES.zh.md:210-214`                                              |
| P4 条目                                                               | `TODO.md:18` ⚠                                                                                       |
| broker 交接的交付记录与实测数字                                       | `TODO.md:9`、`ROADMAP.md:191`、`KNOWN_ISSUES.zh.md:228-234`                                          |
| broker 看门狗常量与测试                                               | `packages/forgejo-toolkit/src/mcpBroker.ts:88`、`src/__tests__/mcpBroker.test.ts:399-630`            |
| 架构页对 broker 交接的描述（可作术语与写法的参照）                    | `docs/architecture/mcp-server.md:304-330`                                                            |
| MCP 启动日志的现行措辞（本文若引用旧措辞须改）                        | `packages/forgejo-toolkit/mcp/server.ts:47-49`                                                       |
| 设计文档入口（引用本文）                                              | `docs/architecture/README.md:51`                                                                     |

### 13.1 本次新增的实测条目（在本机 Windows 上跑的一次性 node 探针，非仓库测试）

这些不是仓库里的测试，而是写本文时用来取代"我猜"的一次性实验；结论已折进 §3.1 / §4.1 / §5 / §8：

| 探针                                      | 结果                                                     | 用在哪   |
| ----------------------------------------- | -------------------------------------------------------- | -------- |
| 对已存在文件 `fs.open(p, 'wx')`           | `EEXIST`；关闭句柄后再试仍 `EEXIST`；`unlink` 后可重建   | §4.2     |
| 存在陈旧 `p.part` 时 `fs.open(p, 'wx')`   | 成功（`.part` 不挡目标名）                               | §4.2.5   |
| `rename(part, target)` 覆盖已存在目标     | 成功，内容被替换                                         | §3.1     |
| **目标被任一进程以读句柄打开时 rename**   | **`EPERM`**；关掉该句柄后立刻重试成功                    | §4.1、§8 |
| "读一下再 rename"密集竞态（3 秒 1771 次） | `EPERM` = 0（读窗口极短，冲突需要读句柄恰好横跨 rename） | §4.1     |

**未能验证、只能留作假设的**：(a) `wx` 创建在具体 globalStorage 路径（`%APPDATA%` 下、
可能被 OneDrive/杀软/索引器扫到）上的原子性——探针跑在 `%TEMP%`；网络盘/同步目录上的语义
完全没测；(b) POSIX 上同一 rename 竞态是否也失败（预期不失败，因为 unlink/rename 不看打开
句柄，但本机是 Windows，未测）；(c) 真实 antivirus/索引器长时间持有租约文件时心跳的行为
（只测了"人为持有的读句柄"）；(d) 真实 `deactivate()` 的可靠性；(e) 真实睡眠/唤醒下的节流。
