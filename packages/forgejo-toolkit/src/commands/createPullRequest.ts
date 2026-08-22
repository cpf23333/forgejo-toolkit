import * as vscode from 'vscode';
import type { ConfigManager } from '../config';
import type { ForgejoToolkitViewProvider } from '../webview/viewProvider';
import { logger } from '../logger';
import { detectLinkedRepository, getCurrentBranch, getUpstreamBranch, pushBranch } from '../worktree/gitOperations';

export interface CreatePrFromCurrentBranchArgs {
  /** When set, the command opens the existing pull request instead of starting the create flow. */
  index?: number;
}

export async function createPrFromCurrentBranch(
  config: ConfigManager,
  viewProvider: ForgejoToolkitViewProvider,
  args?: CreatePrFromCurrentBranchArgs,
): Promise<void> {
  const linked = await detectLinkedRepository(config.getInstances());
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

  const upstream = await getUpstreamBranch(linked.localPath);
  if (!upstream) {
    const push = vscode.l10n.t('Push');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('Branch "{0}" has not been pushed. Push it now?', branch),
      { modal: true },
      push,
    );
    if (choice !== push) {
      return;
    }
    try {
      await pushBranch(linked.localPath, 'origin', branch, instance.token, true);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
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
    head: branch,
  });
}
