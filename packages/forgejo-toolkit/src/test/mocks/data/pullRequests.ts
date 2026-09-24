import type { ForgejoPullRequest, ForgejoPullRequestDetail } from '../../../api/types';
import { mockUser } from './users';

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
  // Aligned with the mocked files endpoint (single file, +10/-2).
  additions: 10,
  deletions: 2,
  changed_files: 1,
  merged: false,
  mergeable: true,
  draft: false,
  repository: { full_name: 'demo-user/demo-repo' },
  // `repoPermissions`, `mergeBlockers`, `statusChecks` and `assets` are
  // deliberately absent: the pulls endpoint never sends them (the branch
  // protection, combined-status, repo and issues endpoints do). The client
  // computes them from those requests, so a fixture that pre-filled them could
  // make a client that stopped computing them still look correct.
};

export const mockPullRequests: ForgejoPullRequest[] = [mockPullRequest];
