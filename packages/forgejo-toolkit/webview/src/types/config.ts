import type {
  AiPreReviewPanelCandidate,
  AiPreReviewPanelPayload,
  NotificationSummaryPanelPayload,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';

export interface PullReviewCommentContext {
  instanceId: string;
  owner: string;
  repo: string;
  index: number;
  path: string;
  position: number;
  isBase: boolean;
  lineNumber: number;
  extraLinesCount?: number;
  mode: 'single' | 'review';
  pendingReviewId?: number;
}

export type { AiPreReviewPanelCandidate, AiPreReviewPanelPayload };

/**
 * The AI pre-review panel's payload as this document receives it: the run's own
 * payload plus the one flag only the host can answer, because it is about what
 * *this window* can do (`viewProvider` present or not), not about the run.
 */
export type AiPreReviewPanelConfig = AiPreReviewPanelPayload & { canOpenPullRequest?: boolean };

export interface ForgejoToolkitWebviewConfig {
  panelMode?: 'onboarding' | 'pullReviewComment' | 'aiPreReview' | 'settings' | 'notificationSummary';
  locale?: 'en' | 'zh';
  vscodeVersion?: string;
  pullReviewComment?: PullReviewCommentContext;
  aiPreReview?: AiPreReviewPanelConfig;
  /**
   * The pre-review panel's own identity, injected per panel: its suggestion cards
   * publish it so a contributed item reaches the panel that was right-clicked rather
   * than the newest one (src/aiPreReviewPanelRegistry.ts).
   */
  aiPreReviewPanelId?: string;
  /**
   * The notification-summary panel's payload, injected the way `aiPreReview` is so
   * the first paint shows the answer without a round trip. A re-render for another
   * notification arrives as `notificationSummaryPanelPayload` instead (the panel
   * only ever exists once; see `NotificationSummaryPanel.vue`).
   */
  notificationSummary?: NotificationSummaryPanelPayload;
}

declare global {
  interface Window {
    __FORGEJO_TOOLKIT_CONFIG__?: ForgejoToolkitWebviewConfig;
  }
}
