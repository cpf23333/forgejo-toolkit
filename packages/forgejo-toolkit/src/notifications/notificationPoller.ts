import * as vscode from 'vscode';
import { ForgejoClient } from '../api/client';
import { ConfigManager } from '../config';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import type { ForgejoNotification } from '../api/types';
import type { Logger } from '../logger';

const SEEN_NOTIFICATION_IDS_KEY = 'forgejoToolkit.seenNotificationIds';

export interface NotificationMessageSender {
  pushNotifications(instanceId: string, notifications: ForgejoNotification[]): void;
  openNotifications(): void;
}

export class NotificationPoller implements vscode.Disposable {
  private readonly _timers = new Map<string, NodeJS.Timeout>();
  private readonly _disposables: vscode.Disposable[] = [];
  private _started = false;
  private _disposed = false;
  // Serializes read-modify-write updates of the persisted seen-id map so
  // concurrent polls for different instances cannot overwrite each other.
  private _seenIdsWriteQueue: Promise<void> = Promise.resolve();

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
    for (const timer of this._timers.values()) {
      clearInterval(timer);
    }
    this._timers.clear();
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
    const instances = this._config.getInstances();
    const intervalMs = this._config.getNotificationPollingInterval() * 1000;

    for (const instance of instances) {
      if (immediate) {
        this._pollInstance(instance).catch((error: unknown) => {
          const err = error instanceof Error ? error.message : String(error);
          this._logger?.error(`Initial notification poll failed for ${instance.name}: ${err}`);
        });
      }
      const timer = setInterval(() => {
        this._pollInstance(instance).catch((error: unknown) => {
          const err = error instanceof Error ? error.message : String(error);
          this._logger?.error(`Notification poll failed for ${instance.name}: ${err}`);
        });
      }, intervalMs);
      this._timers.set(instance.id, timer);
    }
  }

  private async _pollInstance(instance: ForgejoInstance): Promise<void> {
    if (this._disposed) {
      return;
    }
    this._logger?.debug(`Polling notifications for ${instance.name}`);
    const client = new ForgejoClient(instance.url, instance.token, this._logger, instance.syncApiUrlsToInstanceUrl);
    const notifications = await client.getNotifications(['unread', 'pinned']);

    // The instance may have been removed (or the poller disposed) while the
    // request was in flight; drop the stale result instead of pushing it to
    // the webview or showing a toast.
    if (this._disposed || !this._config.getInstances().some((i) => i.id === instance.id)) {
      return;
    }

    this._sender.pushNotifications(instance.id, notifications);

    // Without a persisted baseline (fresh install) every unread notification
    // would be reported as "new" on the first poll; the first poll only
    // establishes the baseline.
    const hadBaseline = this._getAllSeenIds().has(instance.id);
    const newNotifications = hadBaseline ? this._filterNewNotifications(instance.id, notifications) : [];
    if (newNotifications.length > 0) {
      this._showNotification(instance, newNotifications);
    }

    await this._updateSeenIds(instance.id, notifications);
  }

  private _filterNewNotifications(instanceId: string, notifications: ForgejoNotification[]): ForgejoNotification[] {
    const seenIds = this._getSeenIds(instanceId);
    return notifications.filter((notification) => {
      const id = notification.id;
      return typeof id === 'number' && !seenIds.has(id);
    });
  }

  private _updateSeenIds(instanceId: string, notifications: ForgejoNotification[]): Promise<void> {
    const ids = notifications
      .map((notification) => notification.id)
      .filter((id): id is number => typeof id === 'number');
    // Queue the write so concurrent polls merge onto the latest persisted
    // state instead of racing a read-modify-write cycle. Serialize as plain
    // arrays: globalState JSON-persists values and a Set would degrade to {}.
    this._seenIdsWriteQueue = this._seenIdsWriteQueue.then(async () => {
      const allSeen = this._getAllSeenIds();
      allSeen.set(instanceId, new Set(ids));
      try {
        const serialized = Object.fromEntries([...allSeen].map(([key, value]) => [key, [...value]]));
        await this._context.globalState.update(SEEN_NOTIFICATION_IDS_KEY, serialized);
      } catch {
        // ignore persistence errors
      }
    });
    return this._seenIdsWriteQueue;
  }

  private _getSeenIds(instanceId: string): Set<number> {
    return this._getAllSeenIds().get(instanceId) ?? new Set();
  }

  private _getAllSeenIds(): Map<string, Set<number>> {
    const raw = this._context.globalState.get<Record<string, number[]>>(SEEN_NOTIFICATION_IDS_KEY, {});
    const result = new Map<string, Set<number>>();
    for (const [key, ids] of Object.entries(raw)) {
      result.set(key, new Set(ids));
    }
    return result;
  }

  private _showNotification(instance: ForgejoInstance, notifications: ForgejoNotification[]): void {
    const count = notifications.length;
    const message =
      count === 1
        ? vscode.l10n.t('New notification from {0}', instance.name)
        : vscode.l10n.t('{0} new notifications from {1}', count, instance.name);

    const openLabel = vscode.l10n.t('Open');
    const markAllReadLabel = vscode.l10n.t('Mark all as read');

    vscode.window.showInformationMessage(message, openLabel, markAllReadLabel).then((selection) => {
      if (selection === openLabel) {
        this._sender.openNotifications();
      } else if (selection === markAllReadLabel) {
        this._markAllRead(instance);
      }
    });
  }

  private async _markAllRead(instance: ForgejoInstance): Promise<void> {
    try {
      const client = new ForgejoClient(instance.url, instance.token, this._logger, instance.syncApiUrlsToInstanceUrl);
      await client.markAllNotificationsRead();
      await this._pollInstance(instance);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this._logger?.error(`Failed to mark all notifications read for ${instance.name}: ${err}`);
      vscode.window.showErrorMessage(vscode.l10n.t('Failed to mark notifications as read: {0}', err));
    }
  }
}
