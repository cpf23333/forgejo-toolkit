import { describe, expect, it } from 'vitest';
import { removePendingImageFromBody } from '../pendingImageMarkdown';

describe('removePendingImageFromBody', () => {
  it('drops the image syntax the editor inserted for the object URL', () => {
    const body = 'Step one\n\n![image](blob:pending-1)\n\nStep two';

    expect(removePendingImageFromBody(body, 'blob:pending-1')).toBe('Step one\n\n\n\nStep two');
    expect(removePendingImageFromBody(body, 'blob:pending-1')).not.toContain('blob:');
  });

  it('keeps the other images and text intact', () => {
    const body = '![image](blob:pending-1)\ntext\n![image](blob:pending-2)\n![image](/attachments/uuid-1)';

    const result = removePendingImageFromBody(body, 'blob:pending-1');

    expect(result).toContain('![image](blob:pending-2)');
    expect(result).toContain('![image](/attachments/uuid-1)');
    expect(result).toContain('text');
    expect(result).not.toContain('blob:pending-1');
  });

  it('removes a URL the user reused outside an image and cleans the empty syntax', () => {
    const body = 'See [the screenshot](blob:pending-1) and ![my shot](blob:pending-1)';

    const result = removePendingImageFromBody(body, 'blob:pending-1');

    expect(result).toBe('See [the screenshot]() and ');
  });

  it('returns the body unchanged for an empty URL or body', () => {
    expect(removePendingImageFromBody('text', '')).toBe('text');
    expect(removePendingImageFromBody('', 'blob:pending-1')).toBe('');
  });
});
