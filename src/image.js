'use strict';
const sharp = require('sharp');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const MP = 1.15e6;          // Claude scales any image above ~1.15 megapixels down to that size
const MAX_STRIPS = 7;
const MAX_SIDE = 4200;

function run(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { maxBuffer: 64 << 20 }, (e, so, se) => (e ? reject(new Error(se || e.message)) : resolve(so))));
}

/** Split a PDF into page images (PNG buffers) at a resolution good for small receipt print. */
async function rasterizePdf(buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-'));
  try {
    const src = path.join(dir, 'in.pdf');
    await fs.writeFile(src, buffer);
    await run('pdftoppm', ['-r', '220', '-png', src, path.join(dir, 'p')]);
    const files = (await fs.readdir(dir)).filter((f) => f.startsWith('p') && f.endsWith('.png')).sort((a, b) => parseInt(a.slice(2)) - parseInt(b.slice(2)));
    const out = [];
    for (const f of files) out.push(await normalizeImage(await fs.readFile(path.join(dir, f))));
    return out;
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

/** Upright (EXIF), flattened on white, capped in size, stored as PNG. */
async function normalizeImage(buffer) {
  return sharp(buffer, { failOn: 'none' }).rotate().flatten({ background: '#ffffff' })
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 8 }).toBuffer();
}

/** iPhone HEIC photos: sharp's bundled libvips can't decode HEVC, so use heif-convert (libheif) when installed. */
async function heicToPng(buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heic-'));
  try {
    const src = path.join(dir, 'in.heic'); const dst = path.join(dir, 'out.jpg');
    await fs.writeFile(src, buffer);
    await run('heif-convert', ['-q', '95', src, dst]);
    return normalizeImage(await fs.readFile(dst));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

/** Stack page images vertically into one (multi-page hotel folio). */
async function stack(buffers) {
  const metas = await Promise.all(buffers.map((b) => sharp(b).metadata()));
  const W = Math.max(...metas.map((m) => m.width));
  const parts = await Promise.all(buffers.map((b) => sharp(b).resize({ width: W }).png().toBuffer({ resolveWithObject: true })));
  let H = 0; const comp = parts.map((p) => { const c = { input: p.data, top: H, left: 0 }; H += p.info.height; return c; });
  const out = await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } }).composite(comp).png().toBuffer();
  return normalizeImage(out);
}

/** Apply the user's edits plus clean-up. Returns a PNG buffer and its size. */
async function prepare(buffer, edits = {}) {
  let img = sharp(buffer).rotate(((Number(edits.rot) || 0) % 360 + 360) % 360, { background: '#ffffff' });
  let { data, info } = await img.png().toBuffer({ resolveWithObject: true });
  if (edits.crop && edits.crop.w > 0.02 && edits.crop.h > 0.02) {
    const c = edits.crop;
    const left = Math.max(0, Math.round(c.x * info.width)); const top = Math.max(0, Math.round(c.y * info.height));
    const width = Math.min(info.width - left, Math.round(c.w * info.width)); const height = Math.min(info.height - top, Math.round(c.h * info.height));
    ({ data, info } = await sharp(data).extract({ left, top, width, height }).png().toBuffer({ resolveWithObject: true }));
  }
  if (edits.trim !== false) {
    try {
      const t = await sharp(data).trim({ threshold: 28 }).png().toBuffer({ resolveWithObject: true });
      if (t.info.width * t.info.height > info.width * info.height * 0.15) {
        const pad = Math.round(Math.min(t.info.width, t.info.height) * 0.015);
        ({ data, info } = await sharp(t.data).extend({ top: pad, bottom: pad, left: pad, right: pad, background: '#ffffff' }).png().toBuffer({ resolveWithObject: true }));
      }
    } catch (e) { /* nothing to trim */ }
  }
  if (edits.enhance !== false) {
    const boost = !!edits.boost;
    const raw = await sharp(data).grayscale().normalise({ lower: boost ? 4 : 1.5, upper: boost ? 78 : 90 }).raw().toBuffer({ resolveWithObject: true });
    const gam = boost ? 1.7 : 1.2; const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) lut[v] = Math.round(255 * Math.pow(v / 255, gam));
    const px = raw.data; for (let i = 0; i < px.length; i++) px[i] = lut[px[i]];
    ({ data, info } = await sharp(px, { raw: raw.info }).png().toBuffer({ resolveWithObject: true }));
  }
  return { data, width: info.width, height: info.height };
}

/** How the prepared image is sent: one image if small, otherwise an overview plus overlapping full-resolution strips. */
function tilePlan(W, H, maxStrips = MAX_STRIPS) {
  const single = { single: true, s: Math.min(1, Math.sqrt(MP / (W * H))), tiles: [[0, H]] };
  if (W * H <= MP * 1.3) return single;
  let s = Math.min(1, 1400 / W); let n = 1; let thSrc = H;
  for (let k = 0; k < 12; k++) {
    const w = W * s; const h = H * s; const th = MP / w; const ov = th * 0.12;
    n = Math.max(1, Math.ceil((h - ov) / (th - ov))); thSrc = Math.min(H, th / s);
    if (n <= maxStrips) break; s *= 0.85;
  }
  if (n <= 1) return single;
  const step = (H - thSrc) / (n - 1); const tiles = [];
  for (let i = 0; i < n; i++) { const y = Math.round(i * step); tiles.push([y, Math.min(H, Math.round(y + thSrc))]); }
  return { single: false, s, tiles };
}

async function jpeg(input, width, height) {
  return sharp(input).resize({ width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)), fit: 'fill' }).jpeg({ quality: 90 }).toBuffer();
}

/** Images to send to Claude for a prepared receipt. */
async function buildImages(prep) {
  const plan = tilePlan(prep.width, prep.height);
  const blobs = [];
  if (plan.single) {
    blobs.push(await jpeg(prep.data, prep.width * plan.s, prep.height * plan.s));
  } else {
    const so = Math.sqrt(MP / (prep.width * prep.height));
    blobs.push(await jpeg(prep.data, prep.width * so, prep.height * so));
    for (const [y0, y1] of plan.tiles) {
      const strip = await sharp(prep.data).extract({ left: 0, top: y0, width: prep.width, height: y1 - y0 }).toBuffer();
      blobs.push(await jpeg(strip, prep.width * plan.s, (y1 - y0) * plan.s));
    }
  }
  return { plan, images: blobs.map((b) => b.toString('base64')) };
}

/** Preview for the web page: prepared image (or raw rotated image for cropping), max 1600 px wide. */
async function preview(buffer, edits, raw) {
  if (raw) {
    const r = await sharp(buffer).rotate(((Number(edits.rot) || 0) % 360 + 360) % 360, { background: '#ffffff' })
      .resize({ width: 1600, height: 4000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
    return { data: r.data, plan: null };
  }
  const prep = await prepare(buffer, edits);
  const plan = tilePlan(prep.width, prep.height);
  const data = await sharp(prep.data).resize({ width: 1600, height: 6000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  return { data, plan: { ...plan, width: prep.width, height: prep.height } };
}

async function thumbnail(buffer) {
  return sharp(buffer).resize({ width: 120, height: 150, fit: 'cover', position: 'top' }).jpeg({ quality: 70 }).toBuffer();
}

module.exports = { rasterizePdf, normalizeImage, heicToPng, stack, prepare, tilePlan, buildImages, preview, thumbnail, MP };
