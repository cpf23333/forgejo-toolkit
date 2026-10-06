import { describe, expect, it } from 'vitest';
import {
  ISSUE_TRIAGE_ISSUE_BODY_BUDGET,
  ISSUE_TRIAGE_MAX_COMMENTS,
  ISSUE_TRIAGE_MAX_LABEL_SUGGESTIONS,
  ISSUE_TRIAGE_SYSTEM_PROMPT,
  buildIssueTriageBrief,
  buildIssueTriageSystemPrompt,
  parseIssueTriageAnswer,
  suggestableLabels,
  validateIssueTriageAnswer,
  type IssueTriageBriefInput,
} from '../issueTriageBrief';

/**
 * The pure half of issue label suggestions: what the prompt carries, what the budgets
 * cut, which labels may be suggested at all, and what an answer has to be before any of
 * it counts as a suggestion.
 *
 * Nothing here touches `vscode`, which is the point of the split: the assembly and the
 * validator are the two pieces that decide what leaves the machine and what the user is
 * offered, so they are tested with malformed input rather than through a run.
 */

const LABELS = [
  { id: 11, name: 'bug', description: 'Something is not working', color: 'd73a4a' },
  { id: 12, name: 'documentation', description: 'Improvements or additions to documentation' },
  { id: 13, name: 'good first issue' },
];

function input(overrides: Partial<IssueTriageBriefInput> = {}): IssueTriageBriefInput {
  return {
    repository: 'owner/repo',
    issueNumber: 42,
    title: 'Crash when the cache is empty',
    body: 'Steps to reproduce:\n1. clear the cache\n2. open the dashboard',
    labels: LABELS,
    ...overrides,
  };
}

describe('the label-suggestion instruction block', () => {
  it('states the JSON contract, the candidate set and the cap', () => {
    const prompt = buildIssueTriageSystemPrompt();
    expect(prompt).toContain('"labels"');
    expect(prompt).toContain('[labels]');
    expect(prompt).toContain(`At most ${ISSUE_TRIAGE_MAX_LABEL_SUGGESTIONS} labels`);
    // The narrowing is part of the contract the model is given: it is never asked about
    // assignees, so it cannot answer about them.
    expect(prompt).not.toContain('assignee');
    expect(prompt).not.toContain('[assignees]');
    // "Discarded" is stated, so a model that pads the answer has been told what happens;
    // nothing about it is repaired downstream.
    expect(prompt).toContain('discarded');
    expect(prompt).toContain('{"labels": []}');
  });

  it('is a constant the tests can pin', () => {
    expect(ISSUE_TRIAGE_SYSTEM_PROMPT).toBe(buildIssueTriageSystemPrompt());
  });
});

describe('the candidate labels', () => {
  it('keeps the repository\u2019s own labels and counts what it leaves out', () => {
    const { labels, archived, unidentifiable } = suggestableLabels([
      { id: 1, name: 'bug', description: ' broken ', color: 'ff0000' },
      { id: 2, name: 'old', is_archived: true },
      { id: 3, is_archived: true },
      { name: 'no-id' },
      { id: 4, name: '   ' },
      { id: 5, name: 'plain' },
    ]);

    expect(labels).toEqual([
      { id: 1, name: 'bug', description: ' broken ', color: 'ff0000' },
      { id: 5, name: 'plain' },
    ]);
    // Archived first: an archived label is not "unidentifiable" even when it has no id,
    // so the two counts stay about different facts.
    expect(archived).toBe(2);
    expect(unidentifiable).toBe(2);
  });

  it('produces nothing at all from a repository with no label', () => {
    expect(suggestableLabels([])).toEqual({ labels: [], archived: 0, unidentifiable: 0 });
  });
});

describe('the label-suggestion brief', () => {
  it('carries the issue and the repository\u2019s label list', () => {
    const brief = buildIssueTriageBrief(input());

    expect(brief.text).toContain('[issue]');
    expect(brief.text).toContain('repository: owner/repo');
    expect(brief.text).toContain('issue: #42');
    expect(brief.text).toContain('Crash when the cache is empty');
    expect(brief.text).toContain('clear the cache');
    expect(brief.text).toContain('[labels]');
    expect(brief.text).toContain('- bug — Something is not working');
    expect(brief.text).toContain('- good first issue');
    // No login list, and no discussion without the scope that promises it.
    expect(brief.text).not.toContain('[assignees]');
    expect(brief.text).not.toContain('[discussion]');
    expect(brief.commentsShown).toBe(0);
  });

  it('renders an empty candidate list truthfully rather than as a blank', () => {
    // The run refuses before assembling a prompt for a repository with no label, so this
    // case only arises for a hand-built brief; it must still say what it is.
    const brief = buildIssueTriageBrief(input({ labels: [] }));

    expect(brief.text).toContain('this repository declares no label');
    expect(brief.text).toContain('answer with an empty "labels" list');
    expect(brief.labelsTotal).toBe(0);
    expect(brief.labelsShown).toBe(0);
  });

  it('announces a cut issue body inside the prompt', () => {
    const brief = buildIssueTriageBrief(input({ body: 'x'.repeat(ISSUE_TRIAGE_ISSUE_BODY_BUDGET + 10) }));

    expect(brief.truncatedBy).toBe('issue-body');
    expect(brief.text).toContain('[truncated: only the beginning of the issue body is shown]');
  });

  it('carries the discussion only when it was handed one, oldest first, with cuts announced', () => {
    const comments = Array.from({ length: ISSUE_TRIAGE_MAX_COMMENTS + 1 }, (_, index) => ({
      body: `comment ${index}`,
      author: 'alice',
      date: '2026-08-01T10:00:00Z',
    }));
    const brief = buildIssueTriageBrief(input({ comments }));

    expect(brief.commentsTotal).toBe(ISSUE_TRIAGE_MAX_COMMENTS + 1);
    expect(brief.commentsShown).toBe(ISSUE_TRIAGE_MAX_COMMENTS);
    expect(brief.truncatedBy).toBe('comment-limit');
    expect(brief.text).toContain('[discussion]');
    expect(brief.text).toContain('@alice');
    expect(brief.text).toContain('comment 0');
    expect(brief.text).toContain(`[truncated: only ${ISSUE_TRIAGE_MAX_COMMENTS} of ${ISSUE_TRIAGE_MAX_COMMENTS + 1}`);
  });

  it('cuts the candidate table at its row cap and says how many are listed', () => {
    const labels = Array.from({ length: 120 }, (_, index) => ({ id: index + 1, name: `label-${index}` }));
    const brief = buildIssueTriageBrief(input({ labels }));

    expect(brief.labelsTotal).toBe(120);
    expect(brief.labelsShown).toBeLessThan(120);
    expect(brief.truncatedBy).toBe('label-limit');
    expect(brief.text).toContain(`[truncated: only ${brief.labelsShown} of 120 label(s) are listed]`);
  });
});

describe('the answer contract', () => {
  it('parses the contracted object and unwraps a JSON code fence', () => {
    expect(parseIssueTriageAnswer('{"labels": ["bug"]}')).toEqual({ kind: 'ok', labels: ['bug'] });
    expect(parseIssueTriageAnswer('```json\n{"labels": []}\n```')).toEqual({ kind: 'ok', labels: [] });
  });

  it('keeps the three failures apart', () => {
    expect(parseIssueTriageAnswer('   ')).toEqual({ kind: 'empty' });
    expect(parseIssueTriageAnswer('Sure! Here is the JSON:')).toEqual({ kind: 'not-json' });
    expect(parseIssueTriageAnswer('["bug"]')).toEqual({ kind: 'wrong-shape', field: 'root' });
    expect(parseIssueTriageAnswer('{"assignees": []}')).toEqual({ kind: 'wrong-shape', field: 'labels' });
    expect(parseIssueTriageAnswer('{"labels": "bug"}')).toEqual({ kind: 'wrong-shape', field: 'labels' });
  });
});

describe('resolving an answer against the repository\u2019s labels', () => {
  const brief = buildIssueTriageBrief(input());

  it('resolves only exact names, and counts everything else', () => {
    const accepted = validateIssueTriageAnswer(
      brief,
      parseIssueTriageAnswer(JSON.stringify({ labels: ['bug', 'Bug', 'not-a-label', ''] })),
    );

    // Exact equality only: "Bug" is not "bug", and an empty entry is not a name.
    expect(accepted.labels).toEqual([{ id: 11, name: 'bug', color: 'd73a4a' }]);
    expect(accepted.dropped).toEqual([
      { reason: 'invalid-shape', count: 1 },
      { reason: 'label-not-in-repository', count: 2 },
    ]);
  });

  it('collapses duplicates instead of counting them as refusals', () => {
    const accepted = validateIssueTriageAnswer(brief, parseIssueTriageAnswer('{"labels": ["bug", "bug"]}'));

    expect(accepted.labels).toHaveLength(1);
    expect(accepted.dropped).toEqual([]);
  });

  it('counts entries past the cap as over-limit, not as unresolvable', () => {
    // Seven distinct real labels in the answer, five of which may be considered: the two
    // past the cap were never looked at, which is a different fact from "the model named
    // something this repository does not have".
    const many = Array.from({ length: 7 }, (_, index) => ({ id: index + 1, name: `label-${index}` }));
    const wide = buildIssueTriageBrief(input({ labels: many }));
    const accepted = validateIssueTriageAnswer(
      wide,
      parseIssueTriageAnswer(JSON.stringify({ labels: many.map((label) => label.name) })),
    );

    expect(accepted.labels).toHaveLength(ISSUE_TRIAGE_MAX_LABEL_SUGGESTIONS);
    expect(accepted.dropped).toEqual([{ reason: 'over-limit', count: 2 }]);
  });

  it('drops every label when the repository declares none, and does not invent one', () => {
    const empty = buildIssueTriageBrief(input({ labels: [] }));
    const accepted = validateIssueTriageAnswer(empty, parseIssueTriageAnswer('{"labels": ["bug"]}'));

    expect(accepted.labels).toEqual([]);
    expect(accepted.dropped).toEqual([{ reason: 'label-not-in-repository', count: 1 }]);
  });

  it('produces nothing at all from a contract failure', () => {
    const accepted = validateIssueTriageAnswer(brief, parseIssueTriageAnswer('not json'));
    expect(accepted).toEqual({ labels: [], dropped: [] });
  });

  it('accepts an answer that suggests nothing', () => {
    const accepted = validateIssueTriageAnswer(brief, parseIssueTriageAnswer('{"labels": []}'));
    expect(accepted).toEqual({ labels: [], dropped: [] });
  });
});
