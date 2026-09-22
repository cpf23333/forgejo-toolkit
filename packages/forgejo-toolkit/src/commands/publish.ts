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
  clearLinkedRepositoryCache,
  getCurrentBranch,
  getCurrentCommitSha,
  getUpstreamBranch,
  listRemotes,
  listWorkspaceRepositories,
  pushBranch,
  remoteMatchesInstance,
  type GitRemoteEntry,
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

/**
 * Pre-check for the git remote name used when publishing a repository whose
 * origin is already taken (e.g. cloned from a non-Forgejo host). Same
 * character set as repository names, plus a reasonable subset of the
 * git-check-ref-format rules git enforces on ref (and therefore remote)
 * names: no "..", no leading "-", no leading/trailing ".", no ".lock"
 * suffix. Also must not collide with an existing remote.
 */
export function validateRemoteName(value: string, existing: GitRemoteEntry[]): string | undefined {
  const name = value.trim();
  if (!name) {
    return vscode.l10n.t('Remote name cannot be empty');
  }
  if (!REPO_NAME_PATTERN.test(name)) {
    return vscode.l10n.t('Remote name may only contain letters, digits, ".", "_" and "-"');
  }
  if (name.includes('..')) {
    return vscode.l10n.t('Remote name cannot contain ".."');
  }
  if (name.startsWith('-')) {
    return vscode.l10n.t('Remote name cannot start with "-"');
  }
  if (name.startsWith('.') || name.endsWith('.')) {
    return vscode.l10n.t('Remote name cannot start or end with "."');
  }
  if (name.endsWith('.lock')) {
    return vscode.l10n.t('Remote name cannot end with ".lock"');
  }
  if (existing.some((remote) => remote.name === name)) {
    return vscode.l10n.t('A remote named "{0}" already exists', name);
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
  // Includes nested repositories one level below each workspace folder, so a
  // repo living inside a plain folder (or inside another repo) can be
  // published too.
  const repos = await listWorkspaceRepositories();
  if (repos.length === 0) {
    vscode.window.showErrorMessage(
      vscode.l10n.t(
        'No git repository found in the current workspace. Open a folder containing a git repository to publish it.',
      ),
    );
    return undefined;
  }
  if (repos.length === 1) {
    return repos[0];
  }
  const picked = await vscode.window.showQuickPick(
    repos.map((repoPath) => ({ label: path.basename(repoPath), description: repoPath, repoPath })),
    { placeHolder: vscode.l10n.t('Select a folder to publish') },
  );
  return picked?.repoPath;
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

  // The remote is named origin when free; a repository cloned from elsewhere
  // already has an origin, so ask for the Forgejo remote's name before
  // creating anything on the server.
  const existingRemotes = await listRemotes(folder);
  let remoteName = 'origin';
  if (existingRemotes.some((remote) => remote.name === 'origin')) {
    const pickedName = await vscode.window.showInputBox({
      title: vscode.l10n.t('Remote name for the Forgejo remote'),
      value: 'forgejo',
      validateInput: (value) => validateRemoteName(value, existingRemotes),
    });
    if (!pickedName) {
      return;
    }
    remoteName = pickedName.trim();
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
  const repoLabel = repository.full_name ?? name;
  // From here on the repository already exists on the instance; a blind retry
  // would hit a 422 name conflict. Failures below therefore throw errors that
  // spell out the intermediate state (repository created, and for push
  // failures also the added remote) — the command registration's catch shows
  // and logs them.
  try {
    await addRemote(folder, remoteName, cloneUrl);
  } catch (error) {
    throw new Error(
      vscode.l10n.t(
        'Repository {0} was created on {1}, but adding the "{2}" remote failed: {3}',
        repoLabel,
        instance.name,
        remoteName,
        userFacingErrorMessage(error),
      ),
    );
  }
  // The linked-repository scan is cached for 10s and its key covers only the
  // workspace folders and the instance list — not the git remotes it reads — so
  // the new remote must invalidate it explicitly. Otherwise the SCM title keeps
  // offering "Publish to Forgejo" and hasLinkedRepo-gated actions stay disabled
  // until the TTL lapses. Cleared on the remote change rather than after the
  // push, so the no-branch and push-failure paths are covered too.
  clearLinkedRepositoryCache();

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
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Pushing {0} to {1}…', branch, instance.name),
      },
      () => pushBranch(folder, remoteName, branch, instance.token, true, instance.url),
    );
  } catch (error) {
    throw new Error(
      vscode.l10n.t(
        'Repository {0} was created on {1} and the "{2}" remote was added, but pushing {3} failed: {4}',
        repoLabel,
        instance.name,
        remoteName,
        branch,
        userFacingErrorMessage(error),
      ),
    );
  }
  viewProvider?.refresh();

  const openInBrowser = vscode.l10n.t('Open in Browser');
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t('Published {0} to {1}', repoLabel, instance.name),
    openInBrowser,
  );
  if (choice === openInBrowser && repository.html_url) {
    const uri = vscode.Uri.parse(repository.html_url);
    // html_url comes from the API response; only open web URLs, same
    // whitelist as the webview's openExternal handler.
    if (uri.scheme !== 'http' && uri.scheme !== 'https') {
      logger.error(`Blocked openExternal with disallowed scheme "${uri.scheme}": ${repository.html_url}`);
    } else {
      await vscode.env.openExternal(uri);
    }
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
  remote: GitRemoteEntry,
  viewProvider?: ForgejoToolkitViewProvider,
): Promise<void> {
  const matched = config.getInstances().filter((instance) => remoteMatchesInstance(remote.url, instance.url));
  if (matched.length === 0) {
    vscode.window.showWarningMessage(
      vscode.l10n.t('The {0} remote does not match any configured Forgejo instance: {1}', remote.name, remote.url),
    );
    return;
  }
  const instance = matched.length === 1 ? matched[0] : await pickInstanceForRemote(remote.url, matched);
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
    () => pushBranch(folder, remote.name, branch, instance.token, !upstream, instance.url),
  );
  viewProvider?.refresh();
  if (upstream) {
    vscode.window.showInformationMessage(vscode.l10n.t('Pushed {0} to {1}', branch, remote.name));
  } else {
    vscode.window.showInformationMessage(vscode.l10n.t('Published branch {0} to {1}', branch, instance.name));
  }
}

/**
 * Pick which remote to push to when several remotes of the repository point
 * at configured Forgejo instances (e.g. a fork's upstream plus one's own
 * Forgejo remote). Only called when origin is not among the candidates —
 * origin wins without asking.
 */
async function pickRemote(remotes: GitRemoteEntry[]): Promise<GitRemoteEntry | undefined> {
  const picked = await vscode.window.showQuickPick(
    remotes.map((remote) => ({ label: remote.name, description: remote.url, remote })),
    { placeHolder: vscode.l10n.t('Multiple remotes match configured Forgejo instances. Select the remote to push to') },
  );
  return picked?.remote;
}

export async function publishToForgejo(
  config: ConfigManager,
  viewProvider?: ForgejoToolkitViewProvider,
): Promise<void> {
  const folder = await pickTargetFolder();
  if (!folder) {
    return;
  }
  // Consider every remote, not just origin: the Forgejo remote may live under
  // another name next to a non-Forgejo origin.
  const remotes = await listRemotes(folder);
  const instances = config.getInstances();
  const matching = remotes.filter((remote) =>
    instances.some((instance) => remoteMatchesInstance(remote.url, instance.url)),
  );
  if (matching.length === 0) {
    // No remote points at a configured instance — either there are no remotes
    // at all, or they point elsewhere (e.g. cloned from another host). Both
    // cases are exactly what "Publish to Forgejo" is for: create the
    // repository on an instance and add it as a new remote.
    await publishNewRepository(config, folder, viewProvider);
    return;
  }
  const remote = matching.find((entry) => entry.name === 'origin') ?? (matching.length === 1 ? matching[0] : undefined);
  const chosen = remote ?? (await pickRemote(matching));
  if (!chosen) {
    return;
  }
  await pushToExistingRemote(config, folder, chosen, viewProvider);
}
