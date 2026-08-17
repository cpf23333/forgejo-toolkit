import type { ForgejoNotification } from '../../../api/types';
import { mockRepository } from './repositories';

export const mockNotifications: ForgejoNotification[] = [
  {
    id: 101,
    pinned: false,
    repository: mockRepository,
    subject: {
      title: 'Fix login bug',
      type: 'Issue',
      state: 'open',
      html_url: 'https://forgejo.example.com/demo-user/demo-repo/issues/1',
      url: 'https://forgejo.example.com/api/v1/repos/demo-user/demo-repo/issues/1',
    },
    unread: true,
    updated_at: '2026-08-17T10:00:00Z',
    url: 'https://forgejo.example.com/api/v1/notifications/threads/101',
  },
  {
    id: 102,
    pinned: false,
    repository: mockRepository,
    subject: {
      title: 'Add dark mode',
      type: 'PullRequest',
      state: 'open',
      html_url: 'https://forgejo.example.com/demo-user/demo-repo/pulls/2',
      url: 'https://forgejo.example.com/api/v1/repos/demo-user/demo-repo/pulls/2',
    },
    unread: true,
    updated_at: '2026-08-17T09:30:00Z',
    url: 'https://forgejo.example.com/api/v1/notifications/threads/102',
  },
  {
    id: 103,
    pinned: false,
    repository: mockRepository,
    subject: {
      title: 'Welcome to the repo',
      type: 'Repository',
      state: '',
      html_url: 'https://forgejo.example.com/demo-user/demo-repo',
      url: 'https://forgejo.example.com/api/v1/repos/demo-user/demo-repo',
    },
    unread: false,
    updated_at: '2026-08-16T08:00:00Z',
    url: 'https://forgejo.example.com/api/v1/notifications/threads/103',
  },
];
