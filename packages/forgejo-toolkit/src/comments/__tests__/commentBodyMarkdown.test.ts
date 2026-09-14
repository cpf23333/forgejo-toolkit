import { describe, it, expect } from 'vitest';
import { toHardBreakMarkdown } from '../commentBodyMarkdown';

describe('toHardBreakMarkdown', () => {
  it('turns single newlines into hard breaks like Forgejo comment rendering', () => {
    expect(toHardBreakMarkdown('first\nsecond')).toBe('first  \nsecond  ');
  });

  it('keeps newlines inside fenced code blocks literal', () => {
    const body = 'before\n```ts\nconst a = 1;\nconst b = 2;\n```\nafter';
    expect(toHardBreakMarkdown(body)).toBe('before  \n```ts\nconst a = 1;\nconst b = 2;\n```\nafter  ');
  });

  it('handles tilde fences and indented fences', () => {
    expect(toHardBreakMarkdown('~~~\ncode\n~~~')).toBe('~~~\ncode\n~~~');
    expect(toHardBreakMarkdown('  ```\ncode\n  ```')).toBe('  ```\ncode\n  ```');
  });

  it('leaves blank lines and existing hard breaks untouched', () => {
    expect(toHardBreakMarkdown('a  \n\nb')).toBe('a  \n\nb  ');
  });
});
