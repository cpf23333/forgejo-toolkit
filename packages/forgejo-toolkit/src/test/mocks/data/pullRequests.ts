import type { ForgejoPullRequest, ForgejoPullRequestDetail } from '../../../api/types';
import { mockUser } from './users';
import { mockRepository } from './repositories';

export const mockPullRequest: ForgejoPullRequest = {
  id: 2,
  number: 2,
  title: 'Add dark mode',
  state: 'open',
  html_url: 'https://forgejo.example.com/demo-user/demo-repo/pulls/2',
  user: mockUser,
  body: 'This PR adds a dark mode toggle to the UI.',
  created_at: '2026-08-14T09:00:00Z',
  updated_at: '2026-08-17T09:30:00Z',
};

export const mockPullRequestDetail: ForgejoPullRequestDetail = {
  ...mockPullRequest,
  base: { ref: 'main', sha: 'abc123', repo: { full_name: 'demo-user/demo-repo' } },
  head: { ref: 'feature/dark-mode', sha: 'def456', repo: { full_name: 'demo-user/demo-repo' } },
  merge_base: 'abc123',
  additions: 120,
  deletions: 30,
  changed_files: 5,
  merged: false,
  mergeable: true,
  draft: false,
  assets: [],
  repoPermissions: { admin: true, push: true, pull: true },
  mergeBlockers: [],
  statusChecks: {
    state: 'success',
    statuses: [
      {
        id: 1,
        context: 'ci/build',
        description: 'Build passed',
        status: 'success',
        target_url: 'https://forgejo.example.com/demo-user/demo-repo/actions/runs/1',
        created_at: '2026-08-17T09:00:00Z',
        updated_at: '2026-08-17T09:10:00Z',
      },
    ],
  },
  repository: { full_name: 'demo-user/demo-repo' },
};

export const mockPullRequests: ForgejoPullRequest[] = [mockPullRequest];
