export interface ForgejoInstance {
  id: string;
  url: string;
  token: string;
  name: string;
  username: string;
  syncApiUrlsToInstanceUrl?: boolean;
}

export * from './api';
