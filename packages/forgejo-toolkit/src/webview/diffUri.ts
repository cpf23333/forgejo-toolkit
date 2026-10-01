import * as vscode from 'vscode';
import { FORGEJO_PR_SCHEME } from '../prFileSystemProvider';

/**
 * The URI of one side of one changed file's diff.
 *
 * The `forgejo-pr` scheme is the extension's own diff-document scheme: its file
 * system provider fetches the blob at `ref` from Forgejo, and
 * `parseForgejoPrUri` is the strict reader every consumer uses. Two of these
 * (base and head) are what `vscode.diff` opens.
 *
 * It lives here rather than inline in the two callers that need it — the
 * dashboard's "open this file's diff" handler (`viewProvider`) and the AI
 * pre-review panel's per-candidate link — so the path shape and the query the
 * parser reads cannot drift between them. A URI built differently would still
 * look like a diff URI and would fail deep inside the provider instead of here.
 */
export function buildForgejoPrDiffUri(input: {
  instanceId: string;
  owner: string;
  repo: string;
  index: number;
  /** The commit sha (or ref) this side shows. */
  ref: string;
  filepath: string;
  isBase: boolean;
  status?: string;
}): vscode.Uri {
  return vscode.Uri.from({
    scheme: FORGEJO_PR_SCHEME,
    path: `/${input.instanceId}/${input.owner}/${input.repo}/${input.filepath}`,
    query: JSON.stringify({
      index: input.index,
      ref: input.ref,
      isBase: input.isBase,
      status: input.status,
    }),
  });
}
