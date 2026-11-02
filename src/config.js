'use strict';
const path = require('path');

const env = process.env;

module.exports = {
  port: Number(env.PORT || 3000),
  // Postgres connection string. "pglite:./.data/db" runs an embedded Postgres for local development and tests.
  databaseUrl: env.DATABASE_URL || 'pglite:./.data/db',
  // Where receipt files live. On Render this is the mounted persistent disk.
  storageDir: path.resolve(env.STORAGE_DIR || './.data/files'),

  clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY || '',
  clerkSecretKey: env.CLERK_SECRET_KEY || '',

  anthropicApiKey: env.ANTHROPIC_API_KEY || '',
  // "claude" calls the API; "mock" returns a canned read (local testing without a key).
  reader: env.READER || (env.ANTHROPIC_API_KEY ? 'claude' : 'mock'),
  modelStandard: env.MODEL_STANDARD || 'claude-sonnet-5-5',
  modelCareful: env.MODEL_CAREFUL || 'claude-opus-5-5',
  modelQuick: env.MODEL_QUICK || 'claude-haiku-5-5',
  readConcurrency: Number(env.READ_CONCURRENCY || 2),

  // Postmark inbound: the server address Postmark gives you, e.g. 1a2b3c@inbound.postmarkapp.com
  inboundAddress: env.INBOUND_ADDRESS || '3d6786afd526563d6f6a76b263bef72a@inbound.postmarkapp.com',
  // Shared secret Postmark sends as basic-auth on the webhook URL.
  inboundWebhookUser: env.INBOUND_WEBHOOK_USER || 'postmark',
  inboundWebhookPassword: env.INBOUND_WEBHOOK_PASSWORD || '',

  appUrl: (env.APP_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/$/, ''),
  maxUploadMb: Number(env.MAX_UPLOAD_MB || 25),
};
