'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

let impl;

async function connect() {
  if (impl) return impl;
  if (config.databaseUrl.startsWith('pglite:')) {
    const { PGlite } = require('@electric-sql/pglite');
    const dir = config.databaseUrl.slice('pglite:'.length);
    if (dir && dir !== 'memory') fs.mkdirSync(path.dirname(path.resolve(dir)), { recursive: true });
    const parsers = { 1082: (v) => v, 1700: (v) => (v === null ? null : Number(v)) }; // date stays 'YYYY-MM-DD', numeric -> number
    const pg = new PGlite(dir === 'memory' ? undefined : dir, { parsers });
    await pg.waitReady;
    impl = { query: (text, params) => pg.query(text, params), exec: (sql) => pg.exec(sql), close: () => pg.close() };
  } else {
    const { Pool, types } = require('pg');
    types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric -> number
    types.setTypeParser(1082, (v) => v); // date stays 'YYYY-MM-DD'
    const ssl = /render\.com|sslmode=require/.test(config.databaseUrl) ? { rejectUnauthorized: false } : undefined;
    const pool = new Pool({ connectionString: config.databaseUrl, ssl, max: 10 });
    impl = { query: (text, params) => pool.query(text, params), exec: (sql) => pool.query(sql), close: () => pool.end() };
  }
  await impl.exec(SCHEMA);
  return impl;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            text PRIMARY KEY,               -- Clerk user id
  email         text,
  name          text,
  inbound_token text UNIQUE NOT NULL,           -- the +tag in their receipt email address
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL REFERENCES users(id),
  date_from     date NOT NULL,
  date_to       date NOT NULL,
  receipt_count integer NOT NULL,
  total         numeric(12,2) NOT NULL,
  status        text NOT NULL DEFAULT 'submitted',  -- submitted | withdrawn
  created_at    timestamptz NOT NULL DEFAULT now(),
  withdrawn_at  timestamptz
);
CREATE TABLE IF NOT EXISTS receipts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL REFERENCES users(id),
  source        text NOT NULL,                  -- upload | email
  original_name text NOT NULL,
  file_key      text NOT NULL,                  -- stored original (image, PDF page, or email text)
  mime          text NOT NULL,
  email_subject text,
  status        text NOT NULL DEFAULT 'queued', -- queued | reading | read | error | checked | submitted
  read_error    text,
  read_mode     text NOT NULL DEFAULT 'standard', -- standard | careful
  result        jsonb,
  purpose       text NOT NULL DEFAULT 'project',
  project       text NOT NULL DEFAULT '',
  edits         jsonb NOT NULL DEFAULT '{"rot":0,"crop":null,"trim":true,"enhance":true,"boost":false}'::jsonb,
  receipt_date  date,
  total         numeric(12,2),
  vendor        text,
  model         text,
  tokens        jsonb,
  cost_usd      numeric(10,4) NOT NULL DEFAULT 0,
  submission_id uuid REFERENCES submissions(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS retry_at timestamptz;
CREATE INDEX IF NOT EXISTS receipts_user_date ON receipts(user_id, receipt_date);
CREATE INDEX IF NOT EXISTS receipts_status ON receipts(status);
CREATE TABLE IF NOT EXISTS inbound_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text,
  sender      text,
  subject     text,
  outcome     text NOT NULL,
  receipt_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
`;

async function q(text, params) { const db = await connect(); return (await db.query(text, params)).rows; }
async function one(text, params) { return (await q(text, params))[0] || null; }

module.exports = { connect, q, one };
