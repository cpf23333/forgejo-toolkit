import type { Commit, PullReview, PullReviewComment, TimelineComment } from '@cpf23333-forgejo-toolkit/api';
import { mockUser } from './users';

export const mockPullReview: PullReview = {
  id: 100,
  user: mockUser,
  body: 'Looks good',
  state: 'COMMENT',
  submitted_at: '2026-08-17T09:00:00Z',
  commit_id: 'abc123',
} as PullReview;

export const mockPullReviewComment: PullReviewComment = {
  id: 200,
  pull_request_review_id: 100,
  path: 'src/index.ts',
  // Forgejo positions are 1-based file line numbers: `position` is the line
  // in the new file, `original_position` the line in the old file; the
  // unused side is 0. This comment sits on the added line of
  // `mockPullRequestDiff` (new file line 2).
  position: 2,
  original_position: 0,
  body: 'Consider renaming this variable',
  user: mockUser,
  commit_id: 'abc123',
} as PullReviewComment;

export const mockPullRequestCommit: Commit = {
  sha: 'pr-commit-sha',
  commit: {
    message: 'Add feature',
    author: { name: 'Demo User', date: '2026-08-17T09:00:00Z' },
  },
  html_url: 'https://forgejo.example.com/demo-user/demo-repo/commit/pr-commit-sha',
} as Commit;

export const mockPullRequestDiff = `diff --git a/src/index.ts b/src/index.ts
index 1111111..2222222 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,2 +1,3 @@
 const a = 1;
+console.log('hello');
 const b = 2;
`;

export const mockTimelineComment: TimelineComment = {
  id: 50,
  user: mockUser,
  body: 'Thanks for the report',
  created_at: '2026-08-17T09:00:00Z',
  updated_at: '2026-08-17T09:00:00Z',
} as TimelineComment;
