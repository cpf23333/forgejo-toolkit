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

export interface ForgejoLabel {
  name?: string;
  color?: string;
}

export interface ForgejoMilestone {
  title?: string;
}

export interface ForgejoIssueAttachment {
  id?: number;
  name?: string;
  size?: number;
  uuid?: string;
  browser_download_url?: string;
  type?: string;
}

export interface ForgejoIssueDetail {
  id?: number;
  number?: number;
  title?: string;
  state?: string;
  html_url?: string;
  user?: ForgejoUser;
  body?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
  labels?: ForgejoLabel[];
  milestone?: ForgejoMilestone;
  repository?: { full_name?: string };
  assets?: ForgejoIssueAttachment[];
}

export interface ForgejoPullRequestDetail extends ForgejoIssueDetail {
  base?: { ref?: string; sha?: string; repo?: { full_name?: string } };
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } };
  additions?: number;
  deletions?: number;
  changed_files?: number;
  merged?: boolean;
  merged_at?: string;
  merged_by?: ForgejoUser;
  mergeable?: boolean;
  draft?: boolean;
}

export interface ForgejoChangedFile {
  additions?: number;
  changes?: number;
  contents_url?: string;
  deletions?: number;
  filename?: string;
  html_url?: string;
  previous_filename?: string;
  raw_url?: string;
  status?: string;
}

export interface ForgejoPullRequestWorktreeInfo {
  id: string;
  instanceId: string;
  owner: string;
  repo: string;
  prIndex: number;
  prTitle: string;
  headBranch: string;
  headSha: string;
  baseBranch: string;
  sourceRepoPath: string;
  worktreePath: string;
  createdAt: number;
}

export interface ForgejoTimelineComment {
  id?: number;
  type?: string;
  body?: string;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
  user?: ForgejoUser;
  assignee?: ForgejoUser;
  resolve_doer?: ForgejoUser;
  ref_commit_sha?: string;
  ref_comment?: {
    id?: number;
    body?: string;
    user?: ForgejoUser;
  };
  new_title?: string;
  old_title?: string;
  new_ref?: string;
  old_ref?: string;
}

export interface ForgejoPullRequestCommit extends ForgejoCommit {
  files?: ForgejoChangedFile[];
  parents?: { sha?: string }[];
}

export interface ForgejoRepoDetail {
  repository: ForgejoRepository;
  empty: boolean;
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
  committer?: ForgejoUser;
  html_url: string;
  created?: string;
}
