import * as vscode from 'vscode';
import { setApiErrorTranslate } from './errors-core';

// Extension-host entry point for the API error helpers: same exports as
// errors-core, but localized through vscode.l10n. Headless consumers (the
// bundled MCP server) import errors-core directly instead, keeping the
// `vscode` module out of their dependency graph.
setApiErrorTranslate(vscode.l10n.t);

export {
  ApiError,
  toApiError,
  extractApiErrorMessage,
  apiErrorUserMessage,
  userFacingErrorMessage,
} from './errors-core';
export type { ApiErrorKind } from './errors-core';
