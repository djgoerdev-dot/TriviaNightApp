import type { StrokeInk } from '@trivia/shared';

export const VBW = 1000;
export const VBH = 360;
export const BASELINE_Y = 250;

/**
 * Ramer–Douglas–Peucker polyline simplification on flat [x0, y0, x1, y1, ...] array.
 * Drops 60–70% of redundant points with zero perceptible visual distortion.
 */
export function simplifyPoints(p: number[], eps: number = 1.8): number[] {
  const n = p.length / 2;
  if (n < 3) return p.slice();

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack: [number, number][] = [[0, n - 1]];

  while (stack.length) {
    const seg = stack.pop()!;
    const a = seg[0];
    const b = seg[1];
    const ax = p[2 * a], ay = p[2 * a + 1];
    const bx = p[2 * b], by = p[2 * b + 1];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;

    let best = -1;
    let bi = -1;

    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * p[2 * i] - dx * p[2 * i + 1] + bx * ay - by * ax) / len;
      if (d > best) {
        best = d;
        bi = i;
      }
    }

    if (best > eps && bi > 0) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }

  const out: number[] = [];
  for (let j = 0; j < n; j++) {
    if (keep[j]) {
      out.push(p[2 * j], p[2 * j + 1]);
    }
  }
  return out;
}

/**
 * Converts flat point coordinates into a smooth SVG path definition
 * using quadratic Bezier curves through midpoints.
 */
export function pathD(p: number[]): string {
  const n = p.length / 2;
  if (n === 0) return '';
  if (n === 1) return `M ${p[0]} ${p[1]} l 0.01 0`;

  let d = `M ${p[0]} ${p[1]}`;
  for (let i = 1; i < n - 1; i++) {
    const x = p[2 * i];
    const y = p[2 * i + 1];
    const nextX = p[2 * i + 2];
    const nextY = p[2 * i + 3];
    const midX = Math.round(((x + nextX) / 2) * 10) / 10;
    const midY = Math.round(((y + nextY) / 2) * 10) / 10;
    d += ` Q ${x} ${y} ${midX} ${midY}`;
  }
  d += ` L ${p[2 * n - 2]} ${p[2 * n - 1]}`;
  return d;
}

/**
 * Calculates dynamic vector stroke width (in viewBox units) based on real card pixel width.
 * This guarantees lines thicken as cards get smaller, keeping 24-team boards crisp.
 */
export function calculateStrokeUnits(targetPixelWeight: number, containerPixelWidth: number): number {
  if (!containerPixelWidth || containerPixelWidth <= 0) return 18;
  const units = (targetPixelWeight * VBW) / containerPixelWidth;
  return Math.round(units * 10) / 10;
}
