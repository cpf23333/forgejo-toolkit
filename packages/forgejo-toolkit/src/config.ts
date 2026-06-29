import * as vscode from 'vscode';

export interface ForgejoInstance {
  id: string;
  url: string;
  token: string;
  name: string;
  username: string;
}

const INSTANCES_KEY = 'forgejoToolkit.instances';

export class ConfigManager {
  constructor(private context: vscode.ExtensionContext) {}

  getInstances(): ForgejoInstance[] {
    return this.context.globalState.get<ForgejoInstance[]>(INSTANCES_KEY, []);
  }

  async addInstance(instance: ForgejoInstance): Promise<void> {
    const instances = this.getInstances().filter((i) => i.id !== instance.id);
    instances.push(instance);
    await this.context.globalState.update(INSTANCES_KEY, instances);
  }

  async removeInstance(id: string): Promise<void> {
    const instances = this.getInstances().filter((i) => i.id !== id);
    await this.context.globalState.update(INSTANCES_KEY, instances);
  }
}
