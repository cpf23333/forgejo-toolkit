// Instance data as seen by the webview. The access token stays in the
// extension host (SecretStorage) and is never sent here; only an opaque
// fingerprint of it travels, so the webview can notice that the credential
// behind an instance changed.
export interface ForgejoInstance {
  id: string;
  url: string;
  name: string;
  username: string;
  tokenFingerprint?: string;
  syncApiUrlsToInstanceUrl?: boolean;
}

export * from './api';
