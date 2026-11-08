/**
 * The ground shown behind a drawing with no paper: a check of little squares,
 * combed like marbled paper.
 *
 * A marbler draws a rake of nails through the floating colour once one way and
 * once across, and the check here is put through the same two passes. Each nail
 * drags what it passes along the stroke by an amount that falls off with
 * distance from it — alpha * lambda / (d + lambda), the usual model of a tine
 * through a viscous bath — and neighbouring nails run in opposite directions,
 * which is what folds the squares into chevrons rather than just shearing them.
 *
 * Every displacement runs along its own stroke and depends only on the distance
 * across it, so each pass is undone exactly by subtracting it again. The tile
 * is drawn by running both passes backwards from every output pixel to the
 * check it came from, and everything is periodic in the tile so it repeats
 * without a seam.
 */

/** Displayed size of one tile, in CSS pixels. */
export const MARBLE_TILE = 240;

const SCALE = 2; // drawn at twice the size, for sharp edges on a Retina screen
const N = MARBLE_TILE * SCALE;
const SQUARE = 6 * SCALE; // the little squares
const PITCH = 60 * SCALE; // distance between nails; the tile holds a whole number of pairs
const ALPHA = 45 * SCALE; // how far a nail drags what it touches: well past a square, so they feather
const LAMBDA = 10 * SCALE; // how sharply that falls off

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** Drag along a stroke at `across` from the first nail, summed over nearby nails. */
function drag(across: number, phase: number): number {
  let sum = 0;
  const base = Math.floor((across - phase) / PITCH);
  for (let k = base - 8; k <= base + 9; k++) {
    const d = Math.abs(across - phase - k * PITCH);
    // Alternate nails pull opposite ways.
    sum += (k & 1 ? -1 : 1) * (ALPHA * LAMBDA) / (d + LAMBDA);
  }
  return sum;
}

function sample(x: number, y: number): number {
  // Undo the second pass (nails moving across, displacing x by distance in y),
  // then the first (nails moving down, displacing y by distance in x).
  const x1 = x - drag(y, PITCH / 2);
  const y0 = y - drag(x1, 0);
  const cx = Math.floor(mod(x1, N) / SQUARE);
  const cy = Math.floor(mod(y0, N) / SQUARE);
  return (cx + cy) & 1;
}

let cached: string | null = null;

/** The tile as a data URL, drawn once. Null where there is no canvas. */
export function marbleTile(): string | null {
  if (cached) return cached;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = N;
  canvas.height = N;
  const g = canvas.getContext('2d');
  if (!g) return null;
  const img = g.createImageData(N, N);
  const light = [246, 246, 244];
  const dark = [214, 214, 210];
  // Four samples a pixel, so the combed edges come out smooth.
  const offs = [0.25, 0.75];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let t = 0;
      for (const oy of offs) for (const ox of offs) t += sample(x + ox, y + oy);
      t /= 4;
      const i = (y * N + x) * 4;
      for (let c = 0; c < 3; c++) img.data[i + c] = Math.round(light[c] + (dark[c] - light[c]) * t);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  cached = canvas.toDataURL('image/png');
  return cached;
}
