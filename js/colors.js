// Accent color math: WCAG contrast, and readable variants of a chosen color. Pure functions, no DOM.

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

const channel = (v) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, '0');
export const toHex = ([r, g, b]) => `#${channel(r)}${channel(g)}${channel(b)}`;

// `t` of the way from color a to color b.
export function mix(a, b, t) {
  const A = parseHex(a);
  const B = parseHex(b);
  return toHex(A.map((v, i) => v + (B[i] - v) * t));
}

// WCAG relative luminance and contrast ratio (1 to 21).
export function luminance(hex) {
  const [r, g, b] = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Darken (toward black) or lighten (toward white) `hex` just enough to reach `min` contrast with `bg`.
export function ensureContrast(hex, bg, min, toward) {
  for (let step = 0; step <= 50; step++) {
    const c = step ? mix(hex, toward, step / 50) : hex;
    if (contrast(c, bg) >= min) return c;
  }
  return toward;
}

// The page colors the accent has to work on (keep in sync with style.css).
const LIGHT_BG = '#f6f7f5';
const LIGHT_CARD = '#ffffff';
const DARK_CARD = '#1a201c';

// Presets: the light-mode fill, a dark-mode fill, and (for green) the dark chart line tuned for charts.
export const ACCENTS = [
  { key: 'green', label: 'Green', light: '#16a34a', dark: '#22c55e', chartDark: '#1eaf52' },
  { key: 'teal', label: 'Teal', light: '#0d9488', dark: '#2dd4bf' },
  { key: 'blue', label: 'Blue', light: '#2563eb', dark: '#60a5fa' },
  { key: 'indigo', label: 'Indigo', light: '#4f46e5', dark: '#818cf8' },
  { key: 'pink', label: 'Pink', light: '#db2777', dark: '#f472b6' },
  { key: 'graphite', label: 'Graphite', light: '#475569', dark: '#94a3b8' },
];

export const ACCENT_VARS = ['accent-l', 'accent-ink-l', 'accent-fg-l', 'chart-line-l', 'accent-d', 'accent-ink-d', 'accent-fg-d', 'chart-line-d'];

// Everything the stylesheet needs for one accent color, for light (-l) and dark (-d) mode:
//   accent      fills: buttons, the + button, meters
//   accent-ink  text on those fills (white, or a very dark shade of the color when white doesn't read)
//   accent-fg   the accent as text or icons on the page (at least 4.5:1)
//   chart-line  the accent as a chart line (at least 3:1 on cards)
export function accentVars(lightFill, darkFill = null, chartDark = null) {
  const dark = darkFill || ensureContrast(lightFill, DARK_CARD, 3, '#ffffff');
  const ink = (fill) => (contrast(fill, '#ffffff') >= 3 ? '#ffffff' : mix(fill, '#000000', 0.8));
  return {
    'accent-l': lightFill,
    'accent-ink-l': ink(lightFill),
    'accent-fg-l': ensureContrast(lightFill, LIGHT_BG, 4.5, '#000000'),
    'chart-line-l': ensureContrast(lightFill, LIGHT_CARD, 3, '#000000'),
    'accent-d': dark,
    'accent-ink-d': ink(dark),
    'accent-fg-d': ensureContrast(dark, DARK_CARD, 4.5, '#ffffff'),
    'chart-line-d': chartDark || ensureContrast(dark, DARK_CARD, 3, '#ffffff'),
  };
}
