export {};

declare global {
  interface Window {
    /**
     * @deprecated VS Code webview 运行在 sandboxed iframe 中，modal 弹窗会被浏览器静默阻止。
     * 请改用 `useAppState().showInputBox()`。
     */
    prompt(message?: string, _default?: string): string | null;

    /**
     * @deprecated VS Code webview 运行在 sandboxed iframe 中，modal 弹窗会被浏览器静默阻止。
     * 请改用 `useAppState().showConfirm()`。
     */
    confirm(message?: string): boolean;

    /**
     * @deprecated VS Code webview 运行在 sandboxed iframe 中，modal 弹窗会被浏览器静默阻止。
     */
    alert(message?: unknown): void;
  }
}
