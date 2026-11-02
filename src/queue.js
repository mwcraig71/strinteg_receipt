'use strict';
/* Background reader: every new receipt is queued and read automatically, a couple at a time. State lives in Postgres, so a restart picks up where it left off. */
const config = require('./config');
const db = require('./db');
const storage = require('./storage');
const image = require('./image');
const reader = require('./reader');
const lists = require('./lists');

let running = 0; let timer = null;

async function claim() {
  return db.one(`UPDATE receipts SET status='reading', attempts=attempts+1, updated_at=now()
    WHERE id = (SELECT id FROM receipts WHERE status='queued' AND (retry_at IS NULL OR retry_at <= now())
                ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING *`);
}

async function processOne(rec) {
  const file = await storage.get(rec.file_key);
  const careful = rec.read_mode === 'careful';
  let out;
  if (rec.mime.startsWith('text/')) {
    out = await reader.read({ rec, emailText: file.toString('utf8'), careful });
  } else {
    const prep = await image.prepare(file, rec.edits);
    const { plan, images } = await image.buildImages(prep);
    out = await reader.read({ rec, images, plan, careful });
  }
  const result = lists.normalize(out.raw);
  await db.q(`UPDATE receipts SET status='read', read_error=NULL, result=$2, receipt_date=$3, total=$4, vendor=$5, model=$6, tokens=$7,
      cost_usd=cost_usd+$8, read_mode='standard', retry_at=NULL, updated_at=now() WHERE id=$1`,
  [rec.id, JSON.stringify(result), result.date || null, result.total, result.vendor, out.model, JSON.stringify(out.usage), Number(out.cost.toFixed(4))]);
}

function friendly(e) {
  const s = e?.status;
  if (s === 401 || s === 403) return 'The server\'s Claude API key was rejected. Tell the administrator.';
  if (s === 429 || s === 529 || s === 503) return 'Claude was busy. It will try again shortly.';
  if (s === 400 && /image/i.test(e.message || '')) return 'Claude couldn\'t accept this image. Crop it or re-scan it, then read again.';
  if (/pdftoppm|Input buffer|unsupported image/i.test(e?.message || '')) return 'This file couldn\'t be opened as an image. Re-scan it as PDF or JPEG.';
  return 'The read failed. Click Read again.';
}

async function tick() {
  while (running < config.readConcurrency) {
    let rec;
    try { rec = await claim(); } catch (e) { console.error('queue claim', e.message); return; }
    if (!rec) return;
    running++;
    processOne(rec).catch(async (e) => {
      console.error('read failed', rec.id, e.status || '', e.message);
      const transient = [429, 500, 502, 503, 529].includes(e?.status) && rec.attempts < 4;
      await db.q(`UPDATE receipts SET status=$2, read_error=$3, retry_at=$4, updated_at=now() WHERE id=$1`,
        [rec.id, transient ? 'queued' : (rec.result ? 'read' : 'error'), friendly(e), transient ? new Date(Date.now() + 30000 * rec.attempts) : null]);
    }).finally(() => { running--; setImmediate(tick); });
  }
}

async function start() {
  await db.q(`UPDATE receipts SET status='queued' WHERE status='reading'`); // interrupted by a restart
  timer = setInterval(() => tick().catch(() => {}), 2000);
  tick();
}
const kick = () => setImmediate(() => tick().catch(() => {}));

module.exports = { start, kick, processOne };
