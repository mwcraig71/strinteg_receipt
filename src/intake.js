'use strict';
/* Turns uploaded or emailed files into queued receipts. */
const db = require('./db');
const storage = require('./storage');
const image = require('./image');
const queue = require('./queue');

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|tiff?|bmp|heic|heif|avif)$/i;
const isPdf = (f) => /pdf/i.test(f.mime) || /\.pdf$/i.test(f.name);
const isImage = (f) => /^image\//i.test(f.mime) || IMAGE_EXT.test(f.name);

async function insert(user, { key, mime, name, source, subject }) {
  const s = user.settings || {};
  return db.one(`INSERT INTO receipts (user_id, source, original_name, file_key, mime, email_subject, purpose, project)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
  [user.id, source, name, key, mime, subject || null, s.purpose || 'project', s.project || '']);
}

/** files: [{buffer, name, mime}] → { ids, skipped:[{name, reason}] } */
async function addFiles(user, files, { source = 'upload', subject = null, splitPages } = {}) {
  const split = splitPages ?? (user.settings?.splitPages !== false);
  const ids = []; const skipped = [];
  for (const f of files) {
    try {
      if (isPdf(f)) {
        const pages = await image.rasterizePdf(f.buffer);
        if (!pages.length) throw new Error('empty PDF');
        const groups = split ? pages.map((p) => [p]) : [pages];
        for (let i = 0; i < groups.length; i++) {
          const buf = groups[i].length > 1 ? await image.stack(groups[i]) : groups[i][0];
          const key = await storage.put(user.id, buf, 'png');
          const name = split && pages.length > 1 ? `${f.name} · p${i + 1}` : f.name;
          ids.push((await insert(user, { key, mime: 'image/png', name, source, subject })).id);
        }
      } else if (isImage(f)) {
        let buf;
        try { buf = await image.normalizeImage(f.buffer); } catch (e) {
          if (/\.(heic|heif)$/i.test(f.name) || /hei[cf]/i.test(f.mime)) buf = await image.heicToPng(f.buffer); else throw e;
        }
        const key = await storage.put(user.id, buf, 'png');
        ids.push((await insert(user, { key, mime: 'image/png', name: f.name, source, subject })).id);
      } else {
        skipped.push({ name: f.name, reason: 'Not a PDF or image' });
      }
    } catch (e) {
      const heic = /\.(heic|heif)$/i.test(f.name);
      skipped.push({ name: f.name, reason: heic ? 'This HEIC photo couldn\'t be opened. Export it as JPEG and try again.' : 'Couldn\'t be opened. Re-save it as PDF, JPEG or PNG.' });
    }
  }
  if (ids.length) queue.kick();
  return { ids, skipped };
}

/** A receipt that exists only as email text (e-receipts from airlines, Uber, hotels). */
async function addText(user, text, { name, subject }) {
  const key = await storage.put(user.id, Buffer.from(text, 'utf8'), 'txt');
  const row = await insert(user, { key, mime: 'text/plain', name, source: 'email', subject });
  queue.kick();
  return row.id;
}

module.exports = { addFiles, addText, isPdf, isImage };
