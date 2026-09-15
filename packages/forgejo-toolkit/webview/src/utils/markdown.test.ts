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
    it('neutralizes javascript: hrefs instead of keeping them', () => {
      const result = sanitizeMarkdownHtml('<a href="javascript:alert(1)">click</a>');
      expect(result).toContain('href="javascript:void(0)"');
      expect(result).not.toContain('alert');
      expect(result).not.toContain('data-href');
    });

    it('neutralizes data:text/html hrefs', () => {
      const result = sanitizeMarkdownHtml('<a href="data:text/html,<script>alert(1)</script>">click</a>');
      expect(result).toContain('href="javascript:void(0)"');
      expect(result).not.toContain('data:text/html');
    });
  });

  describe('SVG xlink:href', () => {
    it('neutralizes javascript: xlink:href on SVG anchors', () => {
      const result = sanitizeMarkdownHtml('<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>');
      expect(result).toContain('xlink:href="javascript:void(0)"');
      expect(result).not.toContain('alert');
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
