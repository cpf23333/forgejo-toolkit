import type { ForgejoRepository } from '../../../api/types';
import { mockUser } from './users';

export const mockRepository: ForgejoRepository = {
  id: 1,
  name: 'demo-repo',
  full_name: 'demo-user/demo-repo',
  html_url: 'https://forgejo.example.com/demo-user/demo-repo',
  private: false,
  description: 'A demo repository for offline development.',
  owner: mockUser,
  default_branch: 'main',
  stars_count: 12,
  forks_count: 3,
  open_issues_count: 5,
  open_pr_counter: 2,
  has_issues: true,
  has_pull_requests: true,
  mirror: false,
};

export const mockRepository2: ForgejoRepository = {
  id: 2,
  name: 'another-repo',
  full_name: 'demo-user/another-repo',
  html_url: 'https://forgejo.example.com/demo-user/another-repo',
  private: true,
  description: 'Another demo repository.',
  owner: mockUser,
  default_branch: 'main',
  stars_count: 0,
  forks_count: 0,
  open_issues_count: 1,
  open_pr_counter: 0,
  has_issues: true,
  has_pull_requests: true,
  mirror: false,
};
