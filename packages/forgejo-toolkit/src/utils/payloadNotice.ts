import * as vscode from 'vscode';

/**
 * The notice served in place of a file whose payload Forgejo withheld.
 *
 * The contents API omits the payload of files above `[api] DEFAULT_MAX_BLOB_SIZE`
 * (10 MiB by default) and reports the real `size` instead of failing, so an empty
 * buffer would render the file as empty with no explanation. A real empty file
 * reports size 0 and gets no notice.
 */
export function missingPayloadNotice(size: number | undefined): string | undefined {
  if (!size || size <= 0) {
    return undefined;
  }
  const mib = (size / (1024 * 1024)).toFixed(1);
  return vscode.l10n.t(
    'Forgejo did not return this file ({0} MiB): the contents API omits payloads above its size limit. Open the file in the browser to read it.',
    mib,
  );
}
