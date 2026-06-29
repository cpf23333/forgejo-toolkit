import * as vscode from 'vscode';
import { ForgejoClient } from '../api/client';
import { ConfigManager, ForgejoInstance } from '../config';
import { InstanceTreeProvider, InstanceTreeItem } from '../providers/instanceTreeProvider';
import { openDashboard } from '../webview/panel';

export function registerCommands(context: vscode.ExtensionContext, treeProvider: InstanceTreeProvider) {
    const config = new ConfigManager(context);

    context.subscriptions.push(
        vscode.commands.registerCommand('forgejoToolkit.addInstance', async () => {
            const url = await vscode.window.showInputBox({
                prompt: 'Enter Forgejo instance URL',
                placeHolder: 'https://forgejo.example.com',
                validateInput: (value) => {
                    if (!value) { return 'URL is required'; }
                    try {
                        new URL(value);
                        return null;
                    } catch {
                        return 'Invalid URL';
                    }
                },
            });

            if (!url) { return; }

            const token = await vscode.window.showInputBox({
                prompt: 'Enter Forgejo Access Token',
                password: true,
                validateInput: (value) => value ? null : 'Token is required',
            });

            if (!token) { return; }

            try {
                const client = new ForgejoClient(url, token);
                const user = await client.getCurrentUser();

                const normalizedUrl = url.replace(/\/$/, '');
                const id = `${new URL(normalizedUrl).hostname}-${user.login}`;
                const instance: ForgejoInstance = {
                    id,
                    url: normalizedUrl,
                    token,
                    name: `${user.login}@${new URL(normalizedUrl).hostname}`,
                    username: user.login,
                };

                await config.addInstance(instance);
                treeProvider.refresh();
                vscode.window.showInformationMessage(`Connected to Forgejo as ${user.login}`);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to connect: ${message}`);
            }
        }),

        vscode.commands.registerCommand('forgejoToolkit.removeInstance', async (item?: InstanceTreeItem) => {
            const instance = item?.instance;
            if (!instance) {
                vscode.window.showWarningMessage('No instance selected');
                return;
            }

            const answer = await vscode.window.showWarningMessage(
                `Remove Forgejo instance "${instance.name}"?`,
                { modal: true },
                'Remove'
            );

            if (answer === 'Remove') {
                await config.removeInstance(instance.id);
                treeProvider.refresh();
            }
        }),

        vscode.commands.registerCommand('forgejoToolkit.refreshInstances', () => {
            treeProvider.refresh();
        }),

        vscode.commands.registerCommand('forgejoToolkit.openDashboard', () => {
            openDashboard(context, config);
        })
    );
}
