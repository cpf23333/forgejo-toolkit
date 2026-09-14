import * as vscode from 'vscode';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import type { ConfigManager } from '../config';
import type { ForgejoRepository } from '../api/types';
import { ForgejoClient } from '../api/client';
import { userFacingErrorMessage } from '../api/errors';
import { logger } from '../logger';

// Minimal structural declarations for the built-in git extension's stable v1
// API surface (see extensions/git/src/api/git.d.ts in the VS Code sources).
// Only the RemoteSourceProvider part is needed; copying the full declaration
// file would pull in dozens of unrelated types.
export interface RemoteSource {
  readonly name: string;
  readonly description?: string;
  readonly url: string | string[];
}

export interface RemoteSourceProvider {
  readonly name: string;
  readonly icon?: string;
  readonly supportsQuery?: boolean;
  getRemoteSources(query?: string): vscode.ProviderResult<RemoteSource[]>;
}

export interface GitApi {
  registerRemoteSourceProvider(provider: RemoteSourceProvider): vscode.Disposable;
}

interface GitExtensionExports {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: 1): GitApi;
}

/**
 * One RemoteSourceProvider per configured instance: the git clone quick pick
 * groups sources by provider name, so each instance shows up as its own
 * source entry and instance add/remove maps to register/dispose.
 */
export class ForgejoRemoteSourceProvider implements RemoteSourceProvider {
  readonly supportsQuery = true;
  readonly icon = 'repo-clone';

  constructor(private readonly _instance: ForgejoInstance) {}

  get name(): string {
    return this._instance.name;
  }

  async getRemoteSources(query?: string): Promise<RemoteSource[]> {
    const client = new ForgejoClient(
      this._instance.url,
      this._instance.token,
      logger,
      this._instance.syncApiUrlsToInstanceUrl,
    );
    const trimmed = query?.trim();
    try {
      // Without a query the clone picker shows the user's own repositories
      // (same behavior as the built-in GitHub flow); a query is searched
      // server-side.
      const repos = trimmed ? await client.searchRepositories(trimmed) : await client.getUserRepositories();
      return repos.map((repo) => toRemoteSource(this._instance, repo));
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`Failed to list clone sources for ${this._instance.name}: ${err}`);
      // The git extension displays the thrown error in its quick pick.
      throw new Error(err);
    }
  }
}

export function toRemoteSource(instance: ForgejoInstance, repo: ForgejoRepository): RemoteSource {
  const urls = [repo.clone_url ?? `${instance.url.replace(/\/$/, '')}/${repo.full_name}.git`];
  if (repo.ssh_url) {
    urls.push(repo.ssh_url);
  }
  return { name: repo.full_name, description: repo.description || undefined, url: urls };
}

/**
 * Registers one git RemoteSourceProvider per configured instance and keeps
 * the registrations in sync with instance add/remove. Degrades to a log line
 * when the built-in git extension is missing or fails to activate.
 */
export async function registerForgejoRemoteSourceProviders(
  context: vscode.ExtensionContext,
  config: Pick<ConfigManager, 'getInstances' | 'onInstancesChanged'>,
): Promise<void> {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) {
    logger.info('vscode.git extension not found; Forgejo clone sources are unavailable');
    return;
  }

  let gitExports: GitExtensionExports;
  try {
    // activate() is idempotent and resolves to the extension's exports.
    gitExports = (await gitExtension.activate()) as GitExtensionExports;
  } catch (error) {
    const err = userFacingErrorMessage(error);
    logger.error(`Failed to activate the vscode.git extension; Forgejo clone sources are unavailable: ${err}`);
    return;
  }

  const registrations = new Map<string, vscode.Disposable>();
  context.subscriptions.push({
    dispose: () => {
      for (const disposable of registrations.values()) {
        disposable.dispose();
      }
      registrations.clear();
    },
  });

  const setup = () => {
    let api: GitApi;
    try {
      // getAPI throws while the git extension is disabled.
      api = gitExports.getAPI(1);
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`Git API is unavailable; Forgejo clone sources are unavailable: ${err}`);
      return;
    }
    syncRemoteSourceProviders(api, config.getInstances(), registrations);
    context.subscriptions.push(
      config.onInstancesChanged((instances) => syncRemoteSourceProviders(api, instances, registrations)),
    );
  };

  if (gitExports.enabled) {
    setup();
  } else {
    // Rare: git is installed but currently disabled. Register lazily once it
    // becomes enabled instead of failing permanently.
    const listener = gitExports.onDidChangeEnablement((enabled) => {
      if (enabled) {
        listener.dispose();
        setup();
      }
    });
    context.subscriptions.push(listener);
  }
}

export function syncRemoteSourceProviders(
  api: GitApi,
  instances: ForgejoInstance[],
  registrations: Map<string, vscode.Disposable>,
): void {
  const seen = new Set<string>();
  for (const instance of instances) {
    seen.add(instance.id);
    if (!registrations.has(instance.id)) {
      registrations.set(instance.id, api.registerRemoteSourceProvider(new ForgejoRemoteSourceProvider(instance)));
    }
  }
  for (const [id, disposable] of registrations) {
    if (!seen.has(id)) {
      disposable.dispose();
      registrations.delete(id);
    }
  }
}
