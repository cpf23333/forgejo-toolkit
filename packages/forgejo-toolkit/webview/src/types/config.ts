export interface ForgejoToolkitWebviewConfig {
  panelMode?: boolean;
  vscodeVersion?: string;
}

declare global {
  interface Window {
    __FORGEJO_TOOLKIT_CONFIG__?: ForgejoToolkitWebviewConfig;
  }
}
