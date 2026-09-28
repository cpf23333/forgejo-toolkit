import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { FileContentResult } from '../../api/client';
import {
  parseWorkflowDispatchInputs,
  readWorkflowDispatchInputs,
  workflowFileCandidates,
  WORKFLOW_DIRECTORIES,
} from '../workflowDispatchInputs';

function file(text: string): FileContentResult {
  return { kind: 'file', text };
}

/**
 * The declared-inputs subset Forgejo reads out of a workflow file. The tests
 * pin every shape the form depends on: a quoted default, an inline comment, a
 * boolean default, `required`, `type`, `options`, and the nested indentation
 * that carries `on.workflow_dispatch.inputs`.
 */
describe('parseWorkflowDispatchInputs', () => {
  it('reads the inputs of the release workflow, comments, quoting and all', () => {
    const result = parseWorkflowDispatchInputs(`
name: Release

on:
  workflow_dispatch:
    inputs:
      # The tag to release; the workflow reads it as \`tag\`.
      tag:
        description: "Release tag (e.g. v1.2.3)"
        type: string
        default: ''   # empty means the current ref
        required: true
      prerelease:
        description: Mark the release as a prerelease
        type: boolean
        default: false
      dry_run:
        description: Only print what would happen
        type: boolean
        default: true
  push:
    tags: ['v*']
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - run: echo done
`);

    expect(result).toEqual({
      status: 'ok',
      inputs: [
        {
          name: 'tag',
          type: 'string',
          declaredType: 'string',
          description: 'Release tag (e.g. v1.2.3)',
          default: '',
          required: true,
        },
        {
          name: 'prerelease',
          type: 'boolean',
          declaredType: 'boolean',
          description: 'Mark the release as a prerelease',
          default: 'false',
          required: false,
        },
        {
          name: 'dry_run',
          type: 'boolean',
          declaredType: 'boolean',
          description: 'Only print what would happen',
          default: 'true',
          required: false,
        },
      ],
    });
  });

  it('builds a select from a choice input options list', () => {
    const result = parseWorkflowDispatchInputs(`
on:
  workflow_dispatch:
    inputs:
      target:
        type: choice
        description: Where to deploy
        options:
          - staging
          - 'production'
        default: staging
`);

    expect(result).toEqual({
      status: 'ok',
      inputs: [
        {
          name: 'target',
          type: 'choice',
          declaredType: 'choice',
          description: 'Where to deploy',
          default: 'staging',
          required: false,
          options: ['staging', 'production'],
        },
      ],
    });
  });

  it('stringifies scalar defaults and options of every scalar type', () => {
    const result = parseWorkflowDispatchInputs(`
on:
  workflow_dispatch:
    inputs:
      retries:
        type: number
        default: 3
      enabled:
        default: true
        required: true
      channel:
        type: choice
        options: [1, 2.5, true, stable]
`);

    expect(result).toEqual({
      status: 'ok',
      inputs: [
        { name: 'retries', type: 'string', declaredType: 'number', default: '3', required: false },
        { name: 'enabled', type: 'string', declaredType: 'string', default: 'true', required: true },
        {
          name: 'channel',
          type: 'choice',
          declaredType: 'choice',
          required: false,
          options: ['1', '2.5', 'true', 'stable'],
        },
      ],
    });
  });

  it('renders a type it has no control for as a text field', () => {
    const result = parseWorkflowDispatchInputs(`
on:
  workflow_dispatch:
    inputs:
      environment:
        type: environment
        description: Deployment environment
      flavour:
        type: choice
      mystery:
        type: quantum
`);

    expect(result).toMatchObject({
      status: 'ok',
      inputs: [
        { name: 'environment', type: 'string', declaredType: 'environment' },
        // A `choice` with no usable options would be an empty select: it falls
        // back to a text field, with the declared type still reported.
        { name: 'flavour', type: 'string', declaredType: 'choice' },
        { name: 'mystery', type: 'string', declaredType: 'quantum' },
      ],
    });
  });

  it('treats a choice whose options are not scalars as a text field', () => {
    const result = parseWorkflowDispatchInputs(`
on:
  workflow_dispatch:
    inputs:
      target:
        type: choice
        options:
          - name: staging
            url: https://staging.example.com
`);

    expect(result).toMatchObject({
      status: 'ok',
      inputs: [{ name: 'target', type: 'string', declaredType: 'choice' }],
    });
  });

  it('honours required in its YAML 1.1 spellings', () => {
    const result = parseWorkflowDispatchInputs(`
on:
  workflow_dispatch:
    inputs:
      a:
        required: yes
      b:
        required: 'on'
      c:
        required: 'no'
      d:
        required: 3
`);

    expect(result).toMatchObject({
      status: 'ok',
      inputs: [
        { name: 'a', required: true },
        { name: 'b', required: true },
        { name: 'c', required: false },
        { name: 'd', required: false },
      ],
    });
  });

  it('ignores a description that is not a string', () => {
    const result = parseWorkflowDispatchInputs(`
on:
  workflow_dispatch:
    inputs:
      tag:
        description:
          text: nonsense
`);

    expect(result).toEqual({
      status: 'ok',
      inputs: [{ name: 'tag', type: 'string', declaredType: 'string', required: false }],
    });
  });

  it('reads this repository own release workflow, the file the report was about', () => {
    // The motivating case: `.forgejo/workflows/release.yml` declares `tag`,
    // `prerelease` and `dry_run`, and each description repeats its input name
    // only because Forgejo's own form never shows the name.
    const text = readFileSync(path.resolve(__dirname, '../../../../../.forgejo/workflows/release.yml'), 'utf8');

    const result = parseWorkflowDispatchInputs(text);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      return;
    }
    const byName = new Map(result.inputs.map((input) => [input.name, input]));
    expect(byName.get('tag')).toMatchObject({ type: 'string', default: '', required: false });
    expect(byName.get('prerelease')).toMatchObject({ type: 'boolean', default: 'false', required: false });
    expect(byName.get('dry_run')).toMatchObject({ type: 'boolean', default: 'true', required: false });
    for (const input of result.inputs) {
      expect(input.description, input.name).toBeTruthy();
    }
  });

  it.each([
    ['no on block at all', 'name: Release\njobs:\n  build:\n    runs-on: ubuntu-latest\n'],
    ['on as a string', 'on: push\n'],
    ['on as a list', 'on: [push, pull_request]\n'],
    ['no workflow_dispatch trigger', 'on:\n  push:\n    branches: [main]\n'],
    ['a bare workflow_dispatch', 'on:\n  workflow_dispatch:\n'],
    ['an empty inputs mapping', 'on:\n  workflow_dispatch:\n    inputs: {}\n'],
  ])('answers "no inputs" for %s', (_label, yaml) => {
    expect(parseWorkflowDispatchInputs(yaml)).toEqual({ status: 'no-inputs' });
  });

  it.each([
    ['invalid YAML', 'on: [unclosed\n'],
    ['multiple documents', 'on: push\n---\non: pull_request\n'],
    ['a top level that is not a mapping', '- on\n- workflow_dispatch\n'],
    ['inputs as a list', 'on:\n  workflow_dispatch:\n    inputs:\n      - tag\n'],
    ['an input declaration that is a string', 'on:\n  workflow_dispatch:\n    inputs:\n      tag: string\n'],
    [
      'a default that is a mapping',
      'on:\n  workflow_dispatch:\n    inputs:\n      tag:\n        default:\n          a: b\n',
    ],
  ])('refuses %s instead of guessing', (_label, yaml) => {
    const result = parseWorkflowDispatchInputs(yaml);
    expect(result.status).toBe('malformed');
    if (result.status === 'malformed') {
      expect(result.error).not.toBe('');
    }
  });
});

describe('workflowFileCandidates', () => {
  it('lists the three directories Forgejo reads, in order', () => {
    expect(workflowFileCandidates('release.yml')).toEqual([
      '.forgejo/workflows/release.yml',
      '.gitea/workflows/release.yml',
      '.github/workflows/release.yml',
    ]);
    expect(WORKFLOW_DIRECTORIES).toHaveLength(3);
  });

  it('keeps a subdirectory and trims surrounding whitespace', () => {
    expect(workflowFileCandidates('  nightly/ci.yml  ')[0]).toBe('.forgejo/workflows/nightly/ci.yml');
  });

  it.each(['', '   ', '../secrets.yml', '/etc/passwd', 'a\\b.yml', '.'])('rejects the unsafe name %j', (name) => {
    expect(workflowFileCandidates(name)).toEqual([]);
  });
});

describe('readWorkflowDispatchInputs', () => {
  const inputsYaml = 'on:\n  workflow_dispatch:\n    inputs:\n      tag:\n        type: string\n';

  function reader(answers: Record<string, FileContentResult | Error>) {
    return {
      getFileContentResult: vi.fn(async (_owner: string, _repo: string, path: string) => {
        const answer = answers[path];
        if (answer === undefined) {
          // The shape the generated client's 404 arrives in: `toApiError`
          // classifies it as an HTTP 404, which the reader treats as "this
          // candidate path does not exist" rather than as a failure to report.
          throw new Error(`Forgejo API error 404: ${path} not found`);
        }
        if (answer instanceof Error) {
          throw answer;
        }
        return answer;
      }),
    };
  }

  it('reads the .forgejo path when it is there', async () => {
    const client = reader({ '.forgejo/workflows/release.yml': file(inputsYaml) });

    const result = await readWorkflowDispatchInputs(client, 'owner', 'repo', 'release.yml', 'main');

    expect(result).toMatchObject({
      status: 'ok',
      path: '.forgejo/workflows/release.yml',
      inputs: [{ name: 'tag', type: 'string', declaredType: 'string', required: false }],
    });
    expect(client.getFileContentResult).toHaveBeenCalledTimes(1);
    expect(client.getFileContentResult).toHaveBeenCalledWith('owner', 'repo', '.forgejo/workflows/release.yml', 'main');
  });

  it('falls through to the compatibility directories and stops at the first file', async () => {
    const client = reader({ '.github/workflows/ci.yml': file(inputsYaml) });

    const result = await readWorkflowDispatchInputs(client, 'owner', 'repo', 'ci.yml', 'dev');

    expect(result).toMatchObject({ status: 'ok', path: '.github/workflows/ci.yml' });
    expect(client.getFileContentResult.mock.calls.map((call) => call[2])).toEqual([
      '.forgejo/workflows/ci.yml',
      '.gitea/workflows/ci.yml',
      '.github/workflows/ci.yml',
    ]);
  });

  it('skips a candidate that is not a regular file', async () => {
    const client = reader({
      '.forgejo/workflows/ci.yml': { kind: 'directory', text: 'ci.yml is a directory, not a file' },
      '.gitea/workflows/ci.yml': file(inputsYaml),
    });

    const result = await readWorkflowDispatchInputs(client, 'owner', 'repo', 'ci.yml', 'main');

    expect(result).toMatchObject({ status: 'ok', path: '.gitea/workflows/ci.yml' });
  });

  it('reports a workflow with no declared inputs together with its path', async () => {
    const client = reader({ '.forgejo/workflows/ci.yml': file('on:\n  push:\n    branches: [main]\n') });

    const result = await readWorkflowDispatchInputs(client, 'owner', 'repo', 'ci.yml', 'main');

    expect(result).toEqual({ status: 'no-inputs', path: '.forgejo/workflows/ci.yml' });
  });

  it('reports a malformed file at the path it found, without trying the other directories', async () => {
    const client = reader({ '.forgejo/workflows/ci.yml': file('on: [unclosed\n') });

    const result = await readWorkflowDispatchInputs(client, 'owner', 'repo', 'ci.yml', 'main');

    expect(result.status).toBe('unreadable');
    if (result.status === 'unreadable') {
      expect(result.path).toBe('.forgejo/workflows/ci.yml');
      expect(result.error).toContain('not valid YAML');
    }
    expect(client.getFileContentResult).toHaveBeenCalledTimes(1);
  });

  it('reports a workflow file whose payload Forgejo withheld', async () => {
    const client = reader({
      '.forgejo/workflows/ci.yml': { kind: 'withheld', text: 'Forgejo did not return this file content' },
    });

    const result = await readWorkflowDispatchInputs(client, 'owner', 'repo', 'ci.yml', 'main');

    expect(result.status).toBe('unreadable');
    if (result.status === 'unreadable') {
      expect(result.path).toBe('.forgejo/workflows/ci.yml');
      expect(result.error).toContain('larger than this instance returns');
    }
    // The other directories are not tried: the file that was found is the one
    // the dispatch would use.
    expect(client.getFileContentResult).toHaveBeenCalledTimes(1);
  });

  it('names the directories it searched when no candidate exists', async () => {
    const client = reader({});

    const result = await readWorkflowDispatchInputs(client, 'owner', 'repo', 'missing.yml', 'main');

    expect(result).toEqual({
      status: 'unreadable',
      error:
        'No workflow file named "missing.yml" was found in .forgejo/workflows, .gitea/workflows, .github/workflows.',
    });
  });

  it('surfaces the API sentence when a candidate failed for another reason', async () => {
    const client = reader({
      '.forgejo/workflows/ci.yml': new Error('Forbidden'),
      '.gitea/workflows/ci.yml': new Error('Forbidden'),
      '.github/workflows/ci.yml': new Error('Forbidden'),
    });

    const result = await readWorkflowDispatchInputs(client, 'owner', 'repo', 'ci.yml', 'main');

    expect(result.status).toBe('unreadable');
    if (result.status === 'unreadable') {
      expect(result.error).toContain('Forbidden');
      expect(result.path).toBeUndefined();
    }
  });

  it('refuses an unsafe filename without calling the API', async () => {
    const client = reader({});

    const result = await readWorkflowDispatchInputs(client, 'owner', 'repo', '../admin.yml', 'main');

    expect(result).toEqual({ status: 'unreadable', error: 'The request could not be completed' });
    expect(client.getFileContentResult).not.toHaveBeenCalled();
  });
});
