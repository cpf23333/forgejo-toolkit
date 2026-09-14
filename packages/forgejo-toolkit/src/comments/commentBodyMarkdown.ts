/**
 * Convert a Forgejo comment body for VS Code's MarkdownString rendering.
 * Forgejo (like GitHub) renders single newlines in comments as line breaks
 * (GFM "breaks"), while MarkdownString follows CommonMark and collapses them
 * into a space. Emit a two-space hard break at the end of each content line,
 * except inside fenced code blocks where newlines are already literal.
 */
export function toHardBreakMarkdown(text: string): string {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence || line.trim() === '' || line.endsWith('  ')) {
        return line;
      }
      return `${line}  `;
    })
    .join('\n');
}
