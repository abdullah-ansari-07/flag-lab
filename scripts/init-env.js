#!/usr/bin/env node
'use strict';
// Creates .env from .env.example with a freshly generated FLAG_PEPPER (never overwrites).
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const root = path.join(__dirname, '..');
const target = path.join(root, '.env');
if (fs.existsSync(target)) {
  console.log('.env already exists - leaving it untouched.');
  process.exit(0);
}
const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const pepper = crypto.randomBytes(32).toString('hex');
const adminToken = crypto.randomBytes(16).toString('hex');
const out = example
  .replace(/^FLAG_PEPPER=.*$/m, `FLAG_PEPPER=${pepper}`)
  .replace(/^ADMIN_TOKEN=.*$/m, `ADMIN_TOKEN=${adminToken}`);
fs.writeFileSync(target, out, { mode: 0o600 });
console.log('Created .env with a new random FLAG_PEPPER and ADMIN_TOKEN.');
