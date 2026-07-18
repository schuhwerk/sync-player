import { test, expect, describe } from 'bun:test';
import {
  STAGE_CIRCLE_R, STAGE_AUDIBLE_R, clamp01, stageFingerprint,
  stageDefaults, stageTrackVolume, stageTrackVisualLevel,
} from '../src/stage-math.js';

describe('clamp01', () => {
  test('clamps below 0 and above 1, passes through in-range', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(0.3)).toBe(0.3);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(1)).toBe(1);
  });
});

describe('stageTrackVolume', () => {
  const C = { x: 0.5, y: 0.5 };
  test('full volume on the track (d=0)', () => {
    expect(stageTrackVolume(C, C)).toBeCloseTo(1, 10);
  });
  test('half volume at the placement radius (documented anchor: cos π/3)', () => {
    // d = STAGE_CIRCLE_R, audible = 1.5×CIRCLE → ratio 2/3 → cos(π/3) = 0.5
    const tp = { x: 0.5 + STAGE_CIRCLE_R, y: 0.5 };
    expect(stageTrackVolume(tp, C)).toBeCloseTo(0.5, 10);
  });
  test('muted at and beyond the audibility ring', () => {
    expect(stageTrackVolume({ x: 0.5 + STAGE_AUDIBLE_R, y: 0.5 }, C)).toBe(0);
    expect(stageTrackVolume({ x: 0.5 + STAGE_AUDIBLE_R + 0.1, y: 0.5 }, C)).toBe(0);
  });
  test('radially symmetric (only distance matters)', () => {
    const a = stageTrackVolume({ x: 0.5 + 0.1, y: 0.5 }, C);
    const b = stageTrackVolume({ x: 0.5, y: 0.5 - 0.1 }, C);
    expect(a).toBeCloseTo(b, 12);
  });
});

describe('stageTrackVisualLevel', () => {
  test('applies gain^1.5 perceptual curve', () => {
    expect(stageTrackVisualLevel(0)).toBe(0);
    expect(stageTrackVisualLevel(1)).toBe(1);
    expect(stageTrackVisualLevel(0.25)).toBeCloseTo(0.125, 10); // 0.25^1.5
  });
  test('clamps out-of-range and treats non-finite as 0', () => {
    expect(stageTrackVisualLevel(2)).toBe(1);
    expect(stageTrackVisualLevel(-1)).toBe(0);
    expect(stageTrackVisualLevel(NaN)).toBe(0);
    expect(stageTrackVisualLevel(undefined)).toBe(0);
  });
});

describe('stageFingerprint', () => {
  const files = [{ name: 'a.wav', lm: '111' }, { name: 'b.wav', lm: '222' }];
  test('is deterministic and encodes radii + names + lm', () => {
    const fp = stageFingerprint(files);
    expect(fp).toBe(stageFingerprint(files));
    expect(fp).toContain(`r${STAGE_CIRCLE_R}-${STAGE_AUDIBLE_R}`);
    expect(fp).toContain('a.wav::111');
    expect(fp).toContain('b.wav::222');
  });
  test('changes when a file name or lm changes', () => {
    expect(stageFingerprint(files)).not.toBe(
      stageFingerprint([{ name: 'a.wav', lm: '111' }, { name: 'b.wav', lm: '999' }]));
  });
  test('tolerates missing lm', () => {
    expect(stageFingerprint([{ name: 'x.wav' }])).toContain('x.wav::');
  });
});

describe('stageDefaults', () => {
  const files = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  test('listener at centre and fingerprint matches', () => {
    const d = stageDefaults(files);
    expect(d.listener).toEqual({ x: 0.5, y: 0.5 });
    expect(d.fingerprint).toBe(stageFingerprint(files));
  });
  test('places every track on the circle of radius STAGE_CIRCLE_R around centre', () => {
    const d = stageDefaults(files);
    for (const name of ['a', 'b', 'c']) {
      const p = d.tracks[name];
      const r = Math.hypot(p.x - 0.5, p.y - 0.5);
      expect(r).toBeCloseTo(STAGE_CIRCLE_R, 10);
    }
  });
  test('first track starts at the top (angle -π/2)', () => {
    const d = stageDefaults(files);
    expect(d.tracks.a.x).toBeCloseTo(0.5, 10);
    expect(d.tracks.a.y).toBeCloseTo(0.5 - STAGE_CIRCLE_R, 10);
  });
});
