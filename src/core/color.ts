import type { RGB } from './types';

/**
 * Colour helpers.
 *
 * Two colour spaces earn their place here. sRGB is what files and pickers speak.
 * CIE Lab is what "these two colours are similar" has to be measured in — an
 * RGB-distance quantiser puts its cluster boundaries in visibly wrong places,
 * splitting a smooth skin tone in two while merging a shadow with a mid-green.
 */

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n) || full.length !== 6) return [0, 0, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(rgb: RGB): string {
  const c = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

export function cssRgb(rgb: RGB, alpha = 1): string {
  const c = (v: number) => Math.round(clamp01(v) * 255);
  return alpha >= 1
    ? `rgb(${c(rgb[0])},${c(rgb[1])},${c(rgb[2])})`
    : `rgba(${c(rgb[0])},${c(rgb[1])},${c(rgb[2])},${Math.round(alpha * 1000) / 1000})`;
}

/**
 * Rec. 709 luminance, on non-linear sRGB values.
 *
 * Deliberately not the linear-light version. Posterisation bands are chosen to
 * look evenly spaced, and perceived lightness tracks the encoded value far more
 * closely than it tracks linear intensity — banding on linear luminance crowds
 * every threshold into the shadows.
 */
export const luma = (r: number, g: number, b: number): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

export const lumaOf = (rgb: RGB): number => luma(rgb[0], rgb[1], rgb[2]);

// -- CIE Lab -----------------------------------------------------------------

const srgbToLinear = (v: number): number =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;

const labF = (t: number): number =>
  t > 216 / 24389 ? Math.cbrt(t) : (t * 24389 / 27 + 16) / 116;

/** sRGB (0..1) to CIE Lab, D65. L is 0..100, a and b roughly -128..128. */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  // D65 white point, normalised so pure white lands exactly on L=100.
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const linearToSrgb = (v: number): number =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;

export function labToRgb(L: number, a: number, bb: number): RGB {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - bb / 200;
  const inv = (f: number) => (f ** 3 > 216 / 24389 ? f ** 3 : (116 * f - 16) * 27 / 24389);
  const x = inv(fx) * 0.95047;
  const y = L > 8 ? fy ** 3 : L * 27 / 24389;
  const z = inv(fz) * 1.08883;
  const R = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const G = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const B = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return [clamp01(linearToSrgb(R)), clamp01(linearToSrgb(G)), clamp01(linearToSrgb(B))];
}

// -- palettes ----------------------------------------------------------------

/** Mix two colours in Lab, so a midpoint between them is the one the eye expects. */
export function mixLab(a: RGB, b: RGB, t: number): RGB {
  const la = rgbToLab(a[0], a[1], a[2]);
  const lb = rgbToLab(b[0], b[1], b[2]);
  return labToRgb(
    la[0] + (lb[0] - la[0]) * t,
    la[1] + (lb[1] - la[1]) * t,
    la[2] + (lb[2] - la[2]) * t,
  );
}

/**
 * An N-step ramp between two colours, darkest first.
 *
 * This is what a tone-banded document gets as its default palette: the band
 * colours are not the average tone of each band but an even perceptual ramp, so
 * a four-level and a nine-level posterisation of the same photograph read as the
 * same drawing at different resolutions.
 */
export function ramp(dark: RGB, light: RGB, n: number): RGB[] {
  if (n <= 1) return [dark];
  return Array.from({ length: n }, (_, i) => mixLab(dark, light, i / (n - 1)));
}

/**
 * Lighten (positive) or darken (negative) by a share of the Lab lightness range.
 *
 * In Lab rather than by scaling RGB, because scaling a saturated ochre towards
 * white desaturates it into cream and the whole point of a shading ramp is that
 * it stays the same colour throughout.
 */
export function shade(rgb: RGB, amount: number): RGB {
  const [L, a, b] = rgbToLab(rgb[0], rgb[1], rgb[2]);
  return labToRgb(Math.min(100, Math.max(0, L + amount * 100)), a, b);
}

/** Sort a palette dark to light, carrying a parallel array along with it. */
export function sortByLuma<T>(colours: RGB[], along: T[]): { colours: RGB[]; along: T[] } {
  const order = colours.map((_, i) => i).sort((a, b) => lumaOf(colours[a]) - lumaOf(colours[b]));
  return { colours: order.map((i) => colours[i]), along: order.map((i) => along[i]) };
}

/**
 * A readable ink for text or an outline drawn on top of `bg`.
 *
 * Used by the band list so a swatch's label stays legible whatever colour the
 * user picks.
 */
export const contrastInk = (bg: RGB): RGB => (lumaOf(bg) > 0.55 ? [0, 0, 0] : [1, 1, 1]);
