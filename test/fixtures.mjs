// Tiny WAV fixture generator for the browser suite. Writes a temp folder tree
// the LocalAdapter can serve (via SYNCPLAYER_LOCAL_ROOT):
//
//   <root>/Alpha Band/{bass,drums,vox}.wav   ← the playable folder
//   <root>/Alpha Band/cover.png, sheet.pdf   ← attachments (chips + preview)
//   <root>/Beta/one.wav                      ← second folder for the listing
//
// 16-bit PCM mono sine waves — small enough to decode instantly, real enough
// for AudioContext.decodeAudioData.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const RATE = 8000;

export const FIXTURE_DURATION = 2; // seconds; #time shows "0:00 / 0:02"

function wavBytes(freq, seconds = FIXTURE_DURATION) {
    const n = RATE * seconds;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + n * 2, 4);
    buf.write('WAVEfmt ', 8);
    buf.writeUInt32LE(16, 16);          // fmt chunk size
    buf.writeUInt16LE(1, 20);           // PCM
    buf.writeUInt16LE(1, 22);           // mono
    buf.writeUInt32LE(RATE, 24);
    buf.writeUInt32LE(RATE * 2, 28);    // byte rate
    buf.writeUInt16LE(2, 32);           // block align
    buf.writeUInt16LE(16, 34);          // bits/sample
    buf.write('data', 36);
    buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
        buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / RATE) * 12000), 44 + i * 2);
    }
    return buf;
}

// 1×1 red PNG — enough for <img> to decode (naturalWidth > 0).
const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

// Minimal single-page PDF — only needs to be listed as a "pdf" attachment chip.
const PDF_MIN = Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
trailer<</Root 1 0 R/Size 4>>
%%EOF
`);

export async function makeFixtures(root) {
    const alpha = join(root, 'Alpha Band');
    const beta = join(root, 'Beta');
    await mkdir(alpha, { recursive: true });
    await mkdir(beta, { recursive: true });
    await writeFile(join(alpha, 'bass.wav'), wavBytes(110));
    await writeFile(join(alpha, 'drums.wav'), wavBytes(220));
    await writeFile(join(alpha, 'vox.wav'), wavBytes(440));
    await writeFile(join(alpha, 'cover.png'), PNG_1PX);
    await writeFile(join(alpha, 'sheet.pdf'), PDF_MIN);
    await writeFile(join(beta, 'one.wav'), wavBytes(330));
}
