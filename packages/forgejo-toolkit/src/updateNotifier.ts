import * as vscode from 'vscode';
import type { Logger } from './logger';

/**
 * Notifies the user when the extension was updated underneath a running
 * window.
 *
 * VS Code loads the extension bundle into the extension host at activation
 * and keeps running that copy until the window reloads; an updated .vsix on
 * disk changes nothing in the running process. The workbench only shows a
 * quiet "Reload Required" affordance on the extension's page (and nothing at
 * all for a `--install-extension` install), so an updated installation is
 * easy to miss while the old code keeps running — with our MCP shim and
 * workspace-state writers, that also means the on-disk helper files keep
 * pointing at the previous build's behaviour.
 *
 * The running copy cannot notice its own replacement through its manifest:
 * `context.extension.packageJSON` was read at activation. But the extension
 * registry's view of the extension is the freshly installed one, so a version
 * mismatch between the two means an update landed. `onDidChange` also fires
 * for enable/disable toggles, where the on-disk version is unchanged and no
 * prompt is wanted.
 */
export function watchForExtensionUpdate(context: vscode.ExtensionContext, logger: Logger): void {
  const runningVersion = context.extension.packageJSON.version as string;
  context.subscriptions.push(
    vscode.extensions.onDidChange(() => {
      const installed = vscode.extensions.getExtension(context.extension.id);
      const installedVersion = installed?.packageJSON?.version as string | undefined;
      if (!installedVersion || installedVersion === runningVersion) {
        return;
      }
      logger.info(
        `Extension was updated on disk (running ${runningVersion}, installed ${installedVersion}); prompting for reload.`,
      );
      const reloadLabel = vscode.l10n.t('Reload');
      void vscode.window
        .showInformationMessage(
          vscode.l10n.t(
            'Forgejo Toolkit was updated to version {0}. Reload the window to finish updating.',
            installedVersion,
          ),
          reloadLabel,
        )
        .then((choice) => {
          if (choice === reloadLabel) {
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        });
    }),
  );
}
