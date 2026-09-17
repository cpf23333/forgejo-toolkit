/**
 * Localization seam for the API layer. The extension host passes
 * `vscode.l10n.t`; headless consumers (the MCP server process) keep the
 * English passthrough default. Messages use vscode-style {0} placeholders.
 */
export type TranslateFn = (message: string, ...args: (string | number | boolean)[]) => string;

/** English fallback that substitutes {0}, {1}, ... placeholders in order. */
export const passthroughTranslate: TranslateFn = (message, ...args) =>
  args.reduce<string>((text, arg, index) => text.replaceAll(`{${index}}`, String(arg)), message);
