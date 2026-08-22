import * as vscode from 'vscode';
import * as path from 'path';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { normalizeGitRemote, normalizeGitUrl } from '@cpf23333-forgejo-toolkit/shared/git/url';
import type { ConfigManager } from '../config';
import { ForgejoClient } from '../api/client';
import { logger } from '../logger';
import {
  addRemote,
  getCurrentBranch,
  getRemoteUrl,
  getUpstreamBranch,
  isGitRepository,
  pushBranch,
} from '../worktree/gitOperations';

function findInstanceForRemote(remoteUrl: string, instances: ForgejoInstance[]): ForgejoInstance | undefined {
  const remoteInfo = normalizeGitRemote(remoteUrl);
  if (!remoteInfo) {
    return undefined;
  }
  for (const instance of instances) {
    let instanceHostPath: string;
    try {
      const parsed = new URL(instance.url);
      instanceHostPath = normalizeGitUrl(`${parsed.host}${parsed.pathname}`);
    } catch {
      continue;
    }
    if (remoteInfo.normalized === instanceHostPath || remoteInfo.normalized.startsWith(`${instanceHostPath}/`)) {
      return instance;
    }
  }
  return undefined;
}

async function pickTargetFolder(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const gitFolders: vscode.WorkspaceFolder[] = [];
  for (const folder of folders) {
    if (await isGitRepository(folder.uri.fsPath)) {
      gitFolders.push(folder);
    }
  }
  if (gitFolders.length === 0) {
    vscode.window.showErrorMessage(
      vscode.l10n.t(
        'No git repository found in the current workspace. Open a folder containing a git repository to publish it.',
      ),
    );
    return undefined;
  }
  if (gitFolders.length === 1) {
    return gitFolders[0].uri.fsPath;
  }
  const picked = await vscode.window.showQuickPick(
    gitFolders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    { placeHolder: vscode.l10n.t('Select a folder to publish') },
  );
  return picked?.folder.uri.fsPath;
}

async function pickInstance(config: ConfigManager): Promise<ForgejoInstance | undefined> {
  const instances = config.getInstances();
  if (instances.length === 0) {
    const openSettings = vscode.l10n.t('Open Settings');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('No Forgejo instances configured. Add an instance in Settings first.'),
      openSettings,
    );
    if (choice === openSettings) {
      await vscode.commands.executeCommand('forgejoToolkit.openSettings');
    }
    return undefined;
  }
  if (instances.length === 1) {
    return instances[0];
  }
  const picked = await vscode.window.showQuickPick(
    instances.map((instance) => ({
      label: instance.name,
      description: instance.url,
      detail: instance.username ? `@${instance.username}` : undefined,
      instance,
    })),
    { placeHolder: vscode.l10n.t('Select a Forgejo instance to publish to') },
  );
  return picked?.instance;
}

async function publishNewRepository(config: ConfigManager, folder: string): Promise<void> {
  const instance = await pickInstance(config);
  if (!instance) {
    return;
  }

  const repoName = await vscode.window.showInputBox({
    title: vscode.l10n.t('Repository name'),
    value: path.basename(folder),
    validateInput: (value) => (value.trim() ? undefined : vscode.l10n.t('Repository name cannot be empty')),
  });
  if (!repoName) {
    return;
  }

  const visibility = await vscode.window.showQuickPick(
    [
      { label: vscode.l10n.t('Private'), value: true },
      { label: vscode.l10n.t('Public'), value: false },
    ],
    { placeHolder: vscode.l10n.t('Repository visibility') },
  );
  if (!visibility) {
    return;
  }

  const name = repoName.trim();
  const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
  let repository;
  try {
    repository = await client.createUserRepo({ name, private: visibility.value, auto_init: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[publishToForgejo] failed to create repository: ${message}`);
    if (/Forgejo API error (409|422)\b/.test(message)) {
      vscode.window.showErrorMessage(
        vscode.l10n.t('A repository named "{0}" already exists on {1}. Choose a different name.', name, instance.name),
      );
    } else {
      vscode.window.showErrorMessage(vscode.l10n.t('Failed to create repository: {0}', message));
    }
    return;
  }

  const cloneUrl = repository.clone_url;
  if (!cloneUrl) {
    vscode.window.showErrorMessage(vscode.l10n.t('The created repository did not return a clone URL'));
    return;
  }
  await addRemote(folder, 'origin', cloneUrl);

  const repoLabel = repository.full_name ?? name;
  const branch = await getCurrentBranch(folder);
  if (!branch) {
    vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Repository {0} created on {1}. No branch is checked out, so nothing was pushed.',
        repoLabel,
        instance.name,
      ),
    );
    return;
  }
  await pushBranch(folder, 'origin', branch, instance.token, true);

  const openInBrowser = vscode.l10n.t('Open in Browser');
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t('Published {0} to {1}', repoLabel, instance.name),
    openInBrowser,
  );
  if (choice === openInBrowser && repository.html_url) {
    await vscode.env.openExternal(vscode.Uri.parse(repository.html_url));
  }
}

async function pushToExistingRemote(config: ConfigManager, folder: string, remoteUrl: string): Promise<void> {
  const instance = findInstanceForRemote(remoteUrl, config.getInstances());
  if (!instance) {
    vscode.window.showWarningMessage(
      vscode.l10n.t('The origin remote does not match any configured Forgejo instance: {0}', remoteUrl),
    );
    return;
  }

  const branch = await getCurrentBranch(folder);
  if (!branch) {
    vscode.window.showErrorMessage(vscode.l10n.t('Unable to determine the current branch. Is HEAD detached?'));
    return;
  }

  const upstream = await getUpstreamBranch(folder);
  await pushBranch(folder, 'origin', branch, instance.token, !upstream);
  if (upstream) {
    vscode.window.showInformationMessage(vscode.l10n.t('Pushed {0} to origin', branch));
  } else {
    vscode.window.showInformationMessage(vscode.l10n.t('Published branch {0} to {1}', branch, instance.name));
  }
}

export async function publishToForgejo(config: ConfigManager): Promise<void> {
  const folder = await pickTargetFolder();
  if (!folder) {
    return;
  }
  const remoteUrl = await getRemoteUrl(folder);
  if (!remoteUrl) {
    await publishNewRepository(config, folder);
  } else {
    await pushToExistingRemote(config, folder, remoteUrl);
  }
}
