import * as vscode from 'vscode';
import { ForgejoClient } from '../api/client';
import { ConfigManager } from '../config';
import { LIST_ITEM_LIMIT } from '@cpf23333-forgejo-toolkit/shared/limits';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import type { ForgejoNotification } from '../api/types';
import type { Logger } from '../logger';
import type { LeasePollingGate } from '../lease/leasePollingGate';
import { userFacingErrorMessage } from '../api/errors';

const SEEN_NOTIFICATION_IDS_KEY = 'forgejoToolkit.seenNotificationIds';

/**
 * Page size of the poller's notification request.
 *
 * It cannot be used as a completeness proof: `client.ts` documents that Forgejo
 * silently clamps a larger `limit` server-side, so a page that is *shorter* than
 * this is not necessarily the whole unread+pinned set — a server with a lower
 * cap returns exactly its cap. Without a server-reported total, only an empty
 * page proves there is nothing left; with one, the poller reads exactly
 * `ceil(total / POLL_PAGE_LIMIT)` pages instead. See `_fetchUnreadSet`.
 */
const POLL_PAGE_LIMIT = 50;

export interface NotificationMessageSender {
  /**
   * `coveredIds` are the ids this poll examined, which need not be the ids it
   * returned (see `_pollInstance` and `_markAllRead`): the view may only treat a
   * row as read when the poller looked at it, and it cannot infer that from the
   * returned list alone.
   */
  pushNotifications(instanceId: string, notifications: ForgejoNotification[], coveredIds: number[]): void;
  pushNotificationError(instanceId: string, error: string): void;
  openNotifications(): void;
}

interface NewNotificationBatch {
  instance: ForgejoInstance;
  notifications: ForgejoNotification[];
}

/** The numeric ids of a notification list, in order; a row without one is skipped. */
function idsOf(notifications: ForgejoNotification[]): number[] {
  return notifications.map((notification) => notification.id).filter((id): id is number => typeof id === 'number');
}

export class NotificationPoller implements vscode.Disposable {
  // All instances share one interval, so a single timer drives one poll round
  // per tick; a round's "new notification" toasts are aggregated into one.
  private _timer: NodeJS.Timeout | undefined;
  /** `Date.now()` the last poll round finished at, for the diagnostics (§11.1). */
  private _lastPollFinishedAt: number | undefined;
  /** `Date.now()` the armed interval is next due at; cleared by `stop()`. */
  private _nextPollAt: number | undefined;
  private readonly _disposables: vscode.Disposable[] = [];
  private _started = false;
  private _disposed = false;
  // Serializes read-modify-write updates of the persisted seen-id map so
  // concurrent polls for different instances cannot overwrite each other.
  private _seenIdsWriteQueue: Promise<void> = Promise.resolve();
  // Single-flight guard for a full poll round: ConfigManager.addInstance fires
  // onInstancesChanged once per instance, and each restart would otherwise
  // start its own round (one GET per instance each).
  private _pollInFlight: Promise<void> | undefined;
  // Identifies the current round so a settling round only clears the guard
  // when it is still the one being tracked.
  private _pollRoundId = 0;
  // The instance set the in-flight round was started for, and whether a request
  // arrived meanwhile for a different set (an instance added while the round
  // ran). Such a request joins the in-flight round, which cannot poll the new
  // instance, so one follow-up round is run when it settles instead of waiting
  // for the next interval (five minutes by default).
  private _polledInstanceKey = '';
  private _pollAgainRequested = false;
  // The unread ids of each instance's last successful poll. A later poll whose
  // page came back short examined the whole unread set, so a row in here that is
  // absent from that page was examined and found read — the only way to report a
  // row the poll did not return. Entries for instances that are gone are dropped
  // at the start of a round.
  private readonly _knownUnreadIds = new Map<string, number[]>();

  /**
   * This window's own entries of the seen-id baseline whose `globalState` write
   * FAILED. The baseline is read back from `globalState` on every reconcile,
   * so a write that never landed would leave the stored map one round behind
   * and the same notifications would be reported as new on every poll until a
   * write succeeds. While a write is outstanding, these in-memory entries are
   * the authoritative baseline of the instances this window observed; a
   * successful write clears the map again (persistence is authoritative then,
   * which also picks up changes another window made).
   *
   * It holds entries this window owns only (see `_ownedSeenInstanceIds`):
   * entries another window wrote are still on the shared key, and carrying a
   * stale copy of them here would make the next write revert them.
   */
  private _unpersistedSeenIds: Map<string, Set<number>> | undefined;

  /**
   * The instance ids whose persisted baseline this window has itself written —
   * the instances it actually observed. `globalState` is shared with every
   * other window (they are separate extension hosts over the same state), so
   * the stored map is not this window's to overwrite as a whole:
   *
   * - Writing: a reconcile reads the stored map back and overlays only this
   *   window's entries, so an entry another window wrote (for example the first
   *   baseline of an instance it configured after this window last read the
   *   instance list) is never carried away by a stale snapshot. Writing the
   *   whole in-memory map instead deleted that entry, and the owner's next poll
   *   then took the `hadBaseline === false` branch and swallowed that round's
   *   notifications. See `_reconcileSeenIds`.
   * - Deleting: `get`→`update` is not atomic and there is no cross-window
   *   change event, so "this id is missing from the configured instance list"
   *   cannot by itself be told apart from "another window configured that
   *   instance after this window last looked". Resolved the honest way: only an
   *   entry this window observed may be deleted (its id is in here and is gone
   *   from the configured list). An entry this window never wrote is left
   *   alone, because it is not this window's to judge; if it really is dead
   *   state, a window that did observe the instance drops it on its next
   *   reconcile — and every polling window polls every configured instance.
   *   The price of not guessing is that a baseline can outlive its observer
   *   when that window was reloaded before the instance was removed; that is
   *   inert state under a key nothing reads any more, which is the conservative
   *   side of the trade.
   */
  private readonly _ownedSeenInstanceIds = new Set<string>();

  /**
   * Bumped whenever a successful "Mark all as read" clears the view. A poll
   * reply that was already in flight when that happened describes the state
   * before the clear, so pushing it would resurrect the rows the user just
   * cleared; `_pollInstance` compares the generation it captured against this
   * one and drops such a reply. See `_markAllRead`.
   */
  private _clearedViewGeneration = 0;

  constructor(
    private readonly _config: ConfigManager,
    private readonly _sender: NotificationMessageSender,
    private readonly _context: vscode.ExtensionContext,
    private readonly _logger?: Logger,
    /**
     * The multi-window polling lease's gate (§11.1 stage 2), or nothing.
     *
     * Absent means "this window polls": every check below treats a missing gate
     * as permission, which is what keeps the poller usable on its own (tests,
     * the headless host) and keeps §8's direction — uncertainty polls — the
     * default rather than something the lease has to grant.
     */
    private readonly _lease?: LeasePollingGate,
  ) {
    this._disposables.push(
      this._config.onInstancesChanged(() => this.restart()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('forgejoToolkit.notificationPollingEnabled') ||
          e.affectsConfiguration('forgejoToolkit.notificationPollingInterval')
        ) {
          this.restart();
        }
      }),
    );
    if (this._lease) {
      this._disposables.push(
        this._lease.onDidChange(() => {
          // `false → true` is a window that has just become the owner (the
          // previous one closed, crashed or yielded to this window's focus).
          // It polls now: the user is looking at this window, and waiting out
          // the interval (five minutes by default) would read as "the alerts
          // stopped working".
          if (this._disposed || !this._started || !this._mayPoll()) {
            return;
          }
          void this._pollOnce();
        }),
      );
    }
  }

  /**
   * Whether this window may poll and alert right now (§8).
   *
   * The lease answers `false` for exactly one state — a confirmed, healthy
   * follower — and `true` for the setting being off, a degraded mechanism, and
   * every uncertainty. This method only adds the "no gate at all" case, which
   * is also `true`.
   */
  private _mayPoll(): boolean {
    return this._lease === undefined || this._lease.mayPoll();
  }

  /**
   * The poll timing the diagnostics command reports (§11.1 stage 2):
   * `lastSuccessfulPollAt` is when the last round finished, and
   * `nextScheduledPollAt` is when the armed interval is due. Both are absent
   * while polling is stopped, which is the honest answer for a follower.
   */
  pollingTiming(): { lastSuccessfulPollAt?: number; nextScheduledPollAt?: number } {
    return {
      ...(this._lastPollFinishedAt === undefined ? {} : { lastSuccessfulPollAt: this._lastPollFinishedAt }),
      ...(this._nextPollAt === undefined ? {} : { nextScheduledPollAt: this._nextPollAt }),
    };
  }

  start(): void {
    if (this._disposed || this._started) {
      return;
    }
    if (!this._config.isNotificationPollingEnabled()) {
      this._logger?.debug('Notification polling is disabled');
      return;
    }
    // Set only once polling is actually on: the follow-up-round guard in
    // `_pollOnce` (and the toast gate in `_pollAll`) read `_started` as
    // "polling is running", and a disabled poller that still carried the flag
    // would run a follow-up round when an in-flight one settles.
    this._started = true;
    this._scheduleAll(true);
  }

  stop(): void {
    this._started = false;
    this._nextPollAt = undefined;
    if (this._timer !== undefined) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }

  restart(): void {
    this.stop();
    this.start();
  }

  dispose(): void {
    this._disposed = true;
    this.stop();
    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables.length = 0;
  }

  private _scheduleAll(immediate: boolean): void {
    const intervalMs = this._config.getNotificationPollingInterval() * 1000;

    if (immediate) {
      void this._pollOnce();
    }
    this._nextPollAt = Date.now() + intervalMs;
    this._timer = setInterval(() => {
      this._nextPollAt = Date.now() + intervalMs;
      void this._pollOnce();
    }, intervalMs);
  }

  /**
   * One poll round, single-flighted. A round requested while another is still
   * in flight (an immediate round per imported instance, or an interval tick
   * landing mid-round) joins the in-flight one instead of firing a second
   * burst of requests. When the instance set changed since that round started,
   * one follow-up round runs as soon as it settles: a joined round covers only
   * the instances it started with, so newly added ones would otherwise wait for
   * the next interval.
   *
   * A round is gated once, here, at the moment it starts (§8). Deliberately not
   * again when the toast is shown: a handover is "the round belongs to whoever
   * started it", and the window that takes over re-polls immediately and reads
   * the baseline this round already wrote (`_reconcileSeenIds`), so the same
   * notification cannot be alerted twice.
   */
  private _pollOnce(): Promise<void> {
    if (!this._mayPoll()) {
      // A confirmed healthy follower: no requests, no alerts, nothing written.
      // The gate's change notification is what resumes polling.
      return Promise.resolve();
    }
    if (this._pollInFlight) {
      if (this._instanceKey() !== this._polledInstanceKey) {
        this._pollAgainRequested = true;
      }
      return this._pollInFlight;
    }
    const roundId = ++this._pollRoundId;
    const instanceKey = this._instanceKey();
    this._polledInstanceKey = instanceKey;
    this._pollAgainRequested = false;
    const round = this._pollAll().catch(() => {
      // per-instance failures are already handled inside _pollAll
    });
    this._pollInFlight = round.finally(() => {
      if (this._pollRoundId === roundId) {
        this._pollInFlight = undefined;
        // A stopped poller must not run the follow-up round: `stop()` drops the
        // interval, and without the `_started` check an in-flight round whose
        // instance set changed would still poll once more afterwards.
        if (this._pollAgainRequested && !this._disposed && this._started) {
          this._pollAgainRequested = false;
          void this._pollOnce();
        }
      }
    });
    return this._pollInFlight;
  }

  /** Identifies the configured instance set across a round. */
  private _instanceKey(): string {
    return this._config
      .getInstances()
      .map((instance) => instance.id)
      .join('\u0000');
  }

  /**
   * One poll round across all instances. New-notification toasts are
   * aggregated: instead of one toast per instance, a single toast reports the
   * round's total (and its "Mark all as read" covers every instance that had
   * new notifications).
   */
  private async _pollAll(): Promise<void> {
    const instances = this._config.getInstances();
    // Instances can be removed between rounds; their last known unread ids are
    // of no use to anyone afterwards, so drop them instead of keeping them for
    // the lifetime of the window.
    const configuredIds = new Set(instances.map((instance) => instance.id));
    for (const instanceId of [...this._knownUnreadIds.keys()]) {
      if (!configuredIds.has(instanceId)) {
        this._knownUnreadIds.delete(instanceId);
      }
    }
    const batches: NewNotificationBatch[] = [];
    await Promise.all(
      instances.map(async (instance) => {
        try {
          const batch = await this._pollInstance(instance);
          if (batch && batch.notifications.length > 0) {
            batches.push(batch);
          }
        } catch (error) {
          this._handlePollFailure(instance, error);
        }
      }),
    );
    // A round that was in flight when the poller stopped (disabled or disposed
    // meanwhile) must not toast either: the user turned polling off.
    if (batches.length > 0 && !this._disposed && this._started) {
      this._showAggregatedNotification(batches);
    }
    this._lastPollFinishedAt = Date.now();
  }

  /**
   * A failed poll must be visible, not just logged: the notifications view
   * shows the per-instance error (e.g. an expired token) instead of a
   * misleading "no notifications" state.
   */
  private _handlePollFailure(instance: ForgejoInstance, error: unknown): void {
    const err = userFacingErrorMessage(error);
    this._logger?.error(`Notification poll failed for ${instance.name}: ${err}`);
    this._sender.pushNotificationError(instance.id, err);
  }

  /**
   * Polls one instance and returns its new (not previously seen) notifications
   * for the caller to aggregate; returns undefined when the result is stale
   * (poller disposed or instance removed mid-flight). Toasting is the
   * caller's job.
   */
  private async _pollInstance(instance: ForgejoInstance): Promise<NewNotificationBatch | undefined> {
    if (this._disposed) {
      return undefined;
    }
    // The generation the view state is at when the request goes out. A
    // "Mark all as read" that lands while this request is in flight clears the
    // view and bumps the counter, so this reply describes a state the user
    // already dismissed; pushing it would rewrite the badge slot and re-flag
    // every row as unread for up to the polling interval.
    const generation = this._clearedViewGeneration;
    this._logger?.debug(`Polling notifications for ${instance.name}`);
    const client = new ForgejoClient(instance.url, instance.token, this._logger, instance.syncApiUrlsToInstanceUrl);
    const { notifications, wholeSetSeen } = await this._fetchUnreadSet(client);

    // The instance may have been removed (or the poller disposed) while the
    // request was in flight; drop the stale result instead of pushing it to
    // the webview or showing a toast.
    if (this._disposed || !this._config.getInstances().some((i) => i.id === instance.id)) {
      return undefined;
    }
    // A clear that landed meanwhile wins over this reply (see above). The
    // coverage is deliberately not recorded either: the ids it would carry were
    // cleared from the view, and the next poll re-establishes them.
    if (this._clearedViewGeneration !== generation) {
      return undefined;
    }

    this._sender.pushNotifications(
      instance.id,
      notifications,
      this._coverageFor(instance.id, notifications, wholeSetSeen),
    );

    const newNotifications = await this._reconcileSeenIds(instance.id, notifications);
    return { instance, notifications: newNotifications };
  }

  /**
   * The instance's unread+pinned notifications, and whether the read examined
   * the whole set (which is what decides how far the coverage below reaches).
   *
   * When the server reports a total (`X-Total-Count`), the read no longer
   * relies on the empty-page proof: it pages exactly `ceil(total /
   * POLL_PAGE_LIMIT)` times — no look-ahead request — and a non-empty page is
   * then still the whole set when the rows arrived match the total. The
   * `ceil` is a budget, not a target: a short page ends the read early (the
   * total may have counted rows a concurrent mark-as-read removed), and the
   * whole read is bounded by the shared list cap so a pathological total
   * cannot keep the poller fetching forever. A total past that cap leaves
   * `wholeSetSeen` false: the rows beyond it were never examined.
   *
   * Pages after the first are selected with the `before` cursor (only threads
   * updated before the oldest row already held), the same cursor the webview's
   * "load more" uses: marking notifications read removes them from the
   * filtered server list, and a numbered page would shift under the read.
   *
   * Without a total the old rule stands unchanged: one page only, and only an
   * empty page proves completeness. Forgejo silently clamps a `limit` above
   * its own cap (`client.ts`), so a short non-empty page proves nothing — a
   * server whose cap is lower than POLL_PAGE_LIMIT returns exactly its cap
   * while unread rows sit past it.
   */
  private async _fetchUnreadSet(client: ForgejoClient): Promise<{
    notifications: ForgejoNotification[];
    wholeSetSeen: boolean;
  }> {
    const firstPage = await client.getNotifications(['unread', 'pinned'], undefined, POLL_PAGE_LIMIT);
    const notifications = [...firstPage.items];
    if (firstPage.totalCount === undefined) {
      return { notifications, wholeSetSeen: notifications.length === 0 };
    }
    const totalCount = firstPage.totalCount;
    const totalPages = Math.ceil(totalCount / POLL_PAGE_LIMIT);
    // Guards a server that ignores the `before` cursor and answers every page
    // with the first one, the same pattern `_fetchAllPagesMeta` guards: without
    // it the loop below would append duplicates until the page budget ran out.
    let previousFirstItemKey = notifications.length > 0 ? JSON.stringify(notifications[0]) : undefined;
    for (let page = 2; page <= totalPages && notifications.length < LIST_ITEM_LIMIT; page++) {
      const oldest = notifications[notifications.length - 1]?.updated_at;
      if (!oldest) {
        break;
      }
      const nextPage = await client.getNotifications(['unread', 'pinned'], undefined, POLL_PAGE_LIMIT, oldest);
      const firstItemKey = nextPage.items.length > 0 ? JSON.stringify(nextPage.items[0]) : undefined;
      if (firstItemKey !== undefined && firstItemKey === previousFirstItemKey) {
        break;
      }
      previousFirstItemKey = firstItemKey;
      notifications.push(...nextPage.items);
      if (nextPage.items.length < POLL_PAGE_LIMIT) {
        break;
      }
    }
    return { notifications, wholeSetSeen: notifications.length >= totalCount };
  }

  /**
   * The ids this poll can speak for, and the record of what it saw unread for
   * the next one.
   *
   * The request asks for the unread+pinned set, so a poll that examined that
   * whole set — `wholeSetSeen`, proved either by an empty page or by matching
   * the server-reported total (see `_fetchUnreadSet`) — can clear every row it
   * saw unread last time: such a row is read now, and the view may only clear
   * it if it is named here (it is not in `notifications`).
   *
   * A partial read cannot prove completeness. Forgejo silently clamps a
   * `limit` above its own cap (`client.ts`), so a server whose cap is lower
   * than POLL_PAGE_LIMIT returns exactly its cap and no more; the page looks
   * short while unread rows sit past it. Unioning the previously-seen ids in
   * on that evidence marked those unread rows read in the view. Only the ids
   * the read carried are covered then — the same rule a full page has always
   * had.
   */
  private _coverageFor(instanceId: string, notifications: ForgejoNotification[], wholeSetSeen: boolean): number[] {
    const pageIds = idsOf(notifications);
    const previouslyUnread = this._knownUnreadIds.get(instanceId) ?? [];
    // A full page (or one below the clamp) may have been truncated, so only a
    // read proven complete covers the rows it saw unread before.
    const coveredIds = wholeSetSeen ? [...new Set([...pageIds, ...previouslyUnread])] : pageIds;
    this._knownUnreadIds.set(instanceId, coveredIds);
    return coveredIds;
  }

  /**
   * Compare the instance's unread list against the persisted seen ids and
   * record the new state, both inside the same serialized queue as the write.
   * Reading outside the queue would let an overlapping round observe the state
   * from before the previous round's write and report the same notification as
   * new twice.
   */
  private _reconcileSeenIds(instanceId: string, notifications: ForgejoNotification[]): Promise<ForgejoNotification[]> {
    const ids = idsOf(notifications);
    // Queue the read-modify-write so concurrent polls merge onto the latest
    // persisted state instead of racing. Serialize as plain arrays:
    // globalState JSON-persists values and a Set would degrade to {}.
    // A failed write must not poison the queue: without the catch, one
    // rejection would skip every subsequent queued write forever.
    const reconcile = this._seenIdsWriteQueue
      .catch(() => {
        // keep the queue alive after a failed write
      })
      .then(async () => {
        // The stored map is read once, here: it carries both the baseline this
        // reconcile decides against and the foreign entries the write below
        // must carry over. Reading it outside this synchronous span (or
        // substituting this window's whole in-memory copy for it) is what made
        // the write a blind whole-table overwrite of a possibly stale snapshot.
        const stored = this._getAllSeenIds();
        // While the previous write is outstanding, the stored map is one round
        // behind for the instances this window owns; its in-memory copy is the
        // baseline for them then (see `_unpersistedSeenIds`).
        const baseline = this._unpersistedSeenIds?.get(instanceId) ?? stored.get(instanceId);
        // Without a persisted baseline (fresh install) every unread
        // notification would be reported as "new" on the first poll; the first
        // poll for an instance only establishes the baseline.
        const hadBaseline = baseline !== undefined;
        const seenIds = baseline ?? new Set<number>();
        const newNotifications = hadBaseline
          ? notifications.filter((notification) => typeof notification.id === 'number' && !seenIds.has(notification.id))
          : [];
        // From here on the instance's baseline is this window's to update (and,
        // once the instance is gone, to delete); see `_ownedSeenInstanceIds`.
        this._ownedSeenInstanceIds.add(instanceId);
        const merged = this._mergeBaselineForWrite(stored, instanceId, new Set(ids));
        try {
          const serialized = Object.fromEntries([...merged].map(([key, value]) => [key, [...value]]));
          await this._context.globalState.update(SEEN_NOTIFICATION_IDS_KEY, serialized);
          // The baseline reached disk; the in-memory copy must not shadow
          // newer persisted state (another window's reconcile) any more.
          this._unpersistedSeenIds = undefined;
        } catch {
          // The baseline did not reach disk: keep the entries this window owns
          // in memory so the next reconcile does not re-report this round's
          // notifications as new on every poll until a write succeeds, and so
          // the next successful write flushes them too.
          const pending = new Map<string, Set<number>>();
          for (const [id, value] of merged) {
            if (this._ownedSeenInstanceIds.has(id)) {
              pending.set(id, value);
            }
          }
          this._unpersistedSeenIds = pending;
        }
        return newNotifications;
      });
    // The queue stays void-typed and never rejects, so the next writer always
    // chains onto it; this round's new notifications are returned separately.
    this._seenIdsWriteQueue = reconcile.then(
      () => undefined,
      () => undefined,
    );
    return reconcile;
  }

  /**
   * The baseline payload one reconcile persists: the map read back out of
   * `globalState` (passed in from the reconcile, read in its synchronous span,
   * immediately before this write), with this window's own entries overlaid and
   * its legitimately removed instances dropped.
   *
   * The stored map is shared with every other window and `get`→`update` is not
   * atomic, so serializing this window's snapshot back whole would drop an
   * entry another window added meanwhile — in particular the first baseline of
   * an instance it configured after this window last read the instance list.
   * Only the entries this window observed are written; everything else is
   * carried over from the read. The write is still not atomic across windows,
   * but the merge shrinks the clobber window to the span between the read and
   * the `update` call, the same trade-off `config.ts::_writeInstancesMerged`
   * and `worktreeManager.ts::removeWorktree` document.
   *
   * Deleting is limited to what this window can speak for:
   * `_ownedSeenInstanceIds` states the rule and why absence alone is not
   * treated as proof of removal.
   */
  private _mergeBaselineForWrite(
    stored: Map<string, Set<number>>,
    instanceId: string,
    seenIds: Set<number>,
  ): Map<string, Set<number>> {
    const merged = stored;
    // This window's entries that did not reach disk yet win over the stored
    // copies of them: the stored map is one round behind for those.
    for (const [id, value] of this._unpersistedSeenIds ?? []) {
      merged.set(id, value);
    }
    merged.set(instanceId, seenIds);
    const configuredIds = new Set(this._config.getInstances().map((instance) => instance.id));
    for (const id of [...merged.keys()]) {
      if (!configuredIds.has(id) && this._ownedSeenInstanceIds.has(id)) {
        merged.delete(id);
      }
    }
    return merged;
  }

  private _getAllSeenIds(): Map<string, Set<number>> {
    const raw = this._context.globalState.get<Record<string, number[]>>(SEEN_NOTIFICATION_IDS_KEY, {});
    const result = new Map<string, Set<number>>();
    for (const [key, ids] of Object.entries(raw)) {
      // Tolerate legacy dirty payloads: an older version persisted a Set,
      // which JSON-serializes to {} and would make `new Set(ids)` throw.
      result.set(key, new Set(Array.isArray(ids) ? ids : []));
    }
    return result;
  }

  private _showAggregatedNotification(batches: NewNotificationBatch[]): void {
    const total = batches.reduce((sum, batch) => sum + batch.notifications.length, 0);
    const message =
      batches.length === 1
        ? total === 1
          ? vscode.l10n.t('New notification from {0}', batches[0].instance.name)
          : vscode.l10n.t('{0} new notifications from {1}', total, batches[0].instance.name)
        : vscode.l10n.t('{0} new notifications across {1} instances', total, batches.length);

    const openLabel = vscode.l10n.t('Open');
    const markAllReadLabel = vscode.l10n.t('Mark all as read');

    // Promise.resolve flattens the Thenable: the catch below then also covers a
    // synchronous throw inside the callback (openNotifications), which must not
    // surface as an unhandled rejection.
    void Promise.resolve(vscode.window.showInformationMessage(message, openLabel, markAllReadLabel))
      .then((selection) => {
        if (selection === openLabel) {
          this._sender.openNotifications();
        } else if (selection === markAllReadLabel) {
          for (const batch of batches) {
            void this._markAllRead(batch.instance);
          }
        }
      })
      .catch((error: unknown) => {
        this._logger?.error(`Failed to handle the notification toast action: ${userFacingErrorMessage(error)}`);
      });
  }

  private async _markAllRead(instance: ForgejoInstance): Promise<void> {
    const client = new ForgejoClient(instance.url, instance.token, this._logger, instance.syncApiUrlsToInstanceUrl);
    try {
      await client.markAllNotificationsRead();
    } catch (error) {
      // Nothing was marked read locally (the webview only applies a mark on
      // the success reply), so a failure needs no rollback — just surface it.
      const err = userFacingErrorMessage(error);
      this._logger?.error(`Failed to mark all notifications read for ${instance.name}: ${err}`);
      vscode.window.showErrorMessage(vscode.l10n.t('Failed to mark notifications as read: {0}', err));
      return;
    }
    // Everything the server holds is read now, so every id this poller saw
    // unread is a row it examined and found read. They have to be named
    // explicitly: the refresh poll below comes back with an empty page, and an
    // empty page says nothing about the rows a view is still showing (the host
    // can only speak for rows it received). Pushed before the refresh so the
    // view is cleared even if that poll fails.
    const markedIds = this._knownUnreadIds.get(instance.id) ?? [];
    this._knownUnreadIds.set(instance.id, []);
    // Any poll that was already in flight read the unread list before the mark
    // and is therefore stale: its reply must not push the cleared rows back.
    // The refresh below starts *after* the bump, so it polls on the new
    // generation and is allowed through.
    this._clearedViewGeneration += 1;
    this._sender.pushNotifications(instance.id, [], markedIds);
    // Refresh the view after a successful mark. A refresh failure is not a
    // mark failure (the server already marked everything read) and must not
    // be reported as one.
    try {
      await this._pollInstance(instance);
    } catch (error) {
      this._handlePollFailure(instance, error);
    }
  }
}
