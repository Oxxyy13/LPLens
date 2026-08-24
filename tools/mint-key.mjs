#!/usr/bin/env node
/**
 * Mint an LPLens beta access key.
 *
 * Prints the plaintext once (hand it to the tester; it is never written to
 * the repo) and the SHA-256 registry line to paste into
 * tools/licence-worker/worker.js KEYS.
 *
 * Usage: node tools/mint-key.mjs [label] [expires-YYYY-MM-DD]
 *        node tools/mint-key.mjs [label] [expires-YYYY-MM-DD] --save-env NAME
 *
 * --save-env writes the plaintext to the gitignored project .env instead of
 * printing it. This is intended for durable service credentials such as the
 * Chrome Web Store reviewer key; an existing variable is never overwritten.
 */
import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const subtle = webcrypto.subtle;
const bytes = new Uint8Array(16); // 128 bits
webcrypto.getRandomValues(bytes);
const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
const key = 'LPL-' + (hex.match(/.{4}/g) || []).join('-');

const digest = await subtle.digest('SHA-256', new TextEncoder().encode(key));
const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

const label = process.argv[2] || 'NAME';
const expires = process.argv[3] || 'YYYY-MM-DD';
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(label)) {
  throw new Error('label must use only letters, numbers, dot, underscore or hyphen');
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)
    || new Date(`${expires}T00:00:00Z`).toISOString().slice(0, 10) !== expires) {
  throw new Error('expiry must be a real YYYY-MM-DD calendar date');
}

const saveAt = process.argv.indexOf('--save-env');
if (saveAt !== -1) {
  const name = process.argv[saveAt + 1] || '';
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(name)) {
    throw new Error('--save-env requires an uppercase environment variable name');
  }
  const envUrl = new URL('../.env', import.meta.url);
  const old = existsSync(envUrl) ? readFileSync(envUrl, 'utf8') : '';
  if (new RegExp(`^${name}=`, 'm').test(old)) {
    throw new Error(`${name} already exists in .env; refusing to overwrite it`);
  }
  const separator = !old || old.endsWith('\n') ? '' : '\n';
  writeFileSync(envUrl, old + separator + `${name}=${key}\n`, { mode: 0o600 });
  process.stdout.write(
    `Plaintext saved only to the gitignored .env as ${name}.\n\n`
    + 'Paste this line into tools/licence-worker/worker.js KEYS:\n'
    + `  '${hash}': { label: '${label}', expires: '${expires}' },\n`,
  );
  process.exit(0);
}

process.stdout.write(
  'Give this to the tester (once; it is not saved):\n'
  + `  ${key}\n\n`
  + 'Paste this line into tools/licence-worker/worker.js KEYS:\n'
  + `  '${hash}': { label: '${label}', expires: '${expires}' },\n`,
);
