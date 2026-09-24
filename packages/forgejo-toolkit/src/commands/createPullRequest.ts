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
  isSafeRemoteName,
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

  // Which branch is published, and where.
  //
  // The rule is: the published branch is always the local branch, under its own
  // name, and the pull request head is that published branch. Git's
  // `branch.<name>.merge` is the branch the local branch was *created from* —
  // the everyday `git checkout -b fix origin/main` records `remote=origin`,
  // `merge=refs/heads/main` — not a branch the user asked to publish to. Using
  // it as the push target ran `git push origin fix:main`, which fast-forwards
  // the shared base branch with work in progress (an explicit refspec is not
  // covered by git's own `push.default=simple` refusal, so git never gets the
  // chance to object) and then prefilled the pull request form with
  // `head=main`. A tracked branch whose name differs from the local branch is
  // therefore never a push target: the local branch is published under its own
  // name on the same remote, after a confirmation that names the destination,
  // and `-u` re-points the branch's upstream at the branch actually published.
  const upstream = await getUpstreamBranch(linked.localPath);
  let pushRemote = 'origin';
  let setUpstream = true;
  let needsPush = !upstream;
  // Set only when the tracked upstream names a *different* branch; the
  // confirmation then says why that branch is not the push target.
  let trackedBranchDiffers: string | undefined;
  if (upstream) {
    // Resolve the remote from git's own configuration rather than by splitting
    // `@{upstream}` at the first `/`: `isSafeRemoteName` deliberately allows a
    // slash inside a remote name (`my/fork`), and the naive split turned
    // `my/fork/feature` into remote `my`, so the push named a remote that does
    // not exist and failed with a misleading message.
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
    // A local upstream (`branch.<name>.remote = .`) names this very repository,
    // not a remote, so there is no remote branch to publish to; git would run
    // the push against the local repository instead. Note that `.` passes
    // isSafeRemoteName, so it needs its own check.
    if (upstreamRef.remote === '.') {
      logger.error(
        `[createPrFromCurrentBranch] the upstream of "${branch}" names the local repository, which is not a publish target`,
      );
      vscode.window.showErrorMessage(
        vscode.l10n.t(
          'The upstream remote is the local repository ("{0}"), which cannot hold a pull request branch. Point the branch at a real remote (for example "origin") and try again.',
          upstreamRef.remote,
        ),
      );
      return;
    }
    // An option-like remote name (`--force`, `--upload-pack=…`) is read by git
    // as an option rather than as a remote; refuse it here so the failure names
    // the real problem instead of surfacing as a failed push.
    if (!isSafeRemoteName(upstreamRef.remote)) {
      logger.error(`[createPrFromCurrentBranch] the upstream remote of "${branch}" is not a usable git remote name`);
      vscode.window.showErrorMessage(
        vscode.l10n.t(
          'The upstream remote name "{0}" is not a usable git remote name, so the push was aborted. Point the branch at a real remote (for example "origin") and try again.',
          upstreamRef.remote,
        ),
      );
      return;
    }
    pushRemote = upstreamRef.remote;
    if (upstreamRef.branch === branch) {
      setUpstream = false;
      const ahead = await getAheadCount(linked.localPath);
      // Undefined ahead means the upstream ref cannot be resolved (e.g. the
      // remote branch was deleted) — push then, so the PR head exists remotely.
      needsPush = ahead === undefined || ahead > 0;
    } else {
      // The tracked branch is a different branch, so its state says nothing
      // about <remote>/<branch>: publish unconditionally (a push with nothing
      // to do is a no-op), so the head exists on the remote afterwards.
      trackedBranchDiffers = upstreamRef.branch;
      needsPush = true;
    }
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
    // The confirmation always names the remote and the branch the commits would
    // land on, so the user can tell where they are going before agreeing.
    const message = trackedBranchDiffers
      ? vscode.l10n.t(
          'Branch "{0}" tracks {1}/{2}. Push it to {3}/{0} instead?',
          branch,
          pushRemote,
          trackedBranchDiffers,
          pushRemote,
        )
      : upstream
        ? vscode.l10n.t('Branch "{0}" has unpushed commits. Push it to {1}/{2} now?', branch, pushRemote, branch)
        : vscode.l10n.t('Branch "{0}" has not been pushed. Push it to {1}/{2} now?', branch, pushRemote, branch);
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, push);
    if (choice !== push) {
      return;
    }
    try {
      // The refspec is the local branch name alone: it publishes <branch> as
      // <remote>/<branch>, never as a branch it merely tracks.
      await pushBranch(linked.localPath, pushRemote, branch, pushToken, setUpstream, instance.url);
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
    // The head is the branch that was just published, so it exists on the
    // remote under this name; the default-branch guard above compares this same
    // local branch, which is what makes the guard sufficient.
    head: branch,
  });
}
