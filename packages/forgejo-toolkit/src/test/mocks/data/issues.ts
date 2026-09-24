import type { ForgejoIssue, ForgejoIssueDetail } from '../../../api/types';
import { mockUser } from './users';
import { mockRepository } from './repositories';

export const mockIssue: ForgejoIssue = {
  id: 1,
  number: 1,
  title: 'Fix login bug',
  state: 'open',
  html_url: 'https://forgejo.example.com/demo-user/demo-repo/issues/1',
  user: mockUser,
  body: 'Users cannot log in when 2FA is enabled.',
  created_at: '2026-08-15T10:00:00Z',
  updated_at: '2026-08-17T10:00:00Z',
  repository: mockRepository,
  // The API marks a pull request by carrying `pull_request`; the client derives
  // `is_pull` from it (the field itself is not part of the API response).
  pull_request: undefined,
};

export const mockIssueDetail: ForgejoIssueDetail = {
  id: 1,
  number: 1,
  title: 'Fix login bug',
  state: 'open',
  html_url: 'https://forgejo.example.com/demo-user/demo-repo/issues/1',
  user: mockUser,
  body: 'Users cannot log in when 2FA is enabled.',
  created_at: '2026-08-15T10:00:00Z',
  updated_at: '2026-08-17T10:00:00Z',
  labels: [
    { name: 'bug', color: 'ff0000' },
    { name: 'help wanted', color: '00ff00' },
  ],
  repository: { full_name: 'demo-user/demo-repo' },
  assets: [],
  // No `repoPermissions`: the issues endpoint does not send them, the client
  // computes them from the repository endpoint.
};

export const mockIssues: ForgejoIssue[] = [mockIssue];
