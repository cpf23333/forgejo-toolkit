import type {
  AiPreReviewPanelCandidate,
  AiPreReviewPanelPayload,
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
  panelMode?: 'onboarding' | 'pullReviewComment' | 'aiPreReview';
  locale?: 'en' | 'zh';
  vscodeVersion?: string;
  pullReviewComment?: PullReviewCommentContext;
  aiPreReview?: AiPreReviewPanelConfig;
}

declare global {
  interface Window {
    __FORGEJO_TOOLKIT_CONFIG__?: ForgejoToolkitWebviewConfig;
  }
}
