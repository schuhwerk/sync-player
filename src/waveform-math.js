// ## js-waveform-math — pure peaks → bar rectangles (no canvas, no DOM)
// Extracted from waveform.js so the normalization + perceptual curve are
// unit-testable. The caller turns these rects into fillRect calls.

export const WF_GAMMA = 0.7;   // perceptual curve flattening quiet/loud spread
export const WF_BAR_GAP = 0.5; // px shaved off each bar so neighbours don't touch

// Map a precomputed peaks array to centred bar rectangles for a w×h box.
// Peaks are normalized to the loudest bar, gamma-curved, and mirrored about the
// vertical midline. Zero/negative peaks are skipped (no rect emitted).
export function waveformBars(peaks, w, h) {
    const n = peaks.length;
    if (!n || !w || !h) return [];
    const mid = h / 2;
    let max = 0;
    for (let i = 0; i < n; i++) if (peaks[i] > max) max = peaks[i];
    const scale = max > 0 ? 1 / max : 1;
    const barW = Math.max(1, w / n - WF_BAR_GAP);
    const bars = [];
    for (let i = 0; i < n; i++) {
        if (peaks[i] <= 0) continue;
        const a = Math.pow(peaks[i] * scale, WF_GAMMA) * (mid - 1);
        bars.push({ x: (i / n) * w, y: mid - a, w: barW, h: a * 2 });
    }
    return bars;
}
