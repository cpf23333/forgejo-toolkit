import type { ActionRun, ActionRunJob, ActionArtifact, DispatchWorkflowRun } from '@cpf23333-forgejo-toolkit/api';

// The single-run fixture's id/index, so the generated list starts with it and
// assertions about `mockActionRun` keep pointing at the first page's first row.
const ACTION_RUN_BASE_ID = 42;
const ACTION_RUN_INDEX = 1;

export const mockActionRun = {
  id: 42,
  title: 'CI',
  head_branch: 'main',
  index_in_repo: 1,
  event: 'push',
  status: 'success',
  workflow_id: 'ci.yaml',
  url: 'https://forgejo.example.com/demo-user/demo-repo/actions/runs/42',
  html_url: 'https://forgejo.example.com/demo-user/demo-repo/actions/runs/42',
  created_at: '2026-08-17T09:00:00Z',
  updated_at: '2026-08-17T09:10:00Z',
} as unknown as ActionRun;

/**
 * More runs than one page of 30, so the Actions list has a second page: the
 * "Load more" flow (append, then hide on the last page) needs a full first page
 * and a short second one, which a single-run fixture cannot exercise. The first
 * entry is `mockActionRun`, so assertions about it keep working.
 */
export const mockActionRuns = Array.from({ length: 35 }, (_, index) => {
  const id = ACTION_RUN_BASE_ID + index;
  return {
    ...mockActionRun,
    id,
    index_in_repo: ACTION_RUN_INDEX + index,
    title: `CI run ${index + 1}`,
    url: `https://forgejo.example.com/demo-user/demo-repo/actions/runs/${id}`,
    html_url: `https://forgejo.example.com/demo-user/demo-repo/actions/runs/${id}`,
    created_at: new Date(Date.parse('2026-08-17T09:00:00Z') - index * 3_600_000).toISOString(),
    updated_at: new Date(Date.parse('2026-08-17T09:10:00Z') - index * 3_600_000).toISOString(),
  } as unknown as ActionRun;
});

export const mockActionRunJob = {
  id: 101,
  run_id: 42,
  name: 'build',
  status: 'success',
} as unknown as ActionRunJob;

export const mockActionArtifact = {
  id: 7,
  name: 'build-artifact',
  size_in_bytes: 1234,
  url: 'https://forgejo.example.com/demo-user/demo-repo/actions/artifacts/7',
  archive_download_url: 'https://forgejo.example.com/demo-user/demo-repo/actions/artifacts/7/zip',
} as unknown as ActionArtifact;

export const mockDispatchWorkflowRun = {
  id: 99,
  run_number: 2,
  jobs: [],
} as unknown as DispatchWorkflowRun;
