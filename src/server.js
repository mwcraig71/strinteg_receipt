'use strict';
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const storage = require('./storage');
const image = require('./image');
const lists = require('./lists');
const intake = require('./intake');
const inbound = require('./inbound');
const queue = require('./queue');
const reader = require('./reader');
const exporter = require('./exporter');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb << 20, files: 50 } });
const devUser = !config.clerkSecretKey && process.env.NODE_ENV !== 'production' ? (process.env.AUTH_DEV_USER || 'dev_user') : null;

app.get('/healthz', (req, res) => res.send('ok'));

// Email-in webhook (Postmark). Authenticated with its own basic-auth secret, not Clerk.
app.post('/inbound/postmark', express.json({ limit: '40mb' }), inbound.handle);

/* ---------- auth ---------- */
let clerk = null;
if (config.clerkSecretKey) {
  clerk = require('@clerk/express');
  app.use(clerk.clerkMiddleware());
} else if (!devUser) {
  console.error('CLERK_SECRET_KEY is not set. Refusing to start in production without sign-in.');
  process.exit(1);
}

async function ensureUser(req, res, next) {
  try {
    const userId = clerk ? clerk.getAuth(req).userId : devUser;
    if (!userId) return res.status(401).json({ error: 'Sign in to continue.' });
    let user = await db.one('SELECT * FROM users WHERE id=$1', [userId]);
    if (!user || !user.email) {
      let email = devUser ? 'dev@example.com' : null; let name = devUser ? 'Dev User' : null;
      if (clerk) {
        const u = await clerk.clerkClient.users.getUser(userId);
        email = u.primaryEmailAddress?.emailAddress || u.emailAddresses?.[0]?.emailAddress || null;
        name = [u.firstName, u.lastName].filter(Boolean).join(' ') || null;
      }
      user = await db.one(`INSERT INTO users (id, email, name, inbound_token) VALUES ($1,$2,$3,$4)
        ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, name=COALESCE(EXCLUDED.name, users.name) RETURNING *`,
      [userId, email, name, crypto.randomBytes(5).toString('hex')]);
    }
    req.user = user; next();
  } catch (e) { next(e); }
}

/* ---------- page ---------- */
const frontendApi = (() => {
  try { return Buffer.from(config.clerkPublishableKey.split('_')[2] || '', 'base64').toString().replace(/\$$/, ''); } catch (e) { return ''; }
})();
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(indexHtml
    .replace('__CLERK_PK__', config.clerkPublishableKey)
    .replace(/__CLERK_FAPI__/g, frontendApi)
    .replace('__DEV_MODE__', devUser ? 'true' : 'false'));
});
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false, maxAge: '1h' }));

/* ---------- API ---------- */
const api = express.Router();
api.use(express.json({ limit: '2mb' }));
api.use(ensureUser);
const today = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const LOCKED = new Set(['submitted']);

async function own(req, res) {
  const r = await db.one('SELECT * FROM receipts WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]).catch(() => null);
  if (!r) res.status(404).json({ error: 'Receipt not found.' });
  return r;
}
const pub = (r) => ({
  id: r.id, source: r.source, name: r.original_name, mime: r.mime, subject: r.email_subject, status: r.status, error: r.read_error,
  readMode: r.read_mode, result: r.result, purpose: r.purpose, project: r.project, edits: r.edits, date: r.receipt_date, total: r.total,
  vendor: r.vendor, model: r.model, cost: r.cost_usd, submissionId: r.submission_id, createdAt: r.created_at,
});

api.get('/me', async (req, res) => {
  res.json({ user: { email: req.user.email, name: req.user.name }, settings: req.user.settings, inboundAddress: inbound.addressFor(req.user),
    inboundConfigured: !!config.inboundAddress, inboundPlain: config.inboundAddress, reader: config.reader, purposes: lists.PURPOSES, lists: { exp: lists.EXP_TXT, ven: lists.VEN_TXT } });
});
api.patch('/me/settings', async (req, res) => {
  const s = { ...req.user.settings };
  if (typeof req.body.purpose === 'string' && lists.PURPOSES.some((p) => p[0] === req.body.purpose)) s.purpose = req.body.purpose;
  if (typeof req.body.project === 'string') s.project = req.body.project.trim().slice(0, 40);
  if (typeof req.body.splitPages === 'boolean') s.splitPages = req.body.splitPages;
  await db.q('UPDATE users SET settings=$2 WHERE id=$1', [req.user.id, JSON.stringify(s)]);
  res.json({ settings: s });
});
// Connection check: open /api/diag in the browser while signed in.
api.get('/diag', async (req, res) => {
  res.json({ reader: config.reader, apiKeySet: !!config.anthropicApiKey, models: { standard: config.modelStandard, careful: config.modelCareful, quick: config.modelQuick },
    inboundAddressSet: !!config.inboundAddress, claude: await reader.diag() });
});
api.get('/inbound-log', async (req, res) => {
  res.json(await db.q('SELECT sender, subject, outcome, created_at FROM inbound_log WHERE user_id=$1 ORDER BY created_at DESC LIMIT 15', [req.user.id]));
});

api.get('/receipts', async (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : '1900-01-01'; const to = isDate(req.query.to) ? req.query.to : '2999-12-31';
  const rows = await db.q(`SELECT * FROM receipts WHERE user_id=$1 AND ((receipt_date BETWEEN $2 AND $3) OR receipt_date IS NULL
      OR status IN ('queued','reading','read','error'))
    ORDER BY receipt_date DESC NULLS FIRST, created_at DESC`, [req.user.id, from, to]);
  res.json(rows.map(pub));
});
api.post('/receipts', upload.array('files', 50), async (req, res) => {
  const files = (req.files || []).map((f) => ({ buffer: f.buffer, name: f.originalname, mime: f.mimetype }));
  if (!files.length) return res.status(400).json({ error: 'Choose at least one file.' });
  const split = req.body.splitPages === undefined ? undefined : req.body.splitPages === 'true';
  res.json(await intake.addFiles(req.user, files, { source: 'upload', splitPages: split }));
});
api.get('/receipts/:id', async (req, res) => { const r = await own(req, res); if (r) res.json(pub(r)); });
api.patch('/receipts/:id', async (req, res) => {
  const r = await own(req, res); if (!r) return;
  if (LOCKED.has(r.status)) return res.status(409).json({ error: 'This receipt is part of a submission. Withdraw the submission to change it.' });
  const b = req.body; const set = {};
  if (b.result && typeof b.result === 'object') {
    const R = b.result; set.result = JSON.stringify(R);
    set.receipt_date = isDate(R.date) ? R.date : null; set.total = typeof R.total === 'number' ? R.total : null; set.vendor = R.vendor || null;
  }
  if (typeof b.purpose === 'string' && lists.PURPOSES.some((p) => p[0] === b.purpose)) set.purpose = b.purpose;
  if (typeof b.project === 'string') set.project = b.project.trim().slice(0, 40);
  if (b.edits && typeof b.edits === 'object') {
    const e = b.edits; set.edits = JSON.stringify({ rot: ((Number(e.rot) || 0) % 360 + 360) % 360, trim: e.trim !== false, enhance: e.enhance !== false, boost: !!e.boost,
      crop: e.crop && ['x', 'y', 'w', 'h'].every((k) => typeof e.crop[k] === 'number') ? e.crop : null });
  }
  if (b.status === 'checked' || b.status === 'read') {
    if (!r.result && !set.result) return res.status(400).json({ error: 'Read the receipt before marking it checked.' });
    set.status = b.status;
  } else if (set.result && r.status === 'checked') set.status = 'read';
  const keys = Object.keys(set);
  if (keys.length) await db.q(`UPDATE receipts SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`, [r.id, ...keys.map((k) => set[k])]);
  res.json(pub(await db.one('SELECT * FROM receipts WHERE id=$1', [r.id])));
});
api.post('/receipts/:id/read', async (req, res) => {
  const r = await own(req, res); if (!r) return;
  if (LOCKED.has(r.status)) return res.status(409).json({ error: 'This receipt is part of a submission.' });
  if (r.status === 'reading' || r.status === 'queued') return res.json(pub(r));
  await db.q(`UPDATE receipts SET status='queued', read_mode=$2, read_error=NULL, attempts=0, retry_at=NULL, updated_at=now() WHERE id=$1`, [r.id, req.body.careful ? 'careful' : 'standard']);
  queue.kick();
  res.json(pub(await db.one('SELECT * FROM receipts WHERE id=$1', [r.id])));
});
api.post('/receipts/:id/resort', async (req, res) => {
  const r = await own(req, res); if (!r) return;
  if (!r.result || LOCKED.has(r.status)) return res.status(409).json({ error: 'Nothing to re-sort.' });
  try {
    const out = await reader.resort(r); const R = r.result;
    out.cats.forEach((o, i) => { const l = R.lines[i]; const c = lists.matchCategory(o?.category); if (l && c) { l.category = c; l.confidence = Math.max(0, Math.min(1, Number(o.confidence) || 0.5)); l.reason = String(o.reason || ''); } });
    await db.q(`UPDATE receipts SET result=$2, status=CASE WHEN status='checked' THEN 'read' ELSE status END, cost_usd=cost_usd+$3, updated_at=now() WHERE id=$1`, [r.id, JSON.stringify(R), Number(out.cost.toFixed(4))]);
    res.json(pub(await db.one('SELECT * FROM receipts WHERE id=$1', [r.id])));
  } catch (e) { console.error('resort', e.message); res.status(502).json({ error: 'Claude couldn\'t re-sort this receipt right now. Try again in a minute.' }); }
});
api.post('/receipts/:id/join', async (req, res) => {
  const a = await own(req, res); if (!a) return;
  const b = await db.one('SELECT * FROM receipts WHERE id=$1 AND user_id=$2', [req.body.with, req.user.id]).catch(() => null);
  if (!b || a.id === b.id) return res.status(400).json({ error: 'Pick another receipt to join.' });
  if ([a, b].some((r) => LOCKED.has(r.status) || r.mime.startsWith('text/'))) return res.status(409).json({ error: 'Only unsubmitted scanned receipts can be joined.' });
  const pa = await image.prepare(await storage.get(a.file_key), { rot: a.edits.rot, trim: false, enhance: false });
  const pb = await image.prepare(await storage.get(b.file_key), { rot: b.edits.rot, trim: false, enhance: false });
  const key = await storage.put(req.user.id, await image.stack([pa.data, pb.data]), 'png');
  await db.q(`UPDATE receipts SET file_key=$2, original_name=$3, edits='{"rot":0,"crop":null,"trim":true,"enhance":true,"boost":false}', result=NULL, status='queued', read_mode='standard', attempts=0, updated_at=now() WHERE id=$1`,
    [a.id, key, a.original_name.replace(/ · p\d+$/, '') + ' (joined)']);
  await db.q('DELETE FROM receipts WHERE id=$1', [b.id]);
  await storage.remove(a.file_key).catch(() => {}); await storage.remove(b.file_key).catch(() => {});
  queue.kick();
  res.json(pub(await db.one('SELECT * FROM receipts WHERE id=$1', [a.id])));
});
api.delete('/receipts/:id', async (req, res) => {
  const r = await own(req, res); if (!r) return;
  if (LOCKED.has(r.status)) return res.status(409).json({ error: 'This receipt is part of a submission. Withdraw the submission first.' });
  await db.q('DELETE FROM receipts WHERE id=$1', [r.id]); await storage.remove(r.file_key).catch(() => {});
  res.json({ ok: true });
});
api.post('/receipts/delete', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => typeof x === 'string').slice(0, 500) : [];
  if (!ids.length) return res.status(400).json({ error: 'Pick at least one receipt.' });
  const rows = await db.q(`SELECT id, file_key, status FROM receipts WHERE user_id=$1 AND id::text = ANY($2::text[])`, [req.user.id, ids]);
  const ok = rows.filter((r) => !LOCKED.has(r.status));
  if (ok.length) await db.q(`DELETE FROM receipts WHERE user_id=$1 AND id = ANY($2::uuid[])`, [req.user.id, ok.map((r) => r.id)]);
  await Promise.all(ok.map((r) => storage.remove(r.file_key).catch(() => {})));
  res.json({ deleted: ok.map((r) => r.id), locked: rows.length - ok.length });
});
api.get('/receipts/:id/image', async (req, res) => {
  const r = await own(req, res); if (!r) return;
  if (r.mime.startsWith('text/')) return res.type('text/plain; charset=utf-8').send(await storage.get(r.file_key));
  const edits = { ...r.edits, ...(req.query.edits ? JSON.parse(req.query.edits) : {}) };
  const out = await image.preview(await storage.get(r.file_key), edits, req.query.view === 'raw');
  res.set('X-Plan', JSON.stringify(out.plan || null)).set('Cache-Control', 'private, no-store').type('image/jpeg').send(out.data);
});
api.get('/receipts/:id/thumb', async (req, res) => {
  const r = await own(req, res); if (!r) return;
  if (r.mime.startsWith('text/')) return res.status(204).end();
  res.set('Cache-Control', 'private, max-age=86400').type('image/jpeg').send(await image.thumbnail(await storage.get(r.file_key)));
});

/* ---------- periods & submissions ---------- */
async function periodReceipts(userId, from, to) {
  return db.q(`SELECT * FROM receipts WHERE user_id=$1 AND receipt_date BETWEEN $2 AND $3 ORDER BY receipt_date, created_at`, [userId, from, to]);
}
api.get('/period', async (req, res) => {
  const { from, to } = req.query; if (!isDate(from) || !isDate(to) || from > to) return res.status(400).json({ error: 'Pick a valid date range.' });
  const rows = await periodReceipts(req.user.id, from, to);
  const undated = await db.one(`SELECT count(*)::int AS n FROM receipts WHERE user_id=$1 AND receipt_date IS NULL`, [req.user.id]);
  const by = (s) => rows.filter((r) => r.status === s);
  const ready = by('checked');
  res.json({ from, to, ready: ready.length, readyTotal: lists.r2(ready.reduce((a, r) => a + (r.total || 0), 0)), needsCheck: by('read').length,
    unread: rows.filter((r) => ['queued', 'reading', 'error'].includes(r.status)).length, submitted: by('submitted').length, undated: undated.n });
});
api.post('/submissions', async (req, res) => {
  const { from, to } = req.body || {}; if (!isDate(from) || !isDate(to) || from > to) return res.status(400).json({ error: 'Pick a valid date range.' });
  const ready = (await periodReceipts(req.user.id, from, to)).filter((r) => r.status === 'checked');
  if (!ready.length) return res.status(400).json({ error: 'No checked receipts in this date range. Mark receipts checked before submitting.' });
  const total = lists.r2(ready.reduce((a, r) => a + (r.total || 0), 0));
  const sub = await db.one('INSERT INTO submissions (user_id, date_from, date_to, receipt_count, total) VALUES ($1,$2,$3,$4,$5) RETURNING *', [req.user.id, from, to, ready.length, total]);
  await db.q(`UPDATE receipts SET status='submitted', submission_id=$2, updated_at=now() WHERE user_id=$1 AND id = ANY($3::uuid[]) AND status='checked'`, [req.user.id, sub.id, ready.map((r) => r.id)]);
  res.json(sub);
});
api.get('/submissions', async (req, res) => {
  res.json(await db.q('SELECT * FROM submissions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.user.id]));
});
api.post('/submissions/:id/withdraw', async (req, res) => {
  const s = await db.one(`SELECT * FROM submissions WHERE id=$1 AND user_id=$2 AND status='submitted'`, [req.params.id, req.user.id]).catch(() => null);
  if (!s) return res.status(404).json({ error: 'Submission not found.' });
  await db.q(`UPDATE receipts SET status='checked', submission_id=NULL, updated_at=now() WHERE submission_id=$1 AND user_id=$2`, [s.id, req.user.id]);
  await db.q(`UPDATE submissions SET status='withdrawn', withdrawn_at=now() WHERE id=$1`, [s.id]);
  res.json({ ok: true });
});
api.get('/submissions/:id/package', async (req, res, next) => {
  try {
    const s = await db.one('SELECT * FROM submissions WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]).catch(() => null);
    if (!s) return res.status(404).json({ error: 'Submission not found.' });
    const rows = await db.q('SELECT * FROM receipts WHERE submission_id=$1 AND user_id=$2 ORDER BY receipt_date, created_at', [s.id, req.user.id]);
    await exporter.streamPackage(res, req.user, rows, { from: s.date_from, to: s.date_to, total: Number(s.total), submittedAt: new Date(s.created_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' });
  } catch (e) { next(e); }
});
// Download a period without submitting (checked and read receipts, nothing locked).
api.get('/package', async (req, res, next) => {
  try {
    const { from, to } = req.query; if (!isDate(from) || !isDate(to) || from > to) return res.status(400).json({ error: 'Pick a valid date range.' });
    const rows = (await periodReceipts(req.user.id, from, to)).filter((r) => r.result);
    if (!rows.length) return res.status(400).json({ error: 'No read receipts in this date range.' });
    await exporter.streamPackage(res, req.user, rows, { from, to, total: lists.r2(rows.reduce((a, r) => a + (r.total || 0), 0)) });
  } catch (e) { next(e); }
});

app.use('/api', api);
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Files must be under ${config.maxUploadMb} MB.` : 'Upload failed.' });
  console.error(err);
  if (res.headersSent) return res.destroy();
  res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
});

async function main() {
  await db.connect();
  await queue.start();
  app.listen(config.port, () => console.log(`Receipt Sorter on :${config.port} (reader: ${config.reader}, models: ${config.modelStandard} / ${config.modelCareful}${devUser ? ', dev sign-in' : ''})`));
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { app, main };
