/**
 * The inline style of one label chip.
 *
 * The value is server-provided and lands in an inline style, so only a plain
 * 6-digit hex color is accepted; anything else renders the label unstyled.
 * The text color follows the sRGB relative luminance of that color, so the
 * same label picks the same text color on every screen that renders it
 * (detail views, issue and pull request forms).
 */
export function labelStyle(color?: string): string {
  if (!color) {
    return '';
  }
  const hex = color.replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return '';
  }
  return `background-color: #${hex}; color: ${isLightColor(hex) ? '#000' : '#fff'};`;
}

function isLightColor(hex: string): boolean {
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;
  const luminance = 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
  return luminance > 0.5;
}

function channelLuminance(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}
