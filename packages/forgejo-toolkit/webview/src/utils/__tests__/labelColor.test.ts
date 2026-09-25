import { describe, expect, it } from 'vitest';
import { labelStyle } from '../labelColor';

/**
 * `label.color` is server-provided and lands in an inline style, so a
 * malicious or non-standard server could inject arbitrary CSS through it.
 * Only a plain 6-digit hex color is applied; anything else renders the label
 * unstyled. The text color follows the sRGB relative luminance, the one
 * formula every label view shares (the pull request detail view used to use
 * a naive brightness formula, which flipped the text color of some labels
 * between the issue and pull request pages).
 */
describe('labelStyle', () => {
  it('applies a valid 6-digit hex color, with or without a leading #', () => {
    expect(labelStyle('ff0000')).toContain('background-color: #ff0000');
    expect(labelStyle('#00FF00')).toContain('background-color: #00FF00');
  });

  it.each(['red', 'fff', 'ff0000; position: fixed', 'url(javascript:1)', '', undefined])(
    'renders the label unstyled for a non-hex color (%s)',
    (color) => {
      expect(labelStyle(color)).toBe('');
    },
  );

  it('picks dark text on a light color and light text on a dark color', () => {
    expect(labelStyle('ffffff')).toContain('color: #000');
    expect(labelStyle('000000')).toContain('color: #fff');
  });

  it('uses the sRGB relative luminance, not the naive brightness formula', () => {
    // Naive brightness: 173 > 128 would read this gray as light and pick dark
    // text; the sRGB relative luminance (~0.42) is below the 0.5 threshold.
    expect(labelStyle('adadad')).toContain('color: #fff');
  });
});
