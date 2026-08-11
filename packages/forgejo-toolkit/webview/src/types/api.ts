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

export interface ForgejoNotification {
  id?: number;
  pinned?: boolean;
  repository?: ForgejoRepository;
  subject?: {
    title?: string;
    type?: string;
    state?: string;
    html_url?: string;
    url?: string;
    latest_comment_html_url?: string;
    latest_comment_url?: string;
  };
  unread?: boolean;
  updated_at?: string;
  url?: string;
}

export interface ForgejoTrackedTime {
  id?: number;
  created?: string;
  time?: number;
  user_name?: string;
  issue_id?: number;
}

export interface ForgejoStopWatch {
  issue_index?: number;
  issue_title?: string;
  repo_name?: string;
  repo_owner_name?: string;
  seconds?: number;
  created?: string;
}

export interface ForgejoWatchInfo {
  subscribed?: boolean;
  ignored?: boolean;
  created_at?: string;
}

export interface ForgejoReaction {
  content?: string;
  created_at?: string;
  user?: ForgejoUser;
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
  id?: number;
  name?: string;
  color?: string;
}

export interface ForgejoMilestone {
  id?: number;
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

export interface ForgejoRepoPermissions {
  admin?: boolean;
  push?: boolean;
  pull?: boolean;
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
  due_date?: string;
  labels?: ForgejoLabel[];
  assignees?: ForgejoUser[];
  milestone?: ForgejoMilestone;
  repository?: { full_name?: string };
  assets?: ForgejoIssueAttachment[];
  repoPermissions?: ForgejoRepoPermissions;
}

export interface ForgejoPullRequestDetail extends ForgejoIssueDetail {
  base?: { ref?: string; sha?: string; repo?: { full_name?: string } };
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } };
  merge_base?: string;
  merge_commit_sha?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  merged?: boolean;
  merged_at?: string;
  merged_by?: ForgejoUser;
  mergeable?: boolean;
  draft?: boolean;
  mergeBlockers?: MergeBlocker[];
  statusChecks?: ForgejoStatusChecks;
}

export interface ForgejoStatusChecks {
  state?: string;
  statuses: ForgejoStatusCheck[];
}

export interface ForgejoStatusCheck {
  id?: number;
  context?: string;
  description?: string;
  status?: string;
  target_url?: string;
  created_at?: string;
  updated_at?: string;
}

export interface MergeBlocker {
  type:
    | 'draft'
    | 'closed'
    | 'no_permission'
    | 'conflicts'
    | 'required_approvals'
    | 'required_status_checks'
    | 'unknown';
  requiredApprovals?: number;
  statusState?: string;
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
  assets?: ForgejoIssueAttachment[];
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

export interface ForgejoContentEntry {
  name?: string;
  path?: string;
  type?: 'file' | 'dir' | 'symlink' | 'submodule' | string;
  sha?: string;
  size?: number;
  content?: string;
  encoding?: string;
  download_url?: string;
  html_url?: string;
  url?: string;
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
  parents?: { sha?: string }[];
  files?: { filename?: string; status?: string }[];
}

export interface ForgejoActionRun {
  id?: number;
  index_in_repo?: number;
  title?: string;
  status?: string;
  event?: string;
  trigger_event?: string;
  workflow_id?: string;
  commit_sha?: string;
  prettyref?: string;
  html_url?: string;
  created?: string;
  started?: string;
  stopped?: string;
  updated?: string;
  duration?: number;
  is_fork_pull_request?: boolean;
  need_approval?: boolean;
  trigger_user?: ForgejoUser;
}

export interface ForgejoActionRunList {
  total_count?: number;
  workflow_runs: ForgejoActionRun[];
}

export interface ForgejoActionRunJob {
  id?: number;
  name?: string;
  status?: string;
  attempt?: number;
  handle?: string;
  needs?: string[];
  owner_id?: number;
  repo_id?: number;
  run_id?: number;
  runs_on?: string[];
  task_id?: number;
}

export interface ForgejoActionArtifact {
  id?: number;
  name?: string;
  size_in_bytes?: number;
  archive_download_url?: string;
  created_at?: string;
  updated_at?: string;
  expires_at?: string;
  expired?: boolean;
  run_id?: number;
}

export type ForgejoBranch = {
  name?: string;
  commit?: {
    id?: string;
    message?: string;
    url?: string;
  };
  protected?: boolean;
};

export type ForgejoTag = {
  name?: string;
  id?: string;
  message?: string;
  commit?: {
    sha?: string;
    url?: string;
  };
};

export type ForgejoReleaseAttachment = {
  id?: number;
  uuid?: string;
  name?: string;
  size?: number;
  browser_download_url?: string;
};

export type ForgejoRelease = {
  id?: number;
  name?: string;
  tag_name?: string;
  body?: string;
  html_url?: string;
  prerelease?: boolean;
  draft?: boolean;
  published_at?: string;
  author?: ForgejoUser;
  assets?: ForgejoReleaseAttachment[];
};

export interface GlobalSearchResult {
  repositories: ForgejoRepository[];
  issues: ForgejoIssue[];
  pullRequests: ForgejoPullRequest[];
}
