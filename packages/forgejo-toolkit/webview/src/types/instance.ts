// Instance data as seen by the webview. The access token stays in the
// extension host (SecretStorage) and is never sent here.
export interface ForgejoInstance {
  id: string;
  url: string;
  name: string;
  username: string;
  syncApiUrlsToInstanceUrl?: boolean;
}

export * from './api';
