'use strict';
/* Postmark inbound webhook: receipts emailed to the app.
   Each user has an address like <server-hash>+<their token>@inbound.postmarkapp.com.
   Mail sent to the plain address is matched to a user by the sender's email instead. */
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const intake = require('./intake');

function authorized(req) {
  if (!config.inboundWebhookPassword) return false;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  return eq(u || '', config.inboundWebhookUser) && eq(p || '', config.inboundWebhookPassword);
}

function htmlToText(html) {
  return String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n').trim();
}

async function findUser(msg) {
  const hashes = [msg.MailboxHash, ...(msg.ToFull || []).map((t) => t.MailboxHash), ...(msg.CcFull || []).map((t) => t.MailboxHash)].filter(Boolean);
  for (const h of hashes) { const u = await db.one('SELECT * FROM users WHERE inbound_token=$1', [String(h).toLowerCase()]); if (u) return u; }
  const from = (msg.FromFull?.Email || msg.From || '').toLowerCase().trim();
  if (from) return db.one('SELECT * FROM users WHERE lower(email)=$1', [from]);
  return null;
}

async function handle(req, res) {
  if (!authorized(req)) return res.status(401).send('unauthorized');
  const msg = req.body || {};
  const sender = msg.FromFull?.Email || msg.From || '';
  const subject = msg.Subject || '';
  const log = (user, outcome, ids = []) => db.q('INSERT INTO inbound_log (user_id, sender, subject, outcome, receipt_ids) VALUES ($1,$2,$3,$4,$5)', [user?.id || null, sender, subject, outcome, JSON.stringify(ids)]);
  try {
    const user = await findUser(msg);
    if (!user) { await log(null, 'Sender not recognized'); return res.json({ ok: true }); }
    const atts = (msg.Attachments || []).filter((a) => {
      const f = { name: a.Name || 'attachment', mime: a.ContentType || '' };
      if (!intake.isPdf(f) && !intake.isImage(f)) return false;
      // skip logos and signature images embedded in the email body
      if (a.ContentID && (a.ContentLength || 0) < 25000 && !intake.isPdf(f)) return false;
      return true;
    });
    if (atts.length) {
      const files = atts.map((a) => ({ name: a.Name || 'attachment', mime: a.ContentType || '', buffer: Buffer.from(a.Content || '', 'base64') }));
      const { ids, skipped } = await intake.addFiles(user, files, { source: 'email', subject });
      await log(user, ids.length ? `${ids.length} receipt${ids.length > 1 ? 's' : ''} added${skipped.length ? `, ${skipped.length} skipped` : ''}` : 'Attachments could not be opened', ids);
      return res.json({ ok: true });
    }
    const text = (msg.TextBody && msg.TextBody.trim()) || htmlToText(msg.HtmlBody);
    if (text && /\$\s?\d|\d+\.\d{2}\b/.test(text)) {
      const id = await intake.addText(user, `From: ${sender}\nSubject: ${subject}\nDate: ${msg.Date || ''}\n\n${text}`, { name: subject || 'Emailed receipt', subject });
      await log(user, 'Receipt added from email text', [id]);
    } else {
      await log(user, 'No receipt found (no attachment or amounts)');
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('inbound', e);
    return res.status(500).json({ ok: false }); // Postmark retries
  }
}

function addressFor(user) {
  if (!config.inboundAddress) return '';
  const [local, domain] = config.inboundAddress.split('@');
  return `${local}+${user.inbound_token}@${domain}`;
}

module.exports = { handle, addressFor, htmlToText };
