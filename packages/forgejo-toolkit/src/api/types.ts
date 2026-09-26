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
  clone_url?: string;
  ssh_url?: string;
  private: boolean;
  description: string;
  owner: ForgejoUser;
  default_branch: string;
  stars_count: number;
  forks_count: number;
  open_issues_count: number;
  open_pr_counter?: number;
  has_issues?: boolean;
  has_pull_requests?: boolean;
  mirror?: boolean;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
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
  head?: { ref?: string; label?: string; repo?: { full_name?: string } | null };
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
  labels?: ForgejoLabel[];
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
  /**
   * True when the base branch's protection rules could not be read (they need
   * repository admin rights), so the merge status may be incomplete.
   */
  protectionUnknown?: boolean;
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

/**
 * What a README entry is when the contents API answered with something that has
 * no text: a symlink (`type: 'symlink'`) or a submodule (`type: 'submodule'`).
 *
 * This is the structured form of the sentence `readme` carries for those kinds:
 * a localized caller (the extension host's dashboard) builds its own sentence
 * from `kind` and `target` instead of showing the client's English one, which
 * stays in `readme` for the headless MCP consumers.
 */
export interface ForgejoReadmeNotice {
  kind: 'symlink' | 'submodule';
  /**
   * What the entry names: the symlink's link target path, or the submodule's
   * own git URL. Absent when the server omitted it — a sentence must then say
   * what the entry is without inventing a destination.
   */
  target?: string;
}

export interface ForgejoRepoDetail {
  repository: ForgejoRepository;
  empty: boolean;
  /**
   * The README's text for a regular file, the client's English notice for a
   * symlink or submodule README (whose structured form is `readmeNotice`), and
   * undefined when there is no README or when the instance withheld its
   * payload (`readmeSize`).
   */
  readme?: string;
  /**
   * What the README entry actually is, for the kinds that never carry text.
   * Undefined for a regular file (with or without its payload) and for an
   * absent README.
   */
  readmeNotice?: ForgejoReadmeNotice;
  /**
   * The real size of the README whose payload the contents API withheld.
   *
   * Undefined for a README that arrived, a genuinely empty one (size 0), an
   * absent one, and a README that is not a regular file at all (a symlink or a
   * submodule, see `readmeNotice`) — exactly the cases with nothing to explain.
   * The contents endpoint reports a `size` for a symlink equal to the *link
   * target's* length and 0 for a submodule, so neither is a payload size and
   * neither may reach the withheld-payload notice. Carrying the real one here
   * is what lets a caller render that notice without re-probing
   * `/contents/README.md`.
   */
  readmeSize?: number;
  branches: string[];
  recentCommits: ForgejoCommit[];
}

export type ForgejoBranch = import('@cpf23333-forgejo-toolkit/api').Branch;

export type ForgejoTag = import('@cpf23333-forgejo-toolkit/api').Tag;

export type ForgejoRelease = import('@cpf23333-forgejo-toolkit/api').Release;

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
