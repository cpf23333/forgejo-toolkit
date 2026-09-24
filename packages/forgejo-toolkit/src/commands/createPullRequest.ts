import * as vscode from 'vscode';
import type { ConfigManager } from '../config';
import type { ForgejoToolkitViewProvider } from '../webview/viewProvider';
import { ForgejoClient } from '../api/client';
import { logger } from '../logger';
import { userFacingErrorMessage } from '../api/errors';
import {
  detectLinkedRepository,
  getAheadCount,
  getCurrentBranch,
  getRemotePushUrls,
  getUpstreamBranch,
  pushBranch,
  resolveUpstreamRemote,
} from '../worktree/gitOperations';
import { findInstanceForRemote } from './publish';

export interface CreatePrFromCurrentBranchArgs {
  /** When set, the command opens the existing pull request instead of starting the create flow. */
  index?: number;
}

export async function createPrFromCurrentBranch(
  config: ConfigManager,
  viewProvider: ForgejoToolkitViewProvider,
  args?: CreatePrFromCurrentBranchArgs,
): Promise<void> {
  // Interactive command: when several workspace repositories match and the
  // active editor does not attribute one, let the user pick.
  const linked = await detectLinkedRepository(config.getInstances(), { pickOnAmbiguity: true });
  if (!linked) {
    vscode.window.showInformationMessage(vscode.l10n.t('No linked Forgejo repository found for the current workspace'));
    return;
  }
  const branch = await getCurrentBranch(linked.localPath);
  if (!branch) {
    vscode.window.showErrorMessage(vscode.l10n.t('Unable to determine the current branch. Is HEAD detached?'));
    return;
  }
  const instance = config.getInstances().find((i) => i.id === linked.instanceId);
  if (!instance) {
    vscode.window.showErrorMessage(vscode.l10n.t('Forgejo instance not found'));
    return;
  }

  if (typeof args?.index === 'number') {
    await vscode.commands.executeCommand('forgejoToolkitView.focus');
    viewProvider.openPullRequestDetail({
      instanceId: linked.instanceId,
      owner: linked.owner,
      repo: linked.repo,
      index: args.index,
    });
    return;
  }

  // The status bar hides this command on the default branch, but the command
  // palette does not — block creating a PR from the default branch here too.
  // When the lookup fails (offline, API error), degrade gracefully and skip
  // the guard instead of crashing the command with a raw error.
  const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
  let defaultBranch: string | undefined;
  try {
    const detail = await client.getRepoDetail(linked.owner, linked.repo);
    defaultBranch = detail.repository.default_branch;
  } catch (error) {
    const err = userFacingErrorMessage(error);
    logger.error(`[createPrFromCurrentBranch] failed to resolve the default branch, skipping the guard: ${err}`);
  }
  if (defaultBranch && branch === defaultBranch) {
    vscode.window.showInformationMessage(
      vscode.l10n.t('Branch "{0}" is the default branch. Switch to another branch to create a pull request.', branch),
    );
    return;
  }

  // The PR head must exist on the remote under the upstream's branch name,
  // which can differ from the local branch name (e.g. upstream origin/rename).
  const upstream = await getUpstreamBranch(linked.localPath);
  let head = branch;
  let pushRemote = 'origin';
  let pushRefspec = branch;
  let setUpstream = true;
  let needsPush = !upstream;
  if (upstream) {
    // Resolve the remote from git's own configuration rather than by splitting
    // `@{upstream}` at the first `/`: `isSafeRemoteName` deliberately allows a
    // slash inside a remote name (`my/fork`), and the naive split turned
    // `my/fork/feature` into remote `my`, so the push (and the PR head) named a
    // remote that does not exist and failed with a misleading message.
    const upstreamRef = await resolveUpstreamRemote(linked.localPath);
    if (!upstreamRef) {
      // An upstream git cannot attribute to a configured remote cannot be
      // pushed to or prefilled as the PR head; say so instead of inventing one.
      logger.error(
        `[createPrFromCurrentBranch] the upstream "${upstream}" does not name a configured remote in ${linked.localPath}`,
      );
      vscode.window.showErrorMessage(
        vscode.l10n.t(
          'The upstream branch "{0}" does not name a configured git remote in this repository, so the pull request head could not be resolved',
          upstream,
        ),
      );
      return;
    }
    pushRemote = upstreamRef.remote;
    head = upstreamRef.branch;
    pushRefspec = head === branch ? branch : `${branch}:${head}`;
    setUpstream = false;
    const ahead = await getAheadCount(linked.localPath);
    // Undefined ahead means the upstream ref cannot be resolved (e.g. the
    // remote branch was deleted) — push then, so the PR head exists remotely.
    needsPush = ahead === undefined || ahead > 0;
  }

  if (needsPush) {
    // The push authenticates with the instance token via an Authorization
    // header, so it must only go to remotes owned by the linked instance. An
    // upstream pointing at another host (e.g. a mirror) would leak it. The
    // *push* targets are resolved here because `git remote get-url` reports
    // only the fetch URL and would miss `remote.<name>.pushurl` /
    // `url.<base>.pushInsteadOf` rewrites; pushBranch re-checks immediately
    // before pushing as well.
    const pushUrls = await getRemotePushUrls(linked.localPath, pushRemote);
    let pushToken: string | undefined = instance.token;
    if (pushUrls === undefined) {
      // The push target cannot be resolved, so ownership cannot be verified —
      // push without the token and let git fail naturally if auth is required.
      pushToken = undefined;
    } else if (pushUrls.some((url) => !findInstanceForRemote(url, [instance]))) {
      logger.error(
        `[createPrFromCurrentBranch] a push target of remote "${pushRemote}" does not belong to instance ${instance.url}; push aborted to avoid leaking the access token`,
      );
      vscode.window.showErrorMessage(
        vscode.l10n.t(
          'The upstream remote "{0}" does not belong to the linked Forgejo instance. Push aborted to avoid sending your access token to another host.',
          pushRemote,
        ),
      );
      return;
    }
    const push = vscode.l10n.t('Push');
    const choice = await vscode.window.showWarningMessage(
      upstream
        ? vscode.l10n.t('Branch "{0}" has unpushed commits. Push it now?', branch)
        : vscode.l10n.t('Branch "{0}" has not been pushed. Push it now?', branch),
      { modal: true },
      push,
    );
    if (choice !== push) {
      return;
    }
    try {
      await pushBranch(linked.localPath, pushRemote, pushRefspec, pushToken, setUpstream, instance.url);
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`[createPrFromCurrentBranch] failed to push branch: ${err}`);
      vscode.window.showErrorMessage(vscode.l10n.t('Failed to push branch {0}: {1}', branch, err));
      return;
    }
  }

  await vscode.commands.executeCommand('forgejoToolkitView.focus');
  viewProvider.openCreatePullRequest({
    instanceId: linked.instanceId,
    owner: linked.owner,
    repo: linked.repo,
    head,
  });
}
