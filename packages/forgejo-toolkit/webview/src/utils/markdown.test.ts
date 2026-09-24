import { describe, it, expect } from 'vitest';
import { sanitizeMarkdownHtml } from './markdown';

const BASE_URL = 'https://forgejo.example.com/user/repo/';

describe('sanitizeMarkdownHtml', () => {
  describe('dangerous tags', () => {
    it('removes style tags together with their CSS content', () => {
      const html = '<p>hello</p><style>.markdown-content{position:fixed;inset:0}</style>';
      const result = sanitizeMarkdownHtml(html);
      expect(result).toContain('<p>hello</p>');
      expect(result).not.toContain('<style');
      expect(result).not.toContain('position:fixed');
    });

    it('removes link, base and meta tags', () => {
      const html =
        '<p>text</p><link rel="stylesheet" href="https://evil.example.com/x.css">' +
        '<base href="https://evil.example.com/"><meta http-equiv="refresh" content="0;url=https://evil.example.com">';
      const result = sanitizeMarkdownHtml(html);
      expect(result).toContain('<p>text</p>');
      expect(result).not.toContain('<link');
      expect(result).not.toContain('<base');
      expect(result).not.toContain('<meta');
      expect(result).not.toContain('evil.example.com');
    });

    it('removes script tags together with their content', () => {
      const result = sanitizeMarkdownHtml('<p>a</p><script>alert(1)</script>');
      expect(result).toContain('<p>a</p>');
      expect(result).not.toContain('alert');
    });
  });

  describe('dangerous href schemes', () => {
    it('unwraps a javascript: href into plain text instead of a dead live-looking link', () => {
      // Rewriting the href to `javascript:void(0)` without a `data-href` left the
      // anchor rendering in link colour and as a tab stop while activating it did
      // nothing at all — the same dead link the mailto:/file:/vscode: case fixed.
      const result = sanitizeMarkdownHtml('<a href="javascript:alert(1)">click</a>');
      expect(result).not.toContain('<a');
      expect(result).not.toContain('javascript:');
      expect(result).not.toContain('alert');
      expect(result).toContain('click');
    });

    it('unwraps data:text/html hrefs', () => {
      const result = sanitizeMarkdownHtml('<a href="data:text/html,<script>alert(1)</script>">click</a>');
      expect(result).not.toContain('<a');
      expect(result).not.toContain('data:text/html');
      expect(result).not.toContain('javascript:');
      expect(result).toContain('click');
    });

    it('keeps the text of a neutralized link inside a paragraph', () => {
      const result = sanitizeMarkdownHtml('<p>see <a href="javascript:void(0)">the docs</a> for it</p>');
      expect(result).toContain('see the docs for it');
      expect(result).not.toContain('<a');
    });
  });

  describe('SVG xlink:href', () => {
    it('unwraps javascript: xlink:href on SVG anchors', () => {
      const result = sanitizeMarkdownHtml('<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>');
      expect(result).not.toContain('<a');
      expect(result).not.toContain('javascript:');
      expect(result).not.toContain('alert');
      expect(result).toContain('<text>x</text>');
    });

    it('moves safe xlink:href values to data-href like regular hrefs', () => {
      const result = sanitizeMarkdownHtml(
        '<svg><a xlink:href="https://forgejo.example.com/u"><text>x</text></a></svg>',
      );
      expect(result).toContain('xlink:href="javascript:void(0)"');
      expect(result).toContain('data-href="https://forgejo.example.com/u"');
    });
  });

  describe('inline style attributes', () => {
    it('strips style attributes used for overlay phishing', () => {
      const result = sanitizeMarkdownHtml(
        '<div style="position:fixed;top:0;left:0;width:100%;height:100%">fake login</div>',
      );
      expect(result).not.toContain('style=');
      expect(result).toContain('fake login');
    });

    it('strips style attributes from nested elements', () => {
      const result = sanitizeMarkdownHtml('<p>outer<span style="color:red">inner</span></p>');
      expect(result).not.toContain('style=');
      expect(result).toContain('<span>inner</span>');
    });
  });

  describe('links the host cannot open', () => {
    it('renders a mailto: link as plain text', () => {
      const result = sanitizeMarkdownHtml('<p>write to <a href="mailto:dev@example.com">dev@example.com</a></p>');
      expect(result).toContain('write to dev@example.com');
      expect(result).not.toContain('<a');
      expect(result).not.toContain('data-href');
      expect(result).not.toContain('mailto:');
    });

    it('renders file: and vscode: links as plain text', () => {
      const file = sanitizeMarkdownHtml('<p><a href="file:///tmp/notes.md">notes</a></p>');
      expect(file).toContain('notes');
      expect(file).not.toContain('<a');
      expect(file).not.toContain('file://');

      const command = sanitizeMarkdownHtml('<p><a href="vscode://file/tmp/x.ts">open it</a></p>');
      expect(command).toContain('open it');
      expect(command).not.toContain('<a');
      expect(command).not.toContain('vscode://');
    });

    it('keeps an https: link clickable through data-href', () => {
      const result = sanitizeMarkdownHtml('<p><a href="https://codeberg.org/forgejo">forgejo</a></p>');
      expect(result).toContain('href="javascript:void(0)"');
      expect(result).toContain('data-href="https://codeberg.org/forgejo"');
      expect(result).toContain('>forgejo</a>');
    });

    it('keeps a relative link resolved against the base URL clickable', () => {
      const result = sanitizeMarkdownHtml('<a href="/user/repo/issues/1">issue</a>', BASE_URL);
      expect(result).toContain('data-href="https://forgejo.example.com/user/repo/issues/1"');
      expect(result).toContain('>issue</a>');
    });

    it('unwraps an https link that only wraps an image', () => {
      const result = sanitizeMarkdownHtml(
        '<a href="https://codeberg.org/x"><img src="https://codeberg.org/i.png"></a>',
      );
      expect(result).not.toContain('<a');
      expect(result).toContain('<img');
    });
  });

  describe('legitimate content regression', () => {
    it('keeps safe links via data-href and resolves relative URLs', () => {
      const result = sanitizeMarkdownHtml('<a href="issues/1">issue</a>', BASE_URL);
      expect(result).toContain('href="javascript:void(0)"');
      expect(result).toContain('data-href="https://forgejo.example.com/user/repo/issues/1"');
      expect(result).toContain('>issue</a>');
    });

    it('keeps fragment links untouched', () => {
      const result = sanitizeMarkdownHtml('<a href="#section">jump</a>');
      expect(result).toContain('href="#section"');
    });

    it('keeps images and resolves relative sources', () => {
      const result = sanitizeMarkdownHtml('<p><img src="attachments/pic.png" alt="pic"></p>', BASE_URL);
      expect(result).toContain('src="https://forgejo.example.com/user/repo/attachments/pic.png"');
      expect(result).toContain('alt="pic"');
    });

    it('empties data:image/svg image sources', () => {
      const result = sanitizeMarkdownHtml('<img src="data:image/svg+xml,<svg onload=alert(1)>" alt="x">');
      expect(result).toContain('src=""');
      expect(result).not.toContain('onload');
    });

    it('keeps tables intact', () => {
      const html = '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>';
      expect(sanitizeMarkdownHtml(html)).toBe(html);
    });

    it('keeps task list items while removing checkbox inputs', () => {
      const result = sanitizeMarkdownHtml(
        '<ul><li class="task-list-item"><input type="checkbox" disabled>done item</li></ul>',
      );
      expect(result).toContain('<li class="task-list-item">');
      expect(result).toContain('done item');
      expect(result).not.toContain('<input');
    });

    it('keeps code blocks with language classes intact', () => {
      const html = '<pre><code class="language-ts">const x = 1;</code></pre>';
      expect(sanitizeMarkdownHtml(html)).toBe(html);
    });
  });
});
