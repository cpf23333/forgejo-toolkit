import type { Label, Milestone, Reaction, TrackedTime, WatchInfo, User } from '@cpf23333-forgejo-toolkit/api';
import { mockUser, mockOtherUser } from './users';
import { mockIssue } from './issues';

export const mockLabel: Label = {
  id: 1,
  name: 'bug',
  color: 'ff0000',
  description: 'Something is broken',
} as Label;

export const mockAssignees: User[] = [mockUser, mockOtherUser];

export const mockMilestone: Milestone = {
  id: 1,
  title: 'v1.0',
  description: 'First stable release',
  state: 'open',
  due_on: '2026-09-01T00:00:00Z',
} as Milestone;

export const mockReaction: Reaction = {
  content: 'heart',
  user: mockUser,
} as Reaction;

export const mockTrackedTime: TrackedTime = {
  id: 1,
  issue_id: 1,
  user_id: 1,
  user_name: mockUser.login,
  time: 3600,
  created: '2026-08-17T09:00:00Z',
} as TrackedTime;

export const mockWatchInfo: WatchInfo = {
  subscribed: true,
  ignored: false,
  reason: null,
  created_at: '2026-08-17T09:00:00Z',
  url: 'https://forgejo.example.com/demo-user/demo-repo/issues/1/subscriptions',
} as WatchInfo;

export const mockDependencies = [mockIssue];

export const mockIssueAttachment = {
  id: 20,
  uuid: 'issue-attachment-uuid',
  name: 'screenshot.png',
  size: 1024,
  browser_download_url: 'https://forgejo.example.com/demo-user/demo-repo/attachments/issue-attachment-uuid',
};

export const mockCommentAttachment = {
  id: 21,
  // A real-looking uuid on purpose: the client only asks for a comment's
  // attachment list when the body references `/attachments/<uuid>`, so the
  // walkthrough's comment-attachment flow needs a matchable reference.
  uuid: '33333333-4444-5555-6666-777777777777',
  name: 'log.txt',
  size: 512,
  browser_download_url:
    'https://forgejo.example.com/demo-user/demo-repo/attachments/33333333-4444-5555-6666-777777777777',
};
