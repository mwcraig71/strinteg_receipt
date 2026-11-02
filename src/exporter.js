'use strict';
/* Builds the submission package: Excel workbook + one combined PDF + each receipt as its own file, in a ZIP. */
const ExcelJS = require('exceljs');
const { ZipArchive } = require('archiver');
const sharp = require('sharp');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const storage = require('./storage');
const image = require('./image');
const lists = require('./lists');

const xlDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? new Date(d + 'T00:00:00Z') : d || '');
const slug = (s) => String(s || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'receipt';
const fileBase = (r, i) => `${String(i + 1).padStart(2, '0')}_${r.receipt_date || 'nodate'}_${slug(r.result?.vendor)}_${(r.total ?? 0).toFixed(2)}`;
const cardOf = (R) => (R.payment_method || '') + (R.card_last4 ? ' …' + R.card_last4 : '');

async function workbook(user, receipts, meta) {
  const wb = new ExcelJS.Workbook(); wb.creator = 'Strinteg Receipt Sorter'; wb.created = new Date();
  const head = (ws) => { const r = ws.getRow(1); r.font = { bold: true, color: { argb: 'FFFFFFFF' } }; r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003388' } }; ws.views = [{ state: 'frozen', ySplit: 1 }]; ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } }; };
  const money = '$#,##0.00;[Red]-$#,##0.00';

  const lines = wb.addWorksheet('Expense lines');
  lines.columns = [
    { header: 'Receipt #', key: 'n', width: 9 }, { header: 'Date', key: 'date', width: 11, style: { numFmt: 'yyyy-mm-dd' } }, { header: 'Vendor', key: 'vendor', width: 28 },
    { header: 'Vendor status', key: 'vstat', width: 12 }, { header: 'Expense type', key: 'cat', width: 34 }, { header: 'Project #', key: 'proj', width: 11 },
    { header: 'Description', key: 'desc', width: 40 }, { header: 'Amount', key: 'amt', width: 12, style: { numFmt: money } },
    { header: 'Card', key: 'card', width: 14 }, { header: 'Receipt file', key: 'file', width: 38 }, { header: 'Check before filing', key: 'flags', width: 50 }];
  const bycat = wb.addWorksheet('By expense type');
  bycat.columns = [{ header: 'Expense type', key: 'cat', width: 36 }, { header: 'Project #', key: 'proj', width: 12 }, { header: 'Receipts', key: 'cnt', width: 10 }, { header: 'Amount', key: 'amt', width: 14, style: { numFmt: money } }];
  const recs = wb.addWorksheet('Receipts');
  recs.columns = [{ header: 'Receipt #', key: 'n', width: 9 }, { header: 'Date', key: 'date', width: 11, style: { numFmt: 'yyyy-mm-dd' } }, { header: 'Vendor', key: 'vendor', width: 28 }, { header: 'Printed merchant', key: 'merchant', width: 30 },
    { header: 'Purpose', key: 'purpose', width: 26 }, { header: 'Total', key: 'total', width: 12, style: { numFmt: money } }, { header: 'Came in by', key: 'src', width: 10 }, { header: 'Receipt file', key: 'file', width: 38 }];

  const agg = new Map();
  receipts.forEach((r, i) => {
    const R = r.result; const vh = lists.findVendor(R.vendor); const file = fileBase(r, i) + (r.mime.startsWith('text/') ? '.txt' : '.jpg');
    const flags = lists.checks(r).filter((c) => c[0] !== 'info').map((c) => c[1]).join(' | ');
    for (const l of lists.allocate(R)) {
      const proj = lists.isDirect(l.category) ? r.project : '';
      const extra = lists.r2(l.alloc - (l.amount || 0));
      lines.addRow({ n: i + 1, date: xlDate(R.date), vendor: vh ? vh.name : R.vendor, vstat: vh ? 'Existing' : 'New', cat: l.category, proj, desc: l.description + (extra ? ` (incl. ${lists.money(extra)} tax/fees)` : ''), amt: l.alloc, card: cardOf(R), file, flags });
      const k = l.category + '\u0000' + proj; const a = agg.get(k) || { cat: l.category, proj, amt: 0, ids: new Set() };
      a.amt = lists.r2(a.amt + l.alloc); a.ids.add(r.id); agg.set(k, a);
    }
    recs.addRow({ n: i + 1, date: xlDate(R.date), vendor: vh ? vh.name : R.vendor, merchant: R.merchant, purpose: lists.purpose(r.purpose)[1], total: R.total, src: r.source === 'email' ? 'Email' : 'Upload', file });
  });
  [...agg.values()].sort((a, b) => a.cat.localeCompare(b.cat)).forEach((a) => bycat.addRow({ cat: a.cat, proj: a.proj, cnt: a.ids.size, amt: a.amt }));
  const tot = (ws, col, label, labelCol) => { const n = ws.rowCount; const row = ws.addRow({}); row.getCell(labelCol).value = label; row.getCell(col).value = { formula: `SUM(${ws.getColumn(col).letter}2:${ws.getColumn(col).letter}${n})` }; row.font = { bold: true }; };
  tot(lines, 'amt', 'Total', 'desc'); tot(bycat, 'amt', 'Total', 'cat'); tot(recs, 'total', 'Total', 'purpose');
  [lines, bycat, recs].forEach(head);
  const info = wb.addWorksheet('About');
  info.columns = [{ width: 22 }, { width: 60 }];
  [['Employee', user.name || user.email || user.id], ['Email', user.email || ''], ['Period', `${meta.from} to ${meta.to}`], ['Submitted', meta.submittedAt || 'Not submitted (preview)'], ['Receipts', receipts.length], ['Total', lists.money(meta.total)]]
    .forEach((r) => info.addRow(r));
  return wb.xlsx.writeBuffer();
}

async function receiptJpeg(r) {
  const file = await storage.get(r.file_key);
  const prep = await image.prepare(file, { ...r.edits, enhance: false, boost: false });
  return sharp(prep.data).resize({ width: 1800, height: 6000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
}

async function combinedPdf(receipts, jpgs) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica); const mono = await pdf.embedFont(StandardFonts.Courier);
  const W = 612; const H = 792; const M = 36;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i]; const R = r.result;
    let page = pdf.addPage([W, H]);
    page.drawText(`Receipt ${i + 1}  ·  ${R.date || 'no date'}  ·  ${R.vendor || ''}  ·  ${lists.money(R.total)}`.replace(/[^\x20-\x7E·…]/g, ''), { x: M, y: H - M, size: 10, font, color: rgb(0.1, 0.1, 0.1) });
    page.drawLine({ start: { x: M, y: H - M - 6 }, end: { x: W - M, y: H - M - 6 }, thickness: 1.5, color: rgb(0.81, 0.22, 0.06) });
    if (jpgs[i]) {
      const img = await pdf.embedJpg(jpgs[i]);
      const maxW = W - 2 * M; const maxH = H - 2 * M - 20; const s = Math.min(maxW / img.width, maxH / img.height, 1.2);
      page.drawImage(img, { x: M + (maxW - img.width * s) / 2, y: H - M - 16 - img.height * s, width: img.width * s, height: img.height * s });
    } else {
      const text = (await storage.get(r.file_key)).toString('utf8').replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
      let y = H - M - 26;
      for (const raw of text.split(/\r?\n/)) {
        for (const line of (raw.match(/.{1,95}/g) || [''])) {
          if (y < M) { page = pdf.addPage([W, H]); y = H - M; }
          page.drawText(line, { x: M, y, size: 8, font: mono }); y -= 10;
        }
      }
    }
  }
  return Buffer.from(await pdf.save());
}

/** Stream the ZIP to an HTTP response. */
async function streamPackage(res, user, receipts, meta) {
  const who = slug(user.name || (user.email || '').split('@')[0] || 'employee');
  const base = `Receipts_${who}_${meta.from}_to_${meta.to}`;
  const jpgs = [];
  for (const r of receipts) jpgs.push(r.mime.startsWith('text/') ? null : await receiptJpeg(r));
  const [xlsx, pdf] = await Promise.all([workbook(user, receipts, meta), combinedPdf(receipts, jpgs)]);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.zip"`);
  const zip = new ZipArchive({ zlib: { level: 6 } });
  zip.on('error', (e) => { console.error('zip', e); res.destroy(e); });
  zip.pipe(res);
  zip.append(Buffer.from(xlsx), { name: `${base}.xlsx` });
  zip.append(pdf, { name: `${base}_all-receipts.pdf` });
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    if (jpgs[i]) zip.append(jpgs[i], { name: `receipts/${fileBase(r, i)}.jpg` });
    else zip.append(await storage.get(r.file_key), { name: `receipts/${fileBase(r, i)}.txt` });
  }
  await zip.finalize();
}

module.exports = { streamPackage, workbook };
