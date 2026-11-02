/* Receipt rules shared by the server (Node) and the web page (browser). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReceiptLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const SPREAD = 'SPREAD';
  const r2 = (n) => Math.round(n * 100) / 100;
  const num = (v) => { if (v === '' || v == null) return null; const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,\s]/g, '')); return isNaN(n) ? null : r2(n); };
  const money = (n) => (n == null || isNaN(n)) ? '—' : (n < 0 ? '−$' : '$') + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  function parseExp(t) {
    return t.split(/\r?\n/).filter((l) => l.trim()).map((l) => {
      const p = l.split('\t'); const raw = p[0].trim();
      return { name: raw.replace(/^★\s*/, '').trim(), desc: (p.slice(1).join(' ') || '').trim(), rare: raw.startsWith('★') };
    });
  }
  function parseVen(t) {
    return t.split(/\r?\n/).filter((l) => l.trim()).map((l) => { const p = l.split('\t'); return { name: p[0].trim(), type: (p[2] || 'Vendor').trim() }; }).filter((v) => v.name);
  }
  function normKey(s) {
    return (s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\b(the|inc|llc|co|corp|corporation|company|ltd|na|of|dba|store|stores)\b/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function make(EXP, VEN) {
    const isDirect = (c) => /\(Direct\)/i.test(c || '');
    const needsApproval = (c) => /^(3[23]\d\d(\.\d)?)\s+(BSD|M)\s+-/.test(c || '');
    function findVendor(name) {
      if (!name) return null; const k = normKey(name); if (!k) return null;
      const hit = VEN.find((v) => v.name.toLowerCase() === String(name).toLowerCase()) || VEN.find((v) => normKey(v.name) === k);
      if (hit) return hit;
      let best = null; let bl = 0;
      for (const v of VEN) { const vk = normKey(v.name); if (vk.length < 4) continue; if ((' ' + k + ' ').includes(' ' + vk + ' ') && vk.length > bl) { best = v; bl = vk.length; } }
      return best;
    }
    function matchCategory(c) {
      if (!c) return ''; if (c === SPREAD || /^spread/i.test(c)) return SPREAD;
      const s = String(c).replace(/^★\s*/, '').trim().toLowerCase();
      let hit = EXP.find((e) => e.name.toLowerCase() === s); if (hit) return hit.name;
      const code = (s.match(/^\d{4}(\.\d)?/) || [])[0];
      if (code) { hit = EXP.find((e) => e.name.startsWith(code + ' ')); if (hit) return hit.name; }
      hit = EXP.find((e) => e.name.toLowerCase().includes(s) || s.includes(e.name.toLowerCase()));
      return hit ? hit.name : '';
    }
    function normalize(raw) {
      const R = {}; const s = (v) => (v == null || v === 'null') ? '' : String(v).trim();
      R.merchant = s(raw.merchant); R.merchant_address = s(raw.merchant_address);
      R.date = /^\d{4}-\d{2}-\d{2}$/.test(s(raw.date)) ? s(raw.date) : ''; R.time = s(raw.time);
      R.receipt_type = s(raw.receipt_type) || 'other'; R.payment_method = s(raw.payment_method); R.card_last4 = s(raw.card_last4).replace(/\D/g, '').slice(-4);
      R.subtotal = num(raw.subtotal); R.tax = num(raw.tax); R.tip = num(raw.tip); R.total = num(raw.total);
      R.read_quality = ['good', 'fair', 'poor'].includes(raw.read_quality) ? raw.read_quality : 'fair';
      R.illegible = Array.isArray(raw.illegible) ? raw.illegible.map(String).filter(Boolean) : []; R.notes = s(raw.notes);
      let v = raw.vendor ? findVendor(raw.vendor) : null; if (!v) v = findVendor(R.merchant);
      R.vendor = v ? v.name : (s(raw.vendor_new_name) || s(raw.vendor) || R.merchant);
      R.lines = (Array.isArray(raw.lines) ? raw.lines : []).map((l) => {
        const cat = matchCategory(s(l.category));
        return { description: s(l.description), amount: num(l.amount), qty: num(l.qty), kind: s(l.kind) || 'item', category: cat,
          confidence: cat ? Math.max(0, Math.min(1, Number(l.confidence) || 0.5)) : 0,
          reason: s(l.reason) + (l.category && !cat ? ` (Claude suggested "${s(l.category)}", which isn't on the list)` : ''), uncertain: !!l.uncertain };
      });
      return R;
    }
    const linesSum = (R) => r2(R.lines.reduce((a, l) => a + (l.amount || 0), 0));
    function checks(rec) {
      const R = rec.result; const out = []; if (!R) return out;
      const sum = linesSum(R);
      if (R.total == null) out.push(['error', 'The receipt total wasn\'t read. Type it in from the scan.']);
      else if (Math.abs(sum - R.total) > 0.011) out.push(['error', `Line items add up to ${money(sum)} but the receipt total is ${money(R.total)} (off by ${money(r2(R.total - sum))}). A digit is likely misread or a line is missing.`]);
      if (R.subtotal != null && R.total != null) { const calc = r2(R.subtotal + (R.tax || 0) + (R.tip || 0)); if (Math.abs(calc - R.total) > 0.011 && Math.abs(sum - R.total) > 0.011) out.push(['warn', `Subtotal + tax + tip = ${money(calc)}, which doesn't match the total.`]); }
      if (!R.date) out.push(['error', 'No date was read. Enter the receipt date; it decides which period the receipt belongs to.']);
      else { const d = new Date(R.date + 'T12:00:00'); const now = new Date(); if (d > now) out.push(['warn', `The date ${R.date} is in the future. Check the year.`]); else if ((now - d) / 864e5 > 400) out.push(['warn', `The date ${R.date} is over a year old. Check the year.`]); }
      if (!R.lines.length) out.push(['error', 'No line items. Add them by hand or read again.']);
      const noCat = R.lines.filter((l) => !l.category).length; if (noCat) out.push(['error', `${noCat} line${noCat > 1 ? 's have' : ' has'} no expense type.`]);
      if (R.lines.some((l) => l.category === SPREAD) && !R.lines.some((l) => l.category && l.category !== SPREAD)) out.push(['error', 'Tax or fees are set to spread, but no item has an expense type to spread onto.']);
      const unsure = R.lines.filter((l) => l.uncertain).length; if (unsure) out.push(['warn', `${unsure} amount${unsure > 1 ? 's were' : ' was'} hard to read. They're highlighted; compare them with the scan.`]);
      const low = R.lines.filter((l) => l.category && l.category !== SPREAD && l.confidence < 0.7).length; if (low) out.push(['warn', `${low} expense type${low > 1 ? ' choices are' : ' choice is'} a guess. Marked with a yellow edge.`]);
      if (R.lines.some((l) => isDirect(l.category)) && !rec.project) out.push(['warn', 'Direct (project) expense types need a project number.']);
      if (R.read_quality === 'poor') out.push(['warn', 'Claude rated this scan hard to read. Try "Darken faded print" or crop tighter, then re-read carefully.']);
      if (R.illegible.length) out.push(['warn', 'Couldn\'t read: ' + R.illegible.join(', ') + '.']);
      const tel = R.lines.filter((l) => l.category === '3021 Telephone').reduce((a, l) => a + (l.amount || 0), 0); if (tel > 100) out.push(['warn', `Telephone is ${money(tel)}; only $100 a month is claimable.`]);
      if (R.lines.some((l) => needsApproval(l.category))) out.push(['info', 'BSD and Management expense types need management approval before the cost is incurred.']);
      if (R.lines.some((l) => l.kind === 'alcohol')) out.push(['info', 'Alcohol is on its own line under 7000, as the policy requires.']);
      if (R.vendor && !findVendor(R.vendor)) out.push(['info', `"${R.vendor}" isn't on the vendor list. It will export as a new vendor.`]);
      if (R.notes) out.push(['info', R.notes]);
      return out;
    }
    function allocate(R) {
      const items = R.lines.filter((l) => l.category && l.category !== SPREAD && (l.amount || 0) > 0);
      const base = items.reduce((a, l) => a + l.amount, 0);
      const rows = R.lines.filter((l) => l.category !== SPREAD).map((l) => Object.assign({}, l, { alloc: l.amount || 0 }));
      const spread = R.lines.filter((l) => l.category === SPREAD).reduce((a, l) => a + (l.amount || 0), 0);
      if (spread && base > 0) {
        let given = 0; const targets = rows.filter((l) => l.category && (l.amount || 0) > 0);
        targets.forEach((l, i) => { const share = i === targets.length - 1 ? r2(spread - given) : r2(spread * l.amount / base); l.alloc = r2(l.alloc + share); given = r2(given + share); });
      }
      return rows;
    }
    function byCategory(R) { const m = new Map(); for (const l of allocate(R)) { const k = l.category || '(no expense type)'; m.set(k, r2((m.get(k) || 0) + l.alloc)); } return m; }
    return { isDirect, needsApproval, findVendor, matchCategory, normalize, linesSum, checks, allocate, byCategory };
  }
  return { SPREAD, r2, num, money, parseExp, parseVen, normKey, make };
});
