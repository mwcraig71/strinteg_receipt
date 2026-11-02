'use strict';
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');
const full = (key) => {
  const p = path.resolve(config.storageDir, key);
  if (!p.startsWith(config.storageDir + path.sep)) throw new Error('bad storage key');
  return p;
};

async function put(userId, buffer, ext) {
  const key = `${safe(userId)}/${crypto.randomUUID()}.${safe(ext || 'bin')}`;
  const p = full(key);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, buffer);
  return key;
}
const get = (key) => fs.readFile(full(key));
const remove = (key) => fs.rm(full(key), { force: true });

module.exports = { put, get, remove };
