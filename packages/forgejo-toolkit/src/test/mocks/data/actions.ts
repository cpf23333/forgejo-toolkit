import type { ActionRun, ActionRunJob, ActionArtifact, DispatchWorkflowRun } from '@cpf23333-forgejo-toolkit/api';

// The single-run fixture's id/index, so the generated list starts with it and
// assertions about `mockActionRun` keep pointing at the first page's first row.
const ACTION_RUN_BASE_ID = 42;
const ACTION_RUN_INDEX = 1;
const ACTION_RUN_CREATED_MS = Date.parse('2026-08-17T09:00:00Z');
const ACTION_RUN_SECONDS = 595;
// Minted by the dispatch fixture; a run the fixtures declare but that is not one
// of the pre-existing entries in `mockActionRuns`.
const DISPATCHED_RUN_ID = 99;

/**
 * One finished run, in the shape `structs.ActionRun` reports.
 *
 * The ref is `prettyref` (a run has no `head_branch`; that belongs to a job), the
 * URL is `html_url` (a run has no `url`), and the timestamps are
 * `created`/`started`/`stopped`/`updated` — never `created_at`/`updated_at`.
 * `duration` is a Go `time.Duration`, i.e. nanoseconds, which is what the run
 * detail view formats. The older spellings were silently ignored: the detail
 * view's branch icon only renders when `prettyref` is set, so a fixture that
 * carried `head_branch` hid that line in the dev host while a real instance
 * would have shown it.
 */
export const mockActionRun = {
  id: ACTION_RUN_BASE_ID,
  index_in_repo: ACTION_RUN_INDEX,
  title: 'CI',
  event: 'push',
  trigger_event: 'push',
  status: 'success',
  workflow_id: 'ci.yaml',
  commit_sha: 'abc123',
  prettyref: 'main',
  html_url: `https://forgejo.example.com/demo-user/demo-repo/actions/runs/${ACTION_RUN_BASE_ID}`,
  created: '2026-08-17T09:00:00Z',
  started: '2026-08-17T09:00:05Z',
  stopped: '2026-08-17T09:10:00Z',
  updated: '2026-08-17T09:10:00Z',
  duration: ACTION_RUN_SECONDS * 1_000_000_000,
  is_fork_pull_request: false,
  need_approval: false,
} satisfies ActionRun;

/**
 * More runs than one page of 30, so the Actions list has a second page: the
 * "Load more" flow (append, then hide on the last page) needs a full first page
 * and a short second one, which a single-run fixture cannot exercise. The first
 * entry is `mockActionRun`, so assertions about it keep working.
 */
export const mockActionRuns: ActionRun[] = Array.from({ length: 35 }, (_, index) => {
  const id = ACTION_RUN_BASE_ID + index;
  const createdMs = ACTION_RUN_CREATED_MS - index * 3_600_000;
  return {
    ...mockActionRun,
    id,
    index_in_repo: ACTION_RUN_INDEX + index,
    title: `CI run ${index + 1}`,
    html_url: `https://forgejo.example.com/demo-user/demo-repo/actions/runs/${id}`,
    created: new Date(createdMs).toISOString(),
    started: new Date(createdMs + 5_000).toISOString(),
    stopped: new Date(createdMs + (ACTION_RUN_SECONDS + 5) * 1_000).toISOString(),
    updated: new Date(createdMs + (ACTION_RUN_SECONDS + 5) * 1_000).toISOString(),
  };
});

/** A job of `mockActionRun`, with the fields `structs.ActionRunJob` reports. */
export const mockActionRunJob = {
  id: 101,
  run_id: ACTION_RUN_BASE_ID,
  name: 'build',
  status: 'success',
  attempt: 1,
  task_id: 7,
  runs_on: ['ubuntu-latest'],
} satisfies ActionRunJob;

export const mockActionArtifact = {
  id: 7,
  name: 'build-artifact',
  size_in_bytes: 1234,
  // `structs.ActionArtifact` carries the download URL as `archive_download_url`
  // and has no plain `url`; `run_id` is filled in by the handler for the run that
  // was asked for.
  archive_download_url: 'https://forgejo.example.com/demo-user/demo-repo/actions/artifacts/7/zip',
  expired: false,
  run_id: ACTION_RUN_BASE_ID,
  created_at: '2026-08-17T09:10:00Z',
} satisfies ActionArtifact;

/** The `return_run_info: true` answer of a workflow dispatch (`jobs` = names). */
export const mockDispatchWorkflowRun = {
  id: DISPATCHED_RUN_ID,
  run_number: 2,
  jobs: ['build'],
} satisfies DispatchWorkflowRun;

/**
 * The run a dispatch creates. The webview opens `mockDispatchWorkflowRun.id`
 * as soon as the dispatch is accepted, so the run detail endpoint has to know
 * it: it is a run the fixtures declare, just not one of the pre-existing 35 in
 * `mockActionRuns` (its index follows them).
 */
export const mockDispatchedActionRun: ActionRun = {
  ...mockActionRun,
  id: DISPATCHED_RUN_ID,
  index_in_repo: ACTION_RUN_INDEX + mockActionRuns.length,
  html_url: `https://forgejo.example.com/demo-user/demo-repo/actions/runs/${DISPATCHED_RUN_ID}`,
};
