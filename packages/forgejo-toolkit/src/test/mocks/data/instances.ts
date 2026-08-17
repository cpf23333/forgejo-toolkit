import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

export const mockInstance: ForgejoInstance = {
  id: 'mock-instance-1',
  url: 'https://forgejo.example.com',
  token: 'mock-token',
  name: 'Mock Forgejo',
  username: 'demo-user',
  syncApiUrlsToInstanceUrl: true,
};
