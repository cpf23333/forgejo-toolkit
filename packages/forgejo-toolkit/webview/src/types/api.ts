export interface ForgejoUser {
  id: number;
  login: string;
  full_name: string;
  email: string;
  avatar_url: string;
}

export interface ForgejoRepository {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  private: boolean;
  description: string;
  owner: ForgejoUser;
  default_branch: string;
  stars_count: number;
  forks_count: number;
  open_issues_count: number;
  open_pr_counter?: number;
}

export interface ForgejoIssue {
  id: number;
  number: number;
  title: string;
  state: string;
  html_url: string;
  user: ForgejoUser;
  body: string;
  created_at: string;
  updated_at: string;
  repository?: ForgejoRepository;
  pull_request?: unknown;
  is_pull?: boolean;
}

export interface ForgejoPullRequest {
  id: number;
  number: number;
  title: string;
  state: string;
  html_url: string;
  user: ForgejoUser;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface ForgejoRepoDetail {
  repository: ForgejoRepository;
  readme?: string;
  branches: string[];
  recentCommits: ForgejoCommit[];
}

export interface ForgejoCommit {
  sha: string;
  commit: {
    message: string;
    author: {
      name: string;
      date: string;
    };
  };
  author?: ForgejoUser;
  html_url: string;
}
