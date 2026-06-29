import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { InstanceTreeProvider } from './providers/instanceTreeProvider';

export function activate(context: vscode.ExtensionContext) {
    const treeProvider = new InstanceTreeProvider(context);

    vscode.window.registerTreeDataProvider('forgejoToolkitInstances', treeProvider);
    registerCommands(context, treeProvider);

    console.log('Forgejo Toolkit extension activated');
}

export function deactivate() {
    // cleanup if needed
}
