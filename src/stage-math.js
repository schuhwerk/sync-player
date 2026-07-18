// ## js-stage-math — pure spatial-mix geometry (no DOM, no window): unit-testable
// Extracted from stage.js so the falloff/placement/fingerprint logic can run
// under `bun test` without booting the app. Side effects (DOM, localStorage,
// player) stay in stage.js.

export const STAGE_CIRCLE_R = 0.18;                 // default placement radius (square-normalized)
// Audibility radius = 1.5 × placement radius. Anchors the falloff so:
//   d = 0   (on the track)         → v = 1
//   d = a   (default listener pos) → v = cos(π/3) = 0.5
//   d = 1.5a                       → v = 0  (mute boundary)
export const STAGE_AUDIBLE_R = STAGE_CIRCLE_R * 1.5;

export const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

// Radii are part of the fingerprint so tuning them invalidates saved positions —
// otherwise old defaults stick around against new audibility rings.
export const stageFingerprint = files =>
    `r${STAGE_CIRCLE_R}-${STAGE_AUDIBLE_R}|`
    + files.map(f => `${f.name}::${f.lm || ''}`).join('|');

export function stageDefaults(files) {
    const tracks = {};
    const n = files.length;
    for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI / n);
        tracks[files[i].name] = {
            x: 0.5 + STAGE_CIRCLE_R * Math.cos(a),
            y: 0.5 + STAGE_CIRCLE_R * Math.sin(a),
        };
    }
    return { listener: { x: 0.5, y: 0.5 }, tracks, fingerprint: stageFingerprint(files) };
}

// Pure cos falloff from v=1 at the track to v=0 at the audibility ring.
export function stageTrackVolume(trackPos, listener) {
    const d = Math.hypot(trackPos.x - listener.x, trackPos.y - listener.y);
    if (d >= STAGE_AUDIBLE_R) return 0;
    return Math.cos(Math.PI / 2 * (d / STAGE_AUDIBLE_R));
}

// Perceptual curve for the on-stage dot fill (volume → visual intensity).
export function stageTrackVisualLevel(v) {
    const gain = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    return gain ** 1.5;
}
