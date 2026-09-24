import type { ForgejoNotification } from '../../../api/types';
import { mockRepository } from './repositories';

/**
 * A notification's repository as the API reports it. `ToNotificationThread`
 * deliberately drops `permissions` ("This permission is not correct and we
 * should not be reporting it"), so a notification that carried them would
 * describe a response the server cannot send.
 */
const notificationRepository = { ...mockRepository, permissions: undefined };

/**
 * Notification threads, newest first, like the API orders them. `before` (the
 * page cursor the webview pages with) and `limit` are honoured by the handler.
 *
 * `subject.type` uses the API's own vocabulary — `Issue`, `Pull`, `Commit`,
 * `Repository` (see `structs.NotifySubjectType`); `PullRequest` is not a value a
 * Forgejo instance ever sends.
 */
export const mockNotifications: ForgejoNotification[] = [
  {
    id: 101,
    pinned: false,
    repository: notificationRepository,
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
    repository: notificationRepository,
    subject: {
      title: 'Add dark mode',
      type: 'Pull',
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
    repository: notificationRepository,
    subject: {
      title: 'Welcome to the repo',
      type: 'Repository',
      // Forgejo leaves the state empty for a repository notification.
      state: '',
      html_url: 'https://forgejo.example.com/demo-user/demo-repo',
      url: 'https://forgejo.example.com/api/v1/repos/demo-user/demo-repo',
    },
    unread: false,
    updated_at: '2026-08-16T08:00:00Z',
    url: 'https://forgejo.example.com/api/v1/notifications/threads/103',
  },
];
