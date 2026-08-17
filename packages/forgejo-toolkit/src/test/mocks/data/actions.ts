import type { ActionRun, ActionRunJob, ActionArtifact, DispatchWorkflowRun } from '@cpf23333-forgejo-toolkit/api';

export const mockActionRun = {
  id: 42,
  name: 'CI',
  head_branch: 'main',
  run_number: 1,
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  workflow_id: 1,
  url: 'https://forgejo.example.com/demo-user/demo-repo/actions/runs/42',
  html_url: 'https://forgejo.example.com/demo-user/demo-repo/actions/runs/42',
  created_at: '2026-08-17T09:00:00Z',
  updated_at: '2026-08-17T09:10:00Z',
} as unknown as ActionRun;

export const mockActionRunJob = {
  id: 101,
  run_id: 42,
  head_sha: 'abc123',
  name: 'build',
  status: 'completed',
  conclusion: 'success',
  started_at: '2026-08-17T09:00:00Z',
  completed_at: '2026-08-17T09:05:00Z',
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
  name: 'CI',
  html_url: 'https://forgejo.example.com/demo-user/demo-repo/actions/runs/99',
} as unknown as DispatchWorkflowRun;
