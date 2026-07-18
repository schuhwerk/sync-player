import { test, expect, describe } from 'bun:test';
import { waveformBars, WF_GAMMA, WF_BAR_GAP } from '../src/waveform-math.js';

describe('waveformBars', () => {
  test('empty / zero-dimension inputs yield no bars', () => {
    expect(waveformBars([], 100, 40)).toEqual([]);
    expect(waveformBars([1, 1], 0, 40)).toEqual([]);
    expect(waveformBars([1, 1], 100, 0)).toEqual([]);
  });

  test('skips zero and negative peaks', () => {
    expect(waveformBars([0, -1, 0], 90, 40)).toEqual([]);
  });

  test('loudest bar reaches full half-height (mid-1), curve applied', () => {
    const h = 40, mid = h / 2;
    const bars = waveformBars([1], 10, h);
    expect(bars).toHaveLength(1);
    // scale=1, peak=1 → a = 1^gamma * (mid-1) = mid-1
    expect(bars[0].h).toBeCloseTo((mid - 1) * 2, 10);
    expect(bars[0].y).toBeCloseTo(1, 10); // mid - (mid-1)
  });

  test('normalizes to the loudest peak', () => {
    const h = 40, mid = h / 2;
    const bars = waveformBars([0.5, 1], 20, h); // max=1 → scale=1
    // first bar: a = 0.5^gamma * (mid-1)
    const a0 = Math.pow(0.5, WF_GAMMA) * (mid - 1);
    expect(bars[0].h).toBeCloseTo(a0 * 2, 10);
  });

  test('bar x positions and width follow the box geometry', () => {
    const bars = waveformBars([1, 1], 100, 40);
    expect(bars[0].x).toBe(0);
    expect(bars[1].x).toBe(50);
    expect(bars[0].w).toBeCloseTo(Math.max(1, 100 / 2 - WF_BAR_GAP), 10);
  });

  test('bars are centred (y + h/2 === mid)', () => {
    const h = 40;
    for (const b of waveformBars([0.3, 0.7, 1], 60, h)) {
      expect(b.y + b.h / 2).toBeCloseTo(h / 2, 10);
    }
  });
});
