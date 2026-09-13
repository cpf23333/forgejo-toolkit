import * as vscode from 'vscode';
import * as path from 'path';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { normalizeGitRemote } from '@cpf23333-forgejo-toolkit/shared/git/url';
import type { ConfigManager } from '../config';
import { ForgejoClient } from '../api/client';
// Single implementation lives in the shared API error helpers; re-exported
// here for existing importers.
import { extractApiErrorMessage, userFacingErrorMessage } from '../api/errors';
import { logger, showErrorWithLog } from '../logger';

export { extractApiErrorMessage };
import type { ForgejoToolkitViewProvider } from '../webview/viewProvider';
import {
  addRemote,
  getCurrentBranch,
  getCurrentCommitSha,
  getRemoteUrl,
  getUpstreamBranch,
  isGitRepository,
  pushBranch,
  remoteMatchesInstance,
} from '../worktree/gitOperations';

export function findInstanceForRemote(remoteUrl: string, instances: ForgejoInstance[]): ForgejoInstance | undefined {
  return instances.find((instance) => remoteMatchesInstance(remoteUrl, instance.url));
}

const REPO_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;

/**
 * Client-side pre-check for Forgejo repository names, so an invalid name is
 * rejected before a half-created remote repository can happen. Returns an
 * error message, or undefined when the name is valid.
 */
export function validateRepoName(value: string): string | undefined {
  const name = value.trim();
  if (!name) {
    return vscode.l10n.t('Repository name cannot be empty');
  }
  if (name.startsWith('.')) {
    return vscode.l10n.t('Repository name cannot start with "."');
  }
  if (!REPO_NAME_PATTERN.test(name)) {
    return vscode.l10n.t('Repository name may only contain letters, digits, ".", "_" and "-"');
  }
  return undefined;
}

/** True when the error is a 422 whose body reports a name conflict. */
function isNameConflictError(message: string): boolean {
  if (/Forgejo API error 409\b/.test(message)) {
    return true;
  }
  return /Forgejo API error 422\b/.test(message) && /already exists/i.test(message);
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

async function publishNewRepository(
  config: ConfigManager,
  folder: string,
  viewProvider?: ForgejoToolkitViewProvider,
): Promise<void> {
  // Check for commits before anything else: pushing an empty repository is
  // impossible, and detecting it here avoids leaving a half-created remote
  // repository behind (the old flow created the remote first, then gave up
  // with a misleading "No branch is checked out" message).
  const headSha = await getCurrentCommitSha(folder);
  if (!headSha) {
    vscode.window.showErrorMessage(
      vscode.l10n.t('The repository has no commits yet. Make a commit before publishing.'),
    );
    return;
  }

  const instance = await pickInstance(config);
  if (!instance) {
    return;
  }

  const repoName = await vscode.window.showInputBox({
    title: vscode.l10n.t('Repository name'),
    value: path.basename(folder),
    validateInput: validateRepoName,
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
    repository = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Creating repository {0} on {1}…', name, instance.name),
      },
      () => client.createUserRepo({ name, private: visibility.value, auto_init: false }),
    );
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[publishToForgejo] failed to create repository: ${rawMessage}`);
    if (isNameConflictError(rawMessage)) {
      vscode.window.showErrorMessage(
        vscode.l10n.t('A repository named "{0}" already exists on {1}. Choose a different name.', name, instance.name),
      );
    } else {
      // 422s that are not name conflicts surface the server's validation
      // message (localized via ApiError) instead of raw JSON.
      void showErrorWithLog(vscode.l10n.t('Failed to create repository: {0}', userFacingErrorMessage(error)));
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
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Pushing {0} to {1}…', branch, instance.name),
    },
    () => pushBranch(folder, 'origin', branch, instance.token, true, instance.url),
  );
  viewProvider?.refresh();

  const openInBrowser = vscode.l10n.t('Open in Browser');
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t('Published {0} to {1}', repoLabel, instance.name),
    openInBrowser,
  );
  if (choice === openInBrowser && repository.html_url) {
    await vscode.env.openExternal(vscode.Uri.parse(repository.html_url));
  }
}

/**
 * Resolve the account to push with when the origin remote matches several
 * configured instances (multiple accounts on the same host). Prefers the
 * account whose username matches the remote owner; when that cannot decide,
 * asks the user instead of silently pushing with a possibly wrong token.
 */
async function pickInstanceForRemote(
  remoteUrl: string,
  matched: ForgejoInstance[],
): Promise<ForgejoInstance | undefined> {
  const remoteInfo = normalizeGitRemote(remoteUrl);
  const ownMatches = remoteInfo
    ? matched.filter(
        (instance) => instance.username && instance.username.toLowerCase() === remoteInfo.owner.toLowerCase(),
      )
    : [];
  if (ownMatches.length === 1) {
    logger.info(
      `[publishToForgejo] ${matched.length} accounts match ${remoteUrl}; using ${ownMatches[0].id} (owner match)`,
    );
    return ownMatches[0];
  }
  const picked = await vscode.window.showQuickPick(
    matched.map((instance) => ({
      label: instance.name,
      description: instance.url,
      detail: instance.username ? `@${instance.username}` : undefined,
      instance,
    })),
    { placeHolder: vscode.l10n.t('Multiple accounts match this remote. Select the account to push with') },
  );
  return picked?.instance;
}

async function pushToExistingRemote(
  config: ConfigManager,
  folder: string,
  remoteUrl: string,
  viewProvider?: ForgejoToolkitViewProvider,
): Promise<void> {
  const matched = config.getInstances().filter((instance) => remoteMatchesInstance(remoteUrl, instance.url));
  if (matched.length === 0) {
    vscode.window.showWarningMessage(
      vscode.l10n.t('The origin remote does not match any configured Forgejo instance: {0}', remoteUrl),
    );
    return;
  }
  const instance = matched.length === 1 ? matched[0] : await pickInstanceForRemote(remoteUrl, matched);
  if (!instance) {
    return;
  }

  const branch = await getCurrentBranch(folder);
  if (!branch) {
    vscode.window.showErrorMessage(vscode.l10n.t('Unable to determine the current branch. Is HEAD detached?'));
    return;
  }

  const upstream = await getUpstreamBranch(folder);
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Pushing {0} to {1}…', branch, instance.name),
    },
    () => pushBranch(folder, 'origin', branch, instance.token, !upstream, instance.url),
  );
  viewProvider?.refresh();
  if (upstream) {
    vscode.window.showInformationMessage(vscode.l10n.t('Pushed {0} to origin', branch));
  } else {
    vscode.window.showInformationMessage(vscode.l10n.t('Published branch {0} to {1}', branch, instance.name));
  }
}

export async function publishToForgejo(
  config: ConfigManager,
  viewProvider?: ForgejoToolkitViewProvider,
): Promise<void> {
  const folder = await pickTargetFolder();
  if (!folder) {
    return;
  }
  const remoteUrl = await getRemoteUrl(folder);
  if (!remoteUrl) {
    await publishNewRepository(config, folder, viewProvider);
  } else {
    await pushToExistingRemote(config, folder, remoteUrl, viewProvider);
  }
}
