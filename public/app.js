'use strict';
/* Strinteg Receipt Sorter — web page. Talks to the server's /api with the Clerk session token. */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const { money, num, r2, SPREAD } = ReceiptLogic;
let L = null; let EXP = []; let VEN = [];
const S = { picked: new Set(), me: null, receipts: [], active: null, filter: '', zoom: false, cropMode: false, pendingCrop: null, img: null, started: false, stale: {} };

function toast(msg, ms = 4500) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms); }
const activeR = () => S.receipts.find((r) => r.id === S.active) || null;
const fmtDate = (d) => d ? new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);

/* ---------- API ---------- */
async function token() { if (APP.devMode) return null; try { return await window.Clerk?.session?.getToken(); } catch (e) { return null; } }
async function call(path, opts = {}) {
  const headers = { ...(opts.headers || {}) }; const t = await token(); if (t) headers.Authorization = 'Bearer ' + t;
  let body = opts.body; if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  const res = await fetch('/api' + path, { method: opts.method || (body ? 'POST' : 'GET'), headers, body });
  if (!res.ok) { let msg = 'The server couldn\'t do that. Try again.'; try { msg = (await res.json()).error || msg; } catch (e) {} const err = new Error(msg); err.status = res.status; throw err; }
  return res;
}
const getJson = async (p) => (await call(p)).json();
async function download(path, fallbackName) {
  const res = await call(path);
  const cd = res.headers.get('Content-Disposition') || ''; const name = (cd.match(/filename="([^"]+)"/) || [])[1] || fallbackName;
  const url = URL.createObjectURL(await res.blob()); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ---------- startup ---------- */
window.addEventListener('load', async () => {
  if (APP.devMode) return start();
  if (!window.Clerk) { $('#signin').hidden = false; $('#signinMount').innerHTML = '<p class="note">Sign-in couldn\'t load. Check that CLERK_PUBLISHABLE_KEY is set on the server, then reload.</p>'; return; }
  await Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
  const route = () => {
    if (Clerk.isSignedIn) { $('#signin').hidden = true; if (!S.started) { Clerk.mountUserButton($('#userBtn')); start(); } }
    else { $('#app').hidden = true; $('#mailBtn').hidden = true; $('#signin').hidden = false; if (!$('#signinMount').childElementCount) Clerk.mountSignIn($('#signinMount')); }
  };
  Clerk.addListener(route); route();
});

async function start() {
  S.started = true;
  try { S.me = await getJson('/me'); } catch (e) { toast(e.message); return; }
  EXP = ReceiptLogic.parseExp(S.me.lists.exp); VEN = ReceiptLogic.parseVen(S.me.lists.ven); L = ReceiptLogic.make(EXP, VEN);
  const dl = document.createElement('datalist'); dl.id = 'vendorList'; dl.innerHTML = VEN.map((v) => `<option value="${esc(v.name)}"></option>`).join(''); document.body.appendChild(dl);
  $('#purpose').innerHTML = S.me.purposes.map((p) => `<option value="${p[0]}">${esc(p[1])}</option>`).join('');
  const st = S.me.settings || {};
  $('#purpose').value = st.purpose || 'project'; $('#project').value = st.project || ''; $('#splitPages').checked = st.splitPages !== false;
  let saved = null; try { saved = JSON.parse(localStorage.getItem('rs.range') || 'null'); } catch (e) {}
  if (saved?.from && saved?.to) { $('#from').value = saved.from; $('#to').value = saved.to; } else preset('this', false);
  $('#app').hidden = false; $('#mailBtn').hidden = false;
  await Promise.all([loadReceipts(), loadPeriod(), loadSubs()]);
  if (!S.active && S.receipts[0]) select(S.receipts[0].id);
  setInterval(poll, 3000);
}

/* ---------- data ---------- */
async function loadReceipts() {
  const prev = activeR();
  const fresh = await getJson(`/receipts?from=${$('#from').value}&to=${$('#to').value}`);
  // keep unsaved local edits on the receipt being worked on
  if (prev && (prev._pending || S.dirty)) { const i = fresh.findIndex((x) => x.id === prev.id); if (i >= 0) fresh[i] = Object.assign(prev, { status: fresh[i].status === 'submitted' ? 'submitted' : prev.status }); }
  S.receipts = fresh;
  if (S.active && !S.receipts.some((r) => r.id === S.active)) S.active = null;
  renderQueue(); renderDock();
  const now = activeR();
  if (now && prev && now.status !== prev.status && !S.dirty) { renderResult(); if (prev.status === 'queued' || prev.status === 'reading') loadImage(); }
  else if (!now) { renderViewer(); renderResult(); }
}
async function loadPeriod() {
  const f = $('#from').value; const t = $('#to').value; if (!f || !t) return;
  $('#periodLabel').textContent = `${fmtDate(f)} – ${fmtDate(t)}`;
  try { S.period = await getJson(`/period?from=${f}&to=${t}`); } catch (e) { S.period = null; }
  renderPeriod();
}
async function loadSubs() { try { S.subs = await getJson('/submissions'); } catch (e) { S.subs = []; } renderSubs(); }
let polling = false;
async function poll() {
  if (polling || document.hidden) return;
  if (!S.receipts.some((r) => r.status === 'queued' || r.status === 'reading')) return;
  polling = true;
  try { await loadReceipts(); await loadPeriod(); } catch (e) {} finally { polling = false; }
}

/* ---------- status ---------- */
function statusOf(r) {
  if (r.status === 'queued' || r.status === 'reading') return ['reading', r.status === 'queued' ? 'Queued' : 'Reading'];
  if (r.status === 'error') return ['issue', 'Read failed'];
  if (r.status === 'submitted') return ['sub', 'Submitted'];
  if (r.status === 'checked') return ['ok', 'Checked'];
  return L.checks(r).some((c) => c[0] === 'error') ? ['issue', 'Needs fixing'] : ['review', 'Review'];
}

/* ---------- queue ---------- */
function visible() {
  const f = S.filter;
  return S.receipts.filter((r) => !f || (f === 'todo' ? !['checked', 'submitted'].includes(r.status) : r.status === f));
}
function renderQueue() {
  const list = visible();
  $('#qCount').textContent = S.receipts.length ? `(${S.receipts.length})` : '';
  $('#queue').innerHTML = list.map((r, i) => {
    const [cls, txt] = statusOf(r); const prev = list[i - 1];
    const canJoin = prev && !r.mime.startsWith('text/') && !prev.mime.startsWith('text/') && r.status !== 'submitted' && prev.status !== 'submitted';
    const pick = r.status === 'submitted' ? '' : `<input type="checkbox" class="pick" data-pick="${r.id}" aria-label="Select ${esc(r.vendor || r.name)}"${S.picked.has(r.id) ? ' checked' : ''}>`;
    return `<li data-id="${r.id}" class="${r.id === S.active ? 'active' : ''}">${pick}
      ${r.mime.startsWith('text/') ? '<div class="th txt">EMAIL</div>' : `<img class="th" data-thumb="${r.id}" alt="">`}
      <div style="min-width:0"><div class="nm" title="${esc(r.name)}">${esc(r.vendor || r.result?.merchant || r.name)}</div>
      <div class="meta"><span class="chip ${cls}">${txt}</span>${r.total != null ? `<span class="num">${money(r.total)}</span>` : ''}${r.date ? `<span>${esc(fmtDate(r.date))}</span>` : ''}${r.source === 'email' ? '<span>· emailed</span>' : ''}</div>
      ${r.status !== 'submitted' ? `<div class="meta">${canJoin ? `<button class="btn ghost sm" data-join="${r.id}" data-into="${prev.id}" type="button" title="Combine with the receipt above (multi-page folio)">Join above</button>` : ''}<button class="btn ghost sm" data-del="${r.id}" type="button">Delete</button></div>` : ''}</div></li>`;
  }).join('') || `<li class="empty">${S.receipts.length ? 'Nothing matches this filter.' : 'No receipts dated in this range yet. Add some above, or email them in.'}</li>`;
  renderBulk();
  loadThumbs();
}
function renderBulk() {
  const ids = new Set(S.receipts.map((r) => r.id)); for (const id of [...S.picked]) if (!ids.has(id)) S.picked.delete(id);
  const pickable = visible().filter((r) => r.status !== 'submitted');
  const n = S.picked.size;
  $('#bulk').hidden = !pickable.length;
  $('#pickAll').checked = n > 0 && pickable.every((r) => S.picked.has(r.id));
  $('#pickAll').indeterminate = n > 0 && !$('#pickAll').checked;
  const b = $('#bulkDelete'); b.hidden = !n;
  if (!b.classList.contains('armed')) b.textContent = `Delete ${n} selected`;
}
/* Two clicks to delete: the first arms the button, the second does it. */
function armed(btn, label) {
  if (btn.classList.contains('armed')) { clearTimeout(btn._t); btn.classList.remove('armed'); return true; }
  btn._old = btn.textContent; btn.textContent = label; btn.classList.add('armed');
  btn._t = setTimeout(() => { btn.classList.remove('armed'); btn.textContent = btn._old; }, 4000);
  return false;
}
const thumbCache = new Map();
async function loadThumbs() {
  for (const img of document.querySelectorAll('img[data-thumb]')) {
    const id = img.dataset.thumb;
    if (thumbCache.has(id)) { img.src = thumbCache.get(id); continue; }
    call(`/receipts/${id}/thumb`).then((r) => r.blob()).then((b) => { const u = URL.createObjectURL(b); thumbCache.set(id, u); document.querySelectorAll(`img[data-thumb="${id}"]`).forEach((x) => (x.src = u)); }).catch(() => {});
  }
}
function select(id) { S.active = id; S.cropMode = false; S.pendingCrop = null; S.dirty = false; renderQueue(); loadImage(); renderResult(); }

/* ---------- viewer ---------- */
let imgReq = 0;
async function loadImage() {
  const r = activeR(); const my = ++imgReq;
  if (!r) { S.img = null; return renderViewer(); }
  $('#stage').innerHTML = '<div class="msg">Loading scan…</div>';
  try {
    if (r.mime.startsWith('text/')) {
      const text = await (await call(`/receipts/${r.id}/image`)).text();
      if (my !== imgReq) return; S.img = { text }; return renderViewer();
    }
    const res = await call(`/receipts/${r.id}/image${S.cropMode ? '?view=raw' : ''}`);
    const plan = JSON.parse(res.headers.get('X-Plan') || 'null');
    const url = URL.createObjectURL(await res.blob());
    if (my !== imgReq) return URL.revokeObjectURL(url);
    if (S.img?.url) URL.revokeObjectURL(S.img.url);
    S.img = { url, plan }; renderViewer();
  } catch (e) { if (my === imgReq) $('#stage').innerHTML = `<div class="msg">${esc(e.message)}</div>`; }
}
function renderViewer() {
  const r = activeR(); const v = $('#viewer'); const stage = $('#stage');
  const scan = r && !r.mime.startsWith('text/'); const locked = r?.status === 'submitted';
  v.classList.toggle('zoom', S.zoom); v.classList.toggle('crop', S.cropMode);
  ['#rotL', '#rotR', '#cropBtn', '#optEnhance', '#optBoost', '#optTrim'].forEach((s) => ($(s).disabled = !scan || locked));
  $('#zoomBtn').disabled = !scan;
  if (!r) { stage.innerHTML = '<div class="msg">Pick a receipt to see its scan.</div>'; $('#tileInfo').textContent = ''; return; }
  const e = r.edits || {};
  $('#optEnhance').checked = e.enhance !== false; $('#optBoost').checked = !!e.boost; $('#optTrim').checked = e.trim !== false;
  $('#cropBtn').textContent = S.cropMode ? 'Apply crop' : 'Crop'; $('#cropBtn').classList.toggle('on', S.cropMode);
  $('#cropReset').hidden = !(e.crop || S.cropMode) || locked; $('#cropReset').textContent = S.cropMode ? 'Cancel' : 'Undo crop';
  $('#zoomBtn').textContent = S.zoom ? 'Fit' : 'Zoom';
  if (!S.img) return;
  if (S.img.text != null) { stage.innerHTML = `<pre>${esc(S.img.text)}</pre>`; $('#tileInfo').textContent = 'Emailed receipt text'; return; }
  stage.innerHTML = `<img src="${S.img.url}" alt="Receipt scan">`;
  if (S.cropMode) { const b = document.createElement('div'); b.className = 'cropbox'; b.hidden = true; stage.appendChild(b); $('#tileInfo').textContent = 'Drag across the receipt, then Apply crop.'; return; }
  const p = S.img.plan;
  if (p && !p.single) p.tiles.forEach(([y0], i) => { if (!i) return; const d = document.createElement('div'); d.className = 'strip'; d.style.top = (y0 / p.height * 100) + '%'; d.innerHTML = `<span>${i + 1}</span>`; stage.appendChild(d); });
  $('#tileInfo').textContent = !p ? '' : p.single ? `Read as one image · ${Math.round(p.width * p.s)}×${Math.round(p.height * p.s)} px` : `Read as overview + ${p.tiles.length} overlapping strips · ${Math.round(p.width * p.s)} px wide`;
}
async function saveEdits(patch) {
  const r = activeR(); if (!r) return;
  r.edits = { ...(r.edits || {}), ...patch };
  try {
    const upd = await (await call(`/receipts/${r.id}`, { method: 'PATCH', json: { edits: r.edits } })).json();
    Object.assign(r, upd);
    if (r.result) S.stale[r.id] = true;
  } catch (e) { toast(e.message); }
  await loadImage(); renderResult();
}

/* ---------- results ---------- */
function catOptions(sel) {
  const o = (e) => `<option value="${esc(e.name)}"${e.name === sel ? ' selected' : ''}>${esc(e.name)}</option>`;
  return `<option value=""${!sel ? ' selected' : ''}>Choose expense type…</option><option value="${SPREAD}"${sel === SPREAD ? ' selected' : ''}>Spread across items (tax / fees)</option><optgroup label="Common">${EXP.filter((e) => !e.rare).map(o).join('')}</optgroup><optgroup label="Rarely used">${EXP.filter((e) => e.rare).map(o).join('')}</optgroup>`;
}
const issuesHtml = (r) => { const iss = L.checks(r); const ok = !iss.some((c) => c[0] !== 'info') ? '<li class="okay">Line items add up to the receipt total and every line has an expense type.</li>' : ''; return ok + iss.map(([l, t]) => `<li class="${l}">${esc(t)}</li>`).join(''); };
const catTotHtml = (R) => [...L.byCategory(R)].map(([k, v]) => `<div>${esc(k)}${L.isDirect(k) ? ' <span class="note">· direct</span>' : ''}</div><div>${money(v)}</div>`).join('');
function diffHtml(R) { const sum = L.linesSum(R); return R.total != null && Math.abs(sum - R.total) > 0.011 ? `<span style="color:var(--bad)">Off by ${money(r2(R.total - sum))}</span>` : R.total != null ? '<span style="color:var(--good)">Matches total</span>' : ''; }

function renderResult() {
  const r = activeR(); const box = $('#res'); const act = $('#resActions');
  if (!r) { act.innerHTML = ''; box.innerHTML = '<div class="empty">Add receipts on the left, or email them in. Each one is read automatically as soon as it arrives.</div>'; return; }
  if (r.status === 'queued' || r.status === 'reading') {
    act.innerHTML = '';
    box.innerHTML = `<div class="reading"><div style="color:var(--ink);font-weight:600">${r.readMode === 'careful' ? 'Re-reading carefully, digit by digit' : r.status === 'queued' ? 'Waiting to be read' : 'Reading the receipt'}</div><div class="note">Usually 10–40 seconds. You can keep working on other receipts.</div><div class="bar2"><i></i></div>${r.error ? `<p class="note">${esc(r.error)}</p>` : ''}</div>`;
    return;
  }
  const R = r.result; const locked = r.status === 'submitted';
  if (!R) {
    act.innerHTML = `<button class="btn primary" data-act="read" type="button">Read again</button><button class="btn ghost" data-act="manual" type="button">Enter by hand</button>`;
    box.innerHTML = `<div class="res"><ul class="issues"><li class="error">${esc(r.error || 'This receipt hasn\'t been read.')}</li></ul><p class="note">Check the scan first: rotate it upright and crop out anything that isn't this receipt, then read again.</p></div>`;
    return;
  }
  act.innerHTML = locked ? '' : `<button class="btn" data-act="careful" type="button">Re-read carefully</button>${r.status === 'checked' ? '<button class="btn" data-act="reopen" type="button">Reopen</button>' : '<button class="btn primary" data-act="check" type="button">Mark checked</button>'}`;
  const vhit = L.findVendor(R.vendor); const dis = locked ? 'disabled' : '';
  const f = (p, v, extra = '') => `<input type="text" data-f="${p}" value="${esc(v ?? '')}" ${extra} ${dis}>`;
  const m = (p, v) => `<input type="text" inputmode="decimal" class="money num" data-f="${p}" data-num="1" value="${v == null ? '' : Number(v).toFixed(2)}" ${dis}>`;
  box.innerHTML = `<div class="res">
    ${locked ? '<div class="lockedNote">Submitted. Withdraw the submission below to change this receipt.</div>' : ''}
    ${S.stale[r.id] && !locked ? '<div class="staleNote"><span>Scan settings changed. Read again so the result uses them.</span><button class="btn sm" data-act="read" type="button">Read again</button></div>' : ''}
    <ul class="issues" id="issues">${issuesHtml(r)}</ul>
    <div class="hgrid">
      <div class="field w2"><label>Printed merchant</label>${f('merchant', R.merchant)}</div>
      <div class="field w2"><label>Vendor</label><input type="text" list="vendorList" data-f="vendor" value="${esc(R.vendor)}" ${dis}><div class="vstat ${vhit ? 'ok' : 'new'}" id="vstat">${vhit ? 'On the vendor list' : 'New vendor (not on the list)'}</div></div>
      <div class="field"><label>Date</label><input type="date" data-f="date" value="${esc(R.date)}" ${dis}></div>
      <div class="field"><label>Purpose</label><select data-r="purpose" ${dis}>${S.me.purposes.map((p) => `<option value="${p[0]}"${p[0] === r.purpose ? ' selected' : ''}>${esc(p[1])}</option>`).join('')}</select></div>
      <div class="field"><label>Project #</label><input type="text" data-r="project" value="${esc(r.project)}" ${dis}></div>
      <div class="field"><label>Card</label>${f('card', [R.payment_method, R.card_last4 ? '…' + R.card_last4 : ''].filter(Boolean).join(' '))}</div>
      <div class="field"><label>Subtotal</label>${m('subtotal', R.subtotal)}</div>
      <div class="field"><label>Tax</label>${m('tax', R.tax)}</div>
      <div class="field"><label>Tip</label>${m('tip', R.tip)}</div>
      <div class="field"><label style="color:var(--orange)">Total paid</label>${m('total', R.total)}</div>
    </div>
    <div class="tblwrap"><table>
      <thead><tr><th>Line as printed</th><th style="text-align:right">Amount</th><th>Expense type</th><th></th></tr></thead>
      <tbody>${R.lines.map((l, i) => { const cf = l.category === SPREAD ? '' : l.confidence >= 0.85 ? 'hi' : l.confidence >= 0.7 ? 'mid' : 'lo';
        return `<tr class="${l.category && l.category !== SPREAD && l.confidence < 0.7 ? 'low' : ''}"><td><input type="text" data-l="${i}" data-k="description" value="${esc(l.description)}" ${dis}></td>
        <td class="amt"><input type="text" inputmode="decimal" class="money num ${l.uncertain ? 'unsure' : ''}" data-l="${i}" data-k="amount" value="${l.amount == null ? '' : l.amount.toFixed(2)}" title="${l.uncertain ? 'Hard to read — compare with the scan' : ''}" ${dis}></td>
        <td class="cat"><select data-l="${i}" data-k="category" ${dis}>${catOptions(l.category)}</select>${l.reason || cf ? `<div class="why">${cf ? `<span class="conf ${cf}">${cf === 'hi' ? 'Sure' : cf === 'mid' ? 'Likely' : 'Guess'}</span> · ` : ''}${esc(l.reason)}</div>` : ''}</td>
        <td class="x">${locked ? '' : `<button class="btn ghost sm" data-dl="${i}" title="Delete line" type="button">✕</button>`}</td></tr>`; }).join('')}</tbody>
      <tfoot><tr><td>Lines total</td><td class="money num" id="sumCell" style="text-align:right">${money(L.linesSum(R))}</td><td colspan="2" id="diffCell">${diffHtml(R)}</td></tr></tfoot>
    </table></div>
    <div class="sumrow"><div class="actions">${locked ? '' : '<button class="btn sm" data-act="addline" type="button">Add line</button><button class="btn sm" data-act="resort" type="button">Re-sort for this purpose</button>'}</div>
      <span class="note">${r.model === 'manual' ? 'Entered by hand' : `Read by ${esc(r.model || 'Claude')}`}${r.cost ? ` · ${money(r.cost)} of Claude usage` : ''} · quality: ${esc(R.read_quality)}</span></div>
    <div><div class="lbl" style="margin-bottom:6px">Totals by expense type</div><div class="cattot num" id="cattot">${catTotHtml(R)}</div></div>
    ${locked ? '' : `<div class="actions"><button class="btn sm danger" data-act="delete" type="button">Delete this receipt</button></div>`}
  </div>`;
}
function refreshLive() {
  const r = activeR(); if (!r?.result) return; const R = r.result;
  $('#issues').innerHTML = issuesHtml(r); $('#sumCell').textContent = money(L.linesSum(R)); $('#diffCell').innerHTML = diffHtml(R); $('#cattot').innerHTML = catTotHtml(R);
  const vh = L.findVendor(R.vendor); const vs = $('#vstat'); vs.className = 'vstat ' + (vh ? 'ok' : 'new'); vs.textContent = vh ? 'On the vendor list' : 'New vendor (not on the list)';
  if (r.status === 'checked') { r.status = 'read'; renderResult(); }
  renderQueue();
}
let saveTimer = null;
function scheduleSave(r, patch) {
  r._pending = { ...(r._pending || {}), ...patch }; S.dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flush(r), 700);
}
async function flush(r) {
  clearTimeout(saveTimer);
  const body = r._pending; if (!body) return; r._pending = null;
  if (body.result) body.result = r.result;
  try { const upd = await (await call(`/receipts/${r.id}`, { method: 'PATCH', json: body })).json(); r.status = upd.status; r.date = upd.date; r.total = upd.total; r.vendor = upd.vendor; renderQueue(); loadPeriod(); }
  catch (e) { toast(e.message); }
  finally { S.dirty = !!r._pending; }
}
function onEdit(e) {
  const r = activeR(); if (!r?.result || r.status === 'submitted') return; const t = e.target; const R = r.result;
  if (t.dataset.f) {
    if (t.dataset.f === 'card') { const v = t.value; R.card_last4 = (v.match(/(\d{4})\s*$/) || [])[1] || ''; R.payment_method = v.replace(/[.…\s]*\d{0,4}\s*$/, '').trim(); }
    else R[t.dataset.f] = t.dataset.num ? num(t.value) : t.value;
    scheduleSave(r, { result: true });
  } else if (t.dataset.r) {
    r[t.dataset.r] = t.value.trim(); scheduleSave(r, { [t.dataset.r]: r[t.dataset.r] });
    if (t.dataset.r === 'purpose' && e.type === 'change') toast('Purpose changed. Click "Re-sort for this purpose" to update the expense types.');
  } else if (t.dataset.l != null) {
    const l = R.lines[+t.dataset.l]; if (!l) return; const k = t.dataset.k;
    if (k === 'amount') { l.amount = num(t.value); l.uncertain = false; t.classList.remove('unsure'); }
    else if (k === 'category') { l.category = t.value; l.confidence = 1; l.reason = 'Set by you'; t.closest('tr').classList.remove('low'); }
    else l[k] = t.value;
    scheduleSave(r, { result: true });
  }
  refreshLive();
}

async function action(act, r, btnEl) {
  try {
    if (act === 'read' || act === 'careful') {
      await flush(r); delete S.stale[r.id];
      Object.assign(r, await (await call(`/receipts/${r.id}/read`, { json: { careful: act === 'careful' } })).json());
      renderQueue(); renderResult();
    } else if (act === 'check' || act === 'reopen') {
      await flush(r);
      Object.assign(r, await (await call(`/receipts/${r.id}`, { method: 'PATCH', json: { status: act === 'check' ? 'checked' : 'read' } })).json());
      if (act === 'check') { const next = visible().find((x) => x.id !== r.id && x.status === 'read'); if (next) select(next.id); else { renderQueue(); renderResult(); } }
      else { renderQueue(); renderResult(); }
      loadPeriod();
    } else if (act === 'manual') {
      r.result = { merchant: '', merchant_address: '', vendor: '', date: '', time: '', receipt_type: 'other', payment_method: '', card_last4: '', subtotal: null, tax: null, tip: null, total: null, lines: [{ description: '', amount: null, kind: 'item', category: '', confidence: 1, reason: '', uncertain: false }], read_quality: 'good', illegible: [], notes: '' };
      r.model = 'manual'; r.status = 'read'; scheduleSave(r, { result: true, status: 'read' }); renderResult(); renderQueue();
    } else if (act === 'addline') {
      r.result.lines.push({ description: '', amount: null, kind: 'item', category: '', confidence: 1, reason: '', uncertain: false }); scheduleSave(r, { result: true }); renderResult();
    } else if (act === 'resort') {
      await flush(r); toast('Re-sorting expense types…', 2500);
      Object.assign(r, await (await call(`/receipts/${r.id}/resort`, { json: {} })).json()); renderResult(); renderQueue();
      toast('Expense types updated for ' + (S.me.purposes.find((p) => p[0] === r.purpose) || [])[1]?.toLowerCase());
    } else if (act === 'delete') {
      if (!armed(btnEl, 'Click again to delete')) return;
      await removeReceipt(r.id);
    }
  } catch (e) { toast(e.message); }
}
async function removeReceipt(id) {
  await call(`/receipts/${id}`, { method: 'DELETE' });
  dropLocal([id]); toast('Receipt deleted');
}
function dropLocal(ids) {
  const gone = new Set(ids); const v0 = visible(); const i = v0.findIndex((x) => x.id === S.active);
  S.receipts = S.receipts.filter((x) => !gone.has(x.id)); ids.forEach((id) => { S.picked.delete(id); thumbCache.delete(id); });
  if (gone.has(S.active)) { const v = visible(); S.active = (v[i] || v[i - 1] || v[0])?.id || null; loadImage(); renderResult(); }
  renderQueue(); loadPeriod();
}
async function deletePicked(btn) {
  const ids = [...S.picked]; if (!ids.length) return;
  if (!armed(btn, `Click again to delete ${ids.length}`)) return;
  try {
    const out = await (await call('/receipts/delete', { json: { ids } })).json();
    dropLocal(out.deleted);
    toast(`Deleted ${out.deleted.length} receipt${out.deleted.length === 1 ? '' : 's'}${out.locked ? `. ${out.locked} submitted receipt${out.locked === 1 ? ' was' : 's were'} kept` : ''}.`);
  } catch (e) { toast(e.message); }
}

/* ---------- uploads ---------- */
async function uploadFiles(files) {
  if (!files.length) return;
  const fd = new FormData(); files.forEach((f) => fd.append('files', f)); fd.append('splitPages', String($('#splitPages').checked));
  toast(`Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`, 60000);
  try {
    const out = await (await call('/receipts', { body: fd })).json();
    const skip = out.skipped.map((s) => `${s.name}: ${s.reason}`).join(' ');
    toast(out.ids.length ? `Added ${out.ids.length} receipt${out.ids.length > 1 ? 's' : ''}. Reading now.${skip ? ' ' + skip : ''}` : skip || 'Nothing was added.', 7000);
    await loadReceipts();
    if (out.ids[0]) select(out.ids[0]);
  } catch (e) { toast(e.message); }
}

/* ---------- period & submit ---------- */
function preset(kind, reload = true) {
  const now = new Date(); let a; let b;
  if (kind === 'this') { a = new Date(now.getFullYear(), now.getMonth(), 1); b = new Date(now.getFullYear(), now.getMonth() + 1, 0); }
  else if (kind === 'last') { a = new Date(now.getFullYear(), now.getMonth() - 1, 1); b = new Date(now.getFullYear(), now.getMonth(), 0); }
  else { b = now; a = new Date(now.getTime() - 29 * 864e5); }
  $('#from').value = iso(a); $('#to').value = iso(b);
  if (reload) rangeChanged();
}
async function rangeChanged() {
  const f = $('#from').value; const t = $('#to').value; if (!f || !t) return;
  if (f > t) { toast('The From date is after the To date.'); return; }
  try { localStorage.setItem('rs.range', JSON.stringify({ from: f, to: t })); } catch (e) {}
  $('#confirmBox').hidden = true;
  await Promise.all([loadReceipts(), loadPeriod()]);
  if (!activeR() && visible()[0]) select(visible()[0].id);
}
function renderPeriod() {
  const p = S.period; if (!p) { $('#periodStat').innerHTML = ''; return; }
  $('#periodStat').innerHTML = `<span>Checked, ready to submit</span><b>${p.ready} · ${money(p.readyTotal)}</b>
    <span>Read, still to check</span><b>${p.needsCheck}</b><span>Waiting to be read or failed</span><b>${p.unread}</b>
    <span>Already submitted</span><b>${p.submitted}</b>${p.undated ? `<span>Without a date (any period)</span><b>${p.undated}</b>` : ''}`;
  $('#submitBtn').textContent = p.ready ? `Submit ${p.ready} receipt${p.ready > 1 ? 's' : ''}` : 'Submit';
  $('#submitBtn').disabled = !p.ready;
}
function renderDock() { renderPeriod(); }
function renderSubs() {
  $('#subs').innerHTML = (S.subs || []).map((s) => `<li class="${s.status}"><div class="grow"><b>${esc(fmtDate(String(s.date_from).slice(0, 10)))} – ${esc(fmtDate(String(s.date_to).slice(0, 10)))}</b> · ${s.receipt_count} receipts · <span class="num">${money(Number(s.total))}</span><div class="note">${s.status === 'withdrawn' ? 'Withdrawn' : 'Submitted'} ${esc(new Date(s.created_at).toLocaleString())}</div></div>
    ${s.status === 'submitted' ? `<button class="btn sm" data-pkg="${s.id}" type="button">Download package</button><button class="btn ghost sm" data-wd="${s.id}" type="button">Withdraw</button>` : ''}</li>`).join('') || '<li class="note">None yet.</li>';
}
function showConfirm() {
  const p = S.period; if (!p?.ready) return;
  const left = p.needsCheck + p.unread;
  const box = $('#confirmBox'); box.hidden = false;
  box.innerHTML = `<div><b>Submit ${p.ready} checked receipt${p.ready > 1 ? 's' : ''} dated ${esc(fmtDate(p.from))} to ${esc(fmtDate(p.to))}, totaling ${money(p.readyTotal)}?</b></div>
    <div>They'll be locked so they can't be claimed twice, and the package downloads: an Excel workbook, one PDF with every receipt, and each receipt as its own file. Upload these to the ERP expense report.</div>
    ${left ? `<div style="color:var(--bad)">${left} receipt${left > 1 ? 's' : ''} in this range ${left > 1 ? 'aren\'t' : 'isn\'t'} checked and will be left out.</div>` : ''}
    <div class="actions"><button class="btn primary" id="doSubmit" type="button">Submit and download</button><button class="btn ghost" id="cancelSubmit" type="button">Cancel</button></div>`;
}
async function doSubmit() {
  const btn = $('#doSubmit'); btn.disabled = true; btn.textContent = 'Submitting…';
  try {
    const s = await (await call('/submissions', { json: { from: $('#from').value, to: $('#to').value } })).json();
    $('#confirmBox').hidden = true; toast('Submitted. Building the package…', 15000);
    await Promise.all([loadReceipts(), loadPeriod(), loadSubs()]); renderResult();
    await download(`/submissions/${s.id}/package`, 'receipts.zip'); toast('Package downloaded');
  } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Submit and download'; }
}

/* ---------- email-in ---------- */
async function openMail() {
  const me = S.me; const dlg = $('#mailDlg');
  $('#mailBody').innerHTML = me.inboundAddress
    ? `<p style="margin:0 0 8px">Send or forward receipts to your personal address. Each photo or PDF attached becomes a receipt and is read automatically. Forwarded e-receipts with no attachment (airlines, Uber, hotels) are read from the email text.</p>
       <div class="addr"><code id="addrText">${esc(me.inboundAddress)}</code><button class="btn sm" id="copyAddr" type="button">Copy</button></div>
       <p class="note" style="margin:8px 0 0">Save it as a contact on your phone, for example "Receipts". From a phone: take the photo, Share, Mail, send to Receipts.${me.user.email ? ` Mail sent from ${esc(me.user.email)} to the address without the + part also reaches you.` : ''}</p>`
    : '<p style="margin:0">Email-in isn\'t set up on this server yet. The administrator needs to add the Postmark inbound address (INBOUND_ADDRESS).</p>';
  $('#mailLog').innerHTML = '<li class="note">Loading…</li>';
  dlg.showModal();
  try {
    const log = await getJson('/inbound-log');
    $('#mailLog').innerHTML = log.map((l) => `<li><div class="grow"><b>${esc(l.subject || '(no subject)')}</b><div class="note">${esc(new Date(l.created_at).toLocaleString())} · ${esc(l.outcome)}</div></div></li>`).join('') || '<li class="note">No emails received yet.</li>';
  } catch (e) { $('#mailLog').innerHTML = `<li class="note">${esc(e.message)}</li>`; }
}

/* ---------- events ---------- */
$('#from').addEventListener('change', rangeChanged); $('#to').addEventListener('change', rangeChanged);
document.querySelector('.presets').addEventListener('click', (e) => { const b = e.target.closest('[data-preset]'); if (b) preset(b.dataset.preset); });
const saveSettings = () => call('/me/settings', { method: 'PATCH', json: { purpose: $('#purpose').value, project: $('#project').value, splitPages: $('#splitPages').checked } }).catch((e) => toast(e.message));
['#purpose', '#project', '#splitPages'].forEach((s) => $(s).addEventListener('change', saveSettings));
$('#statusFilter').addEventListener('change', (e) => { S.filter = e.target.value; S.picked.clear(); renderQueue(); });
$('#pickAll').addEventListener('change', (e) => { const p = visible().filter((r) => r.status !== 'submitted'); if (e.target.checked) p.forEach((r) => S.picked.add(r.id)); else S.picked.clear(); renderQueue(); });
$('#bulkDelete').addEventListener('click', (e) => deletePicked(e.currentTarget));

$('#drop').onclick = () => $('#fileIn').click();
$('#drop').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileIn').click(); } };
$('#fileIn').onchange = (e) => { uploadFiles([...e.target.files]); e.target.value = ''; };
let dragDepth = 0;
addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
addEventListener('drop', (e) => { if (!e.dataTransfer?.files?.length || $('#app').hidden) return; e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging'); uploadFiles([...e.dataTransfer.files]); });
addEventListener('paste', (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length && !$('#app').hidden && !/input|textarea/i.test(document.activeElement?.tagName)) uploadFiles(fs); });

$('#queue').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]'); const jn = e.target.closest('[data-join]'); const li = e.target.closest('li[data-id]');
  const pk = e.target.closest('[data-pick]');
  if (pk) { if (pk.checked) S.picked.add(pk.dataset.pick); else S.picked.delete(pk.dataset.pick); renderBulk(); return; }
  if (del) { if (!armed(del, 'Confirm delete')) return; try { await removeReceipt(del.dataset.del); } catch (err) { toast(err.message); } return; }
  if (jn) {
    try { const upd = await (await call(`/receipts/${jn.dataset.into}/join`, { json: { with: jn.dataset.join } })).json(); thumbCache.delete(upd.id); toast('Joined into one receipt. Reading it again.'); await loadReceipts(); select(upd.id); }
    catch (err) { toast(err.message); }
    return;
  }
  if (li && li.dataset.id !== S.active) { const prev = activeR(); if (prev?._pending) await flush(prev); select(li.dataset.id); }
});
$('#rotL').onclick = () => { const r = activeR(); if (r) saveEdits({ rot: ((r.edits?.rot || 0) - 90 + 360) % 360, crop: null }); };
$('#rotR').onclick = () => { const r = activeR(); if (r) saveEdits({ rot: ((r.edits?.rot || 0) + 90) % 360, crop: null }); };
$('#zoomBtn').onclick = () => { S.zoom = !S.zoom; renderViewer(); };
$('#optEnhance').onchange = (e) => saveEdits({ enhance: e.target.checked, ...(e.target.checked ? {} : { boost: false }) });
$('#optBoost').onchange = (e) => saveEdits({ boost: e.target.checked, ...(e.target.checked ? { enhance: true } : {}) });
$('#optTrim').onchange = (e) => saveEdits({ trim: e.target.checked });
$('#cropBtn').onclick = async () => {
  if (S.cropMode) { const c = S.pendingCrop; S.cropMode = false; S.pendingCrop = null; if (c && c.w > 0.03 && c.h > 0.03) return saveEdits({ crop: c }); return loadImage(); }
  S.cropMode = true; S.zoom = false; S.pendingCrop = null; loadImage(); renderViewer();
};
$('#cropReset').onclick = () => { if (S.cropMode) { S.cropMode = false; S.pendingCrop = null; loadImage(); renderViewer(); } else saveEdits({ crop: null }); };
$('#stage').addEventListener('pointerdown', (e) => {
  if (!S.cropMode) return; const im = $('#stage img'); const box = $('#stage .cropbox'); if (!im || !box) return; e.preventDefault();
  const rect = im.getBoundingClientRect(); const pt = (ev) => ({ x: Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height)) });
  const a = pt(e); im.setPointerCapture(e.pointerId);
  const mv = (ev) => { const b = pt(ev); S.pendingCrop = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }; box.hidden = false; Object.assign(box.style, { left: S.pendingCrop.x * 100 + '%', top: S.pendingCrop.y * 100 + '%', width: S.pendingCrop.w * 100 + '%', height: S.pendingCrop.h * 100 + '%' }); };
  const up = () => { im.removeEventListener('pointermove', mv); im.removeEventListener('pointerup', up); };
  im.addEventListener('pointermove', mv); im.addEventListener('pointerup', up);
});
$('#stage').addEventListener('click', (e) => { if (!S.cropMode && e.target.tagName === 'IMG') { S.zoom = !S.zoom; renderViewer(); } });

$('#resActions').addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); const r = activeR(); if (b && r) action(b.dataset.act, r, b); });
$('#res').addEventListener('click', (e) => {
  const r = activeR(); if (!r) return;
  const b = e.target.closest('[data-act]'); if (b) return action(b.dataset.act, r, b);
  const dl = e.target.closest('[data-dl]'); if (dl && r.result) { r.result.lines.splice(+dl.dataset.dl, 1); scheduleSave(r, { result: true }); renderResult(); }
});
$('#res').addEventListener('input', onEdit); $('#res').addEventListener('change', onEdit);

$('#submitBtn').onclick = showConfirm;
$('#confirmBox').addEventListener('click', (e) => { if (e.target.id === 'doSubmit') doSubmit(); if (e.target.id === 'cancelSubmit') $('#confirmBox').hidden = true; });
$('#previewBtn').onclick = async () => { toast('Building the package…', 15000); try { await download(`/package?from=${$('#from').value}&to=${$('#to').value}`, 'receipts.zip'); toast('Package downloaded. Nothing was locked.'); } catch (e) { toast(e.message); } };
$('#subs').addEventListener('click', async (e) => {
  const p = e.target.closest('[data-pkg]'); const w = e.target.closest('[data-wd]');
  if (p) { toast('Building the package…', 15000); try { await download(`/submissions/${p.dataset.pkg}/package`, 'receipts.zip'); toast('Package downloaded'); } catch (err) { toast(err.message); } }
  if (w) {
    if (w.dataset.confirm !== '1') { w.dataset.confirm = '1'; w.textContent = 'Confirm withdraw'; w.classList.add('on'); return; }
    try { await call(`/submissions/${w.dataset.wd}/withdraw`, { json: {} }); toast('Withdrawn. Those receipts are unlocked and marked checked.'); await Promise.all([loadReceipts(), loadPeriod(), loadSubs()]); renderResult(); } catch (err) { toast(err.message); }
  }
});
$('#mailBtn').onclick = openMail;
$('#mailClose').onclick = () => $('#mailDlg').close();
$('#mailDlg').addEventListener('click', async (e) => { if (e.target.id === 'copyAddr') { try { await navigator.clipboard.writeText($('#addrText').textContent); toast('Address copied'); } catch (err) { toast('Select the address and copy it.'); } } });
addEventListener('beforeunload', () => { const r = activeR(); if (r?._pending) flush(r); });

