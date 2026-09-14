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

export interface ForgejoToolkitWebviewConfig {
  panelMode?: 'onboarding' | 'pullReviewComment';
  locale?: 'en' | 'zh';
  vscodeVersion?: string;
  pullReviewComment?: PullReviewCommentContext;
}

declare global {
  interface Window {
    __FORGEJO_TOOLKIT_CONFIG__?: ForgejoToolkitWebviewConfig;
  }
}
