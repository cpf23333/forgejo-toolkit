import * as vscode from 'vscode';
import { ForgejoInstance } from '../config';

export type ForgejoTreeItem = InstanceTreeItem;

export class InstanceTreeProvider implements vscode.TreeDataProvider<ForgejoTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ForgejoTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ForgejoTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ForgejoTreeItem): Thenable<ForgejoTreeItem[]> {
        if (element) {
            return Promise.resolve([]);
        }

        const instances = this.context.globalState.get<ForgejoInstance[]>('forgejoToolkit.instances', []);
        return Promise.resolve(instances.map(i => new InstanceTreeItem(i)));
    }
}

export class InstanceTreeItem extends vscode.TreeItem {
    constructor(public readonly instance: ForgejoInstance) {
        super(instance.name, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `${instance.url}\nUser: ${instance.username}`;
        this.contextValue = 'forgejoInstance';
        this.iconPath = new vscode.ThemeIcon('server');
        this.command = {
            command: 'forgejoToolkit.openDashboard',
            title: 'Open Dashboard',
        };
    }
}
