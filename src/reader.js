'use strict';
const config = require('./config');
const lists = require('./lists');

const PRICES = { // USD per million tokens: [input, output]
  'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.10, 0.50],
};
function costOf(model, u) {
  const [pi, po] = PRICES[model] || [2, 10];
  const inTok = (u.input_tokens || 0) + 1.25 * (u.cache_creation_input_tokens || 0) + 0.1 * (u.cache_read_input_tokens || 0);
  return (inTok * pi + (u.output_tokens || 0) * po) / 1e6;
}

let client = null;
function api() {
  if (!client) { const Anthropic = require('@anthropic-ai/sdk'); client = new (Anthropic.default || Anthropic)({ apiKey: config.anthropicApiKey }); }
  return client;
}

/* The fixed part of every read: instructions, expense types, rules, vendor list. Cached by the API so repeat reads pay ~10% for it. */
const SYSTEM = `You transcribe scanned or photographed receipts for Strinteg Corporation, an engineering firm, and sort each line into the firm's expense types. Accuracy of every digit matters more than speed.

How to read:
1. First find the receipt's printed TOTAL (amount actually paid), SUBTOTAL, TAX and any TIP. Then transcribe every purchased line with its extended amount.
2. Copy numbers exactly as printed. Do not round, do not compute a value you cannot see, and do not guess a digit. If a digit is ambiguous (3/8, 1/7, 5/6, 0/8 on faded thermal paper), use the receipt's own arithmetic (qty x price, items adding to subtotal, subtotal + tax = total) to decide, and set "uncertain": true on that line.
3. Discounts and coupons are negative line items. Tax, tip, fees and surcharges are their own line items. Together, all line items must add up to the TOTAL paid.
4. If something is unreadable, use null and name it in "illegible". Never invent a value.
5. Dates: return YYYY-MM-DD. US receipts print MM/DD/YY. Use the transaction date, not a printed "return by" date.
6. When several images are given, image 1 is a low-resolution overview for layout only; the rest are higher-resolution horizontal strips, top to bottom, each overlapping the next by about 12%. Read characters from the strips. A line at the bottom of one strip and the top of the next is the SAME line: record it once.

Expense types (use the exact name, character for character):
${lists.EXP.map((e) => `- ${e.name}${e.rare ? ' [rarely used]' : ''}${e.desc ? ' — ' + e.desc : ''}`).join('\n')}

${lists.RULES}

Vendor list (the firm's accounting vendors). If the merchant is one of these, set "vendor" to the exact name from this list. Otherwise set "vendor" to null and put a clean, short business name in "vendor_new_name" (brand name, no store number or city, e.g. "Marriott", "Shell", "Waffle House"):
${lists.VEN.map((v) => v.name + (v.type !== 'Vendor' ? ` (${v.type})` : '')).join('; ')}

Always answer by calling the record_receipt tool.`;

const n = { type: ['number', 'null'] };
const TOOL = {
  name: 'record_receipt',
  description: 'Record everything read from the receipt.',
  input_schema: {
    type: 'object',
    properties: {
      merchant: { type: 'string', description: 'Name as printed, with store number' },
      merchant_address: { type: ['string', 'null'] },
      vendor: { type: ['string', 'null'], description: 'Exact vendor-list name, or null' },
      vendor_new_name: { type: ['string', 'null'] },
      date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
      time: { type: ['string', 'null'] },
      receipt_type: { type: 'string', enum: ['restaurant', 'hotel', 'fuel', 'retail', 'airline', 'rental_car', 'parking', 'toll', 'rideshare', 'subscription', 'registration', 'shipping', 'other'] },
      payment_method: { type: ['string', 'null'] },
      card_last4: { type: ['string', 'null'] },
      subtotal: n, tax: n, tip: n, total: n,
      lines: { type: 'array', items: { type: 'object', properties: {
        description: { type: 'string' }, qty: n, unit_price: n, amount: n,
        kind: { type: 'string', enum: ['item', 'tax', 'tip', 'fee', 'discount', 'alcohol'] },
        category: { type: 'string', description: `Exact expense type name, or ${lists.SPREAD}` },
        confidence: { type: 'number', description: '0-1 confidence in the category' },
        reason: { type: 'string', description: 'One short phrase' },
        uncertain: { type: 'boolean', description: 'true if any digit of the amount was hard to read' },
      }, required: ['description', 'amount', 'kind', 'category', 'confidence'] } },
      read_quality: { type: 'string', enum: ['good', 'fair', 'poor'] },
      illegible: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string', description: 'Anything the filer should check, or empty' },
    },
    required: ['merchant', 'date', 'total', 'lines', 'read_quality'],
  },
};

function contextText(rec, plan, prior, emailText) {
  const p = lists.purpose(rec.purpose);
  let t = `Context from the person filing this receipt:
- Purpose: ${p[1]}. ${p[2]}
- Project number: ${rec.project || '(none given)'}
`;
  if (emailText) t += `\nThis receipt arrived as the text of an email (subject: "${rec.email_subject || ''}"). Read it from the text below.\n\n---\n${emailText.slice(0, 60000)}\n---\n`;
  else t += plan.single ? '\nOne image: the whole receipt.\n' : `\n${plan.tiles.length + 1} images: overview, then ${plan.tiles.length} overlapping strips top to bottom.\n`;
  if (prior) {
    t += `\nA FIRST READ produced the result below, and these checks failed:\n${prior.issues.map((i) => '- ' + i).join('\n') || '- (none flagged; the filer asked for a careful second read)'}\n\nFirst read:\n${JSON.stringify(prior.result)}\n\nRe-read from scratch, digit by digit, paying special attention to the failed checks. Do not trust the first read.`;
  }
  return t;
}

/* Send a request; if this model refuses a forced tool choice, ask again letting it choose the tool itself. */
async function create(params) {
  try { return await api().messages.create(params); } catch (e) {
    if (e?.status === 400 && /tool_choice|thinking/i.test(e.message || '')) {
      const p = { ...params, tool_choice: { type: 'auto' } };
      p.messages = params.messages.map((m) => ({ ...m }));
      return api().messages.create(p);
    }
    throw e;
  }
}
function toolInput(res, name) {
  const block = res.content.find((c) => c.type === 'tool_use' && (!name || c.name === name));
  if (block) return block.input;
  const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) { /* fall through */ } }
  const err = new Error(`Claude answered without a structured result (stop_reason: ${res.stop_reason})`); err.status = 'no_tool'; throw err;
}

/** Tiny request to confirm the key and model work. */
async function diag() {
  if (config.reader === 'mock') return { ok: false, error: 'No ANTHROPIC_API_KEY is set, so reads use a canned example.' };
  try {
    const res = await api().messages.create({ model: config.modelStandard, max_tokens: 10, messages: [{ role: 'user', content: 'Reply with the word OK.' }] });
    return { ok: true, model: res.model, reply: res.content.map((c) => c.text || '').join('').trim() };
  } catch (e) { return { ok: false, status: e.status || null, error: (e.error?.error?.message || e.message || String(e)).slice(0, 400) }; }
}

async function read({ rec, images, plan, emailText, careful }) {
  const model = careful ? config.modelCareful : config.modelStandard;
  const prior = careful && rec.result ? { result: rec.result, issues: lists.checks(rec).filter((c) => c[0] !== 'info').map((c) => c[1]) } : null;
  if (config.reader === 'mock') return mockRead(rec, model);
  const content = [];
  for (const b of images || []) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b } });
  content.push({ type: 'text', text: contextText(rec, plan || { single: true, tiles: [] }, prior, emailText) });
  const res = await create({
    model, max_tokens: 8000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: [TOOL], tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content }],
  });
  return { raw: toolInput(res, TOOL.name), model, usage: res.usage, cost: costOf(model, res.usage) };
}

/** Text-only re-sort of expense types after the purpose changes (fast, cheap model). */
async function resort(rec) {
  const p = lists.purpose(rec.purpose);
  const lines = rec.result.lines.map((l, i) => `${i}. ${l.description} | ${l.kind} | ${l.amount}`).join('\n');
  if (config.reader === 'mock') return { cats: rec.result.lines.map((l) => ({ category: l.category, confidence: l.confidence, reason: l.reason })), cost: 0, model: 'mock' };
  const model = config.modelQuick;
  const res = await create({
    model, max_tokens: 3000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'record_categories', description: 'One entry per line, same order.', input_schema: { type: 'object', properties: { lines: { type: 'array', items: { type: 'object', properties: { category: { type: 'string' }, confidence: { type: 'number' }, reason: { type: 'string' } }, required: ['category', 'confidence'] } } }, required: ['lines'] } }],
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: `Call the record_categories tool to re-assign the expense type of each line of this already-transcribed receipt.\nPurpose: ${p[1]}. ${p[2]}\nProject number: ${rec.project || '(none)'}\nMerchant: ${rec.result.merchant} (${rec.result.receipt_type})\n\nLines:\n${lines}` }],
  });
  return { cats: toolInput(res, 'record_categories')?.lines || [], cost: costOf(model, res.usage), model };
}

function mockRead(rec, model) {
  const raw = { merchant: 'THE HOME DEPOT #3612', merchant_address: 'Cary, NC', vendor: 'Home Depot', date: new Date(Date.now() - 864e5).toISOString().slice(0, 10), time: '10:42', receipt_type: 'retail', payment_method: 'Visa', card_last4: '0000', subtotal: 93.81, tax: 6.80, tip: null, total: 100.61, read_quality: 'good', illegible: [], notes: 'Mock read (no API key set).',
    lines: [
      { description: 'FLAGGING TAPE ORNG 3PK', amount: 17.94, kind: 'item', category: 'Field Supplies (Direct)', confidence: 0.92, reason: 'Project consumable' },
      { description: 'MARKING PAINT FLUOR ORNG', amount: 25.92, kind: 'item', category: 'Field Supplies (Direct)', confidence: 0.92, reason: 'Project consumable' },
      { description: 'TAPE MEASURE 100FT', amount: 34.97, kind: 'item', category: 'Field Supplies (Direct)', confidence: 0.6, reason: 'Reusable tool; 3062 if not for this project' },
      { description: 'SANDISK USB 64GB', amount: 14.98, kind: 'item', category: '3022 Supplies - Computer', confidence: 0.88, reason: 'Computer supply' },
      { description: 'SALES TAX 7.25%', amount: 6.80, kind: 'tax', category: 'SPREAD', confidence: 1, reason: 'Items in two expense types' }] };
  return { raw, model: 'mock', usage: { input_tokens: 0, output_tokens: 0 }, cost: 0 };
}

module.exports = { read, resort, diag, costOf, SYSTEM };
