import * as vscode from 'vscode';
import { ForgejoClient } from '../api/client';
import { ConfigManager } from '../config';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import type { ForgejoNotification } from '../api/types';
import type { Logger } from '../logger';
import { userFacingErrorMessage } from '../api/errors';

const SEEN_NOTIFICATION_IDS_KEY = 'forgejoToolkit.seenNotificationIds';

export interface NotificationMessageSender {
  pushNotifications(instanceId: string, notifications: ForgejoNotification[]): void;
  pushNotificationError(instanceId: string, error: string): void;
  openNotifications(): void;
}

interface NewNotificationBatch {
  instance: ForgejoInstance;
  notifications: ForgejoNotification[];
}

export class NotificationPoller implements vscode.Disposable {
  // All instances share one interval, so a single timer drives one poll round
  // per tick; a round's "new notification" toasts are aggregated into one.
  private _timer: NodeJS.Timeout | undefined;
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

  constructor(
    private readonly _config: ConfigManager,
    private readonly _sender: NotificationMessageSender,
    private readonly _context: vscode.ExtensionContext,
    private readonly _logger?: Logger,
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
  }

  start(): void {
    if (this._disposed || this._started) {
      return;
    }
    this._started = true;
    if (!this._config.isNotificationPollingEnabled()) {
      this._logger?.debug('Notification polling is disabled');
      return;
    }
    this._scheduleAll(true);
  }

  stop(): void {
    this._started = false;
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
    this._timer = setInterval(() => {
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
   */
  private _pollOnce(): Promise<void> {
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
        if (this._pollAgainRequested && !this._disposed) {
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
    if (batches.length > 0 && !this._disposed) {
      this._showAggregatedNotification(batches);
    }
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
    this._logger?.debug(`Polling notifications for ${instance.name}`);
    const client = new ForgejoClient(instance.url, instance.token, this._logger, instance.syncApiUrlsToInstanceUrl);
    const notifications = await client.getNotifications(['unread', 'pinned']);

    // The instance may have been removed (or the poller disposed) while the
    // request was in flight; drop the stale result instead of pushing it to
    // the webview or showing a toast.
    if (this._disposed || !this._config.getInstances().some((i) => i.id === instance.id)) {
      return undefined;
    }

    this._sender.pushNotifications(instance.id, notifications);

    const newNotifications = await this._reconcileSeenIds(instance.id, notifications);
    return { instance, notifications: newNotifications };
  }

  /**
   * Compare the instance's unread list against the persisted seen ids and
   * record the new state, both inside the same serialized queue as the write.
   * Reading outside the queue would let an overlapping round observe the state
   * from before the previous round's write and report the same notification as
   * new twice.
   */
  private _reconcileSeenIds(instanceId: string, notifications: ForgejoNotification[]): Promise<ForgejoNotification[]> {
    const ids = notifications
      .map((notification) => notification.id)
      .filter((id): id is number => typeof id === 'number');
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
        const allSeen = this._getAllSeenIds();
        // Without a persisted baseline (fresh install) every unread
        // notification would be reported as "new" on the first poll; the first
        // poll for an instance only establishes the baseline.
        const hadBaseline = allSeen.has(instanceId);
        const seenIds = allSeen.get(instanceId) ?? new Set<number>();
        const newNotifications = hadBaseline
          ? notifications.filter((notification) => typeof notification.id === 'number' && !seenIds.has(notification.id))
          : [];
        allSeen.set(instanceId, new Set(ids));
        try {
          const serialized = Object.fromEntries([...allSeen].map(([key, value]) => [key, [...value]]));
          await this._context.globalState.update(SEEN_NOTIFICATION_IDS_KEY, serialized);
        } catch {
          // ignore persistence errors
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

    vscode.window.showInformationMessage(message, openLabel, markAllReadLabel).then((selection) => {
      if (selection === openLabel) {
        this._sender.openNotifications();
      } else if (selection === markAllReadLabel) {
        for (const batch of batches) {
          void this._markAllRead(batch.instance);
        }
      }
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
