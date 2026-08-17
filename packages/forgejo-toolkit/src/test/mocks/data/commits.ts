import type { Commit } from '@cpf23333-forgejo-toolkit/api';

export const mockHistoryCommit: Commit = {
  sha: 'history-sha',
  commit: {
    message: 'Update README',
    author: { name: 'Demo User', date: '2026-08-17T09:00:00Z' },
  },
  html_url: 'https://forgejo.example.com/demo-user/demo-repo/commit/history-sha',
  parents: [{ sha: 'parent-sha' }],
  files: [{ filename: 'README.md', status: 'modified' }],
} as Commit;
