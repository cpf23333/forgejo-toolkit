import * as vscode from 'vscode';

/**
 * Resolve the display locale from an explicit `forgejoToolkit.locale`
 * configuration value, falling back to the VS Code UI language.
 */
export function resolveLocale(configured: unknown, vscodeLanguage: string = vscode.env.language): 'en' | 'zh' {
  if (configured === 'en' || configured === 'zh') {
    return configured;
  }
  return vscodeLanguage.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
