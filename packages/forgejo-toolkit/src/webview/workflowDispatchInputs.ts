/**
 * The `on.workflow_dispatch.inputs` a workflow file declares, read host-side for
 * the dispatch form.
 *
 * Forgejo's own dispatch form lists only each input's `description`, never its
 * name, and the extension's form used to ask for raw key/value pairs — so the
 * user had to know which names a workflow declares. The form now renders one
 * control per declared input, and this module is what reads that declaration.
 *
 * Parsing happens in the extension host, not in the webview: the webview bundle
 * must not grow a YAML parser, so the descriptors travel through the ordinary
 * message layer (`getWorkflowDispatchInputs` → `workflowDispatchInputs`). That
 * is also why `yaml` is a runtime dependency of the extension rather than of the
 * webview entry.
 *
 * Every failure here is a *fallback*, never a dead end: a file that cannot be
 * fetched, that is not a mapping, or that declares `inputs` in a shape this
 * parser does not understand answers `unreadable`, and the form keeps the raw
 * key/value editor.
 */
import * as vscode from 'vscode';
import { parse } from 'yaml';
import type { FileContentResult } from '../api/client';
import { toApiError } from '../api/errors';
import { isSafeRepoPath } from './repoIdentity';

/**
 * The directories Forgejo reads workflow files from, in the order they are
 * tried. `.forgejo/workflows` is the current location; `.gitea/workflows` and
 * `.github/workflows` are the compatibility paths Forgejo still reads, so a
 * repository that has not migrated must not lose its declared inputs.
 */
export const WORKFLOW_DIRECTORIES: readonly string[] = ['.forgejo/workflows', '.gitea/workflows', '.github/workflows'];

/**
 * The control the form renders for an input. The declared type is normalized to
 * these three: `choice` only when the declaration also carries usable `options`
 * (a `choice` without them would be a select with nothing to pick), and
 * everything else — `number`, `environment`, a type added by a newer Forgejo,
 * a typo — becomes a text field rather than a broken control.
 */
export type WorkflowDispatchInputType = 'string' | 'boolean' | 'choice';

export interface WorkflowDispatchInputDescriptor {
  name: string;
  type: WorkflowDispatchInputType;
  /** The `type` exactly as the file spells it, for the form's help text. */
  declaredType: string;
  description?: string;
  /** The declared default, stringified; absent when the file declares none. */
  default?: string;
  required: boolean;
  options?: string[];
}

export type WorkflowDispatchInputsParseResult =
  | { status: 'ok'; inputs: WorkflowDispatchInputDescriptor[] }
  | { status: 'no-inputs' }
  | { status: 'malformed'; error: string };

export type WorkflowDispatchInputsReadResult =
  | { status: 'ok'; path: string; inputs: WorkflowDispatchInputDescriptor[] }
  | { status: 'no-inputs'; path: string }
  | { status: 'unreadable'; path?: string; error: string };

/**
 * The slice of `ForgejoClient` this module needs. Structural on purpose: the
 * unit tests drive it with a plain object, and the handler only ever passes a
 * real client.
 */
export interface WorkflowFileReader {
  getFileContentResult(owner: string, repo: string, filepath: string, ref?: string): Promise<FileContentResult>;
}

/**
 * The repository paths a workflow filename may live at, in the order they are
 * tried; empty when the filename is unsafe to interpolate into the contents
 * route (the same rule the file browser's paths go through).
 *
 * A filename may carry a subdirectory (`nightly/ci.yml`): Forgejo dispatches by
 * filename and reads the workflow directories recursively, so the value is
 * joined under each directory rather than treated as a bare basename.
 */
export function workflowFileCandidates(workflowFilename: string): string[] {
  const name = workflowFilename.trim();
  if (!name || !isSafeRepoPath(name)) {
    return [];
  }
  return WORKFLOW_DIRECTORIES.map((directory) => `${directory}/${name}`);
}

/**
 * Reads the workflow file at the first candidate path that holds a regular file
 * and returns the inputs it declares. A path that answers anything but file
 * content (a directory, a symlink, a payload above the instance's limit) is
 * treated as a miss and the next directory is tried, because the workflow the
 * user selected may live in one of the compatibility paths instead.
 */
export async function readWorkflowDispatchInputs(
  client: WorkflowFileReader,
  owner: string,
  repo: string,
  workflowFilename: string,
  ref: string,
): Promise<WorkflowDispatchInputsReadResult> {
  const candidates = workflowFileCandidates(workflowFilename);
  if (candidates.length === 0) {
    return { status: 'unreadable', error: vscode.l10n.t('The request could not be completed') };
  }

  let lastError: string | undefined;
  for (const path of candidates) {
    let content: FileContentResult;
    try {
      content = await client.getFileContentResult(owner, repo, path, ref);
    } catch (error) {
      // A 404 is the ordinary "this candidate does not exist" answer of a file
      // that lives in one of the other directories, so it is not an error to
      // report; anything else (a token without access, an outage) is, and is
      // remembered as the reason if no candidate turns out to hold the file.
      const apiError = toApiError(error);
      if (apiError.kind !== 'http' || apiError.status !== 404) {
        lastError = apiError.userMessage;
      }
      continue;
    }
    if (content.kind === 'withheld') {
      // The file is there but Forgejo did not send its payload (it is above the
      // instance's contents API limit). Looking in the other directories would
      // report "no workflow file", which is not what happened.
      return {
        status: 'unreadable',
        path,
        error: vscode.l10n.t(
          'Forgejo did not return the contents of "{0}": the file is larger than this instance returns through the contents API.',
          path,
        ),
      };
    }
    if (content.kind !== 'file') {
      // A directory, a symlink, a submodule: not a workflow file, so the next
      // directory may still hold the real one.
      continue;
    }
    const parsed = parseWorkflowDispatchInputs(content.text);
    if (parsed.status === 'malformed') {
      // The file exists and is the one being dispatched, so a shape this parser
      // refuses is reported instead of silently looking in another directory.
      return { status: 'unreadable', path, error: parsed.error };
    }
    if (parsed.status === 'no-inputs') {
      return { status: 'no-inputs', path };
    }
    return { status: 'ok', path, inputs: parsed.inputs };
  }

  return {
    status: 'unreadable',
    // The API's own sentence ("not found") is more precise about *why* a
    // candidate failed, so it wins when one was seen; otherwise name the paths
    // that were searched, with `WORKFLOW_DIRECTORIES` as the single source.
    error:
      lastError ??
      vscode.l10n.t(
        'No workflow file named "{0}" was found in {1}.',
        workflowFilename.trim(),
        WORKFLOW_DIRECTORIES.join(', '),
      ),
  };
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The inputs declared by `on.workflow_dispatch.inputs`, or the reason there are
 * none to render.
 *
 * `no-inputs` is the ordinary "this workflow takes no inputs" answer (a missing
 * `on:`/`workflow_dispatch:`, `on: push`, an empty `inputs:`), and it still
 * leaves the user the raw editor. `malformed` is reserved for a document whose
 * shape this parser refuses to read *as inputs*: invalid YAML, a top level that
 * is not a mapping, `inputs` that is not a mapping of input names, an input
 * declaration that is not a mapping, or a `default` that is not a scalar. In
 * those cases guessing would silently change what the dispatch sends, so the
 * form falls back instead.
 */
export function parseWorkflowDispatchInputs(text: string): WorkflowDispatchInputsParseResult {
  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    return {
      status: 'malformed',
      error: vscode.l10n.t(
        'The workflow file is not valid YAML: {0}',
        error instanceof Error ? error.message : String(error),
      ),
    };
  }

  if (!isMapping(document)) {
    return {
      status: 'malformed',
      error: vscode.l10n.t('The workflow file does not contain a YAML mapping of workflow keys.'),
    };
  }

  // `on:` may be a string (`on: push`) or a sequence; neither can declare
  // inputs, and YAML 1.2 keeps `on` a plain string key, so no boolean-key
  // special case is needed here.
  if (!isMapping(document.on)) {
    return { status: 'no-inputs' };
  }
  if (!isMapping(document.on.workflow_dispatch)) {
    return { status: 'no-inputs' };
  }
  const declared = document.on.workflow_dispatch.inputs;
  if (declared === undefined || declared === null) {
    return { status: 'no-inputs' };
  }
  if (!isMapping(declared)) {
    return {
      status: 'malformed',
      error: vscode.l10n.t('`on.workflow_dispatch.inputs` is not a mapping of input names.'),
    };
  }

  const inputs: WorkflowDispatchInputDescriptor[] = [];
  for (const [name, declaration] of Object.entries(declared)) {
    if (!isMapping(declaration)) {
      return {
        status: 'malformed',
        error: vscode.l10n.t('The workflow input "{0}" is not a mapping of input options.', name),
      };
    }
    const descriptor = describeInput(name, declaration);
    if ('error' in descriptor) {
      return { status: 'malformed', error: descriptor.error };
    }
    inputs.push(descriptor);
  }

  return inputs.length > 0 ? { status: 'ok', inputs } : { status: 'no-inputs' };
}

function describeInput(
  name: string,
  declaration: Record<string, unknown>,
): WorkflowDispatchInputDescriptor | { error: string } {
  const declaredType =
    typeof declaration.type === 'string' && declaration.type.trim() !== '' ? declaration.type.trim() : 'string';
  const options = readOptions(declaration.options);

  let type: WorkflowDispatchInputType = 'string';
  if (declaredType === 'boolean') {
    type = 'boolean';
  } else if (declaredType === 'choice' && options !== undefined && options.length > 0) {
    type = 'choice';
  }

  const defaultValue = readDefault(declaration.default);
  if (!defaultValue.ok) {
    return {
      error: vscode.l10n.t('The default value of the workflow input "{0}" is not a scalar.', name),
    };
  }

  const description = typeof declaration.description === 'string' ? declaration.description : undefined;

  return {
    name,
    type,
    declaredType,
    required: readRequired(declaration.required),
    ...(description !== undefined ? { description } : {}),
    ...(defaultValue.value !== undefined ? { default: defaultValue.value } : {}),
    // Only a rendered select uses `options`; a declaration whose type became a
    // text field keeps its declared type but not a list nothing reads.
    ...(type === 'choice' && options !== undefined ? { options } : {}),
  };
}

type DefaultReadResult = { ok: true; value?: string } | { ok: false };

/**
 * A declaration's `default` as the string the dispatch sends. `{ ok: true }`
 * without a value means "no default"; `{ ok: false }` means the value is not a
 * scalar, which the caller turns into a refusal — a mapping or a list here would
 * have to be guessed at, and the guess would change what gets sent.
 */
function readDefault(value: unknown): DefaultReadResult {
  if (value === undefined || value === null) {
    return { ok: true };
  }
  if (typeof value === 'string') {
    return { ok: true, value };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { ok: true, value: String(value) } : { ok: true };
  }
  if (typeof value === 'boolean') {
    return { ok: true, value: value ? 'true' : 'false' };
  }
  return { ok: false };
}

/**
 * `options` for a `choice`. A list of scalars becomes the select's entries; an
 * empty list, a non-list, or a list holding a mapping answers `undefined`, and
 * the caller renders a text field instead.
 */
function readOptions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const options: string[] = [];
  for (const option of value) {
    if (typeof option === 'string') {
      options.push(option);
    } else if (typeof option === 'number' && Number.isFinite(option)) {
      options.push(String(option));
    } else if (typeof option === 'boolean') {
      options.push(option ? 'true' : 'false');
    } else {
      return undefined;
    }
  }
  return options;
}

/**
 * `required` as a boolean. A YAML 1.2 document spells it `true`/`false`; a file
 * written with YAML 1.1 spellings (`yes`/`no`, `on`/`off`) is honored too, since
 * this flag only decides whether an empty field blocks the submit — being
 * forgiving here can never change what a completed form sends.
 */
function readRequired(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return ['true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
  return false;
}
