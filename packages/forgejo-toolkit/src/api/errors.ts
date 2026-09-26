import * as vscode from 'vscode';
import { setApiErrorTranslate } from './errors-core';

// Extension-host entry point for the API error helpers: same exports as
// errors-core, but localized through vscode.l10n. Headless consumers (the
// bundled MCP server) import errors-core directly instead, keeping the
// `vscode` module out of their dependency graph.
setApiErrorTranslate(vscode.l10n.t);

// The structured failure the shared client throws: `toApiError` reads its
// `status`/`body` fields instead of re-parsing the message. Re-exported so host
// code that classifies a caught error (e.g. commands/publish.ts) has one import
// for the whole API-error surface.
export { RequestError } from '@cpf23333-forgejo-toolkit/shared/request';

export {
  ApiError,
  toApiError,
  extractApiErrorMessage,
  apiErrorUserMessage,
  requestContextFor,
  requestResourceFor,
  userFacingErrorMessage,
} from './errors-core';
export type { ApiErrorKind, RequestResource } from './errors-core';
