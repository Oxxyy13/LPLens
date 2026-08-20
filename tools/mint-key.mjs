#!/usr/bin/env node
/**
 * Mint an LPLens beta access key.
 *
 * Prints the plaintext once (hand it to the tester; it is never written to
 * the repo) and the SHA-256 registry line to paste into
 * tools/licence-worker/worker.js KEYS.
 *
 * Usage: node tools/mint-key.mjs [label] [expires-YYYY-MM-DD]
 */
import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;
const bytes = new Uint8Array(16); // 128 bits
webcrypto.getRandomValues(bytes);
const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
const key = 'LPL-' + (hex.match(/.{4}/g) || []).join('-');

const digest = await subtle.digest('SHA-256', new TextEncoder().encode(key));
const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

const label = process.argv[2] || 'NAME';
const expires = process.argv[3] || 'YYYY-MM-DD';

process.stdout.write(
  'Give this to the tester (once; it is not saved):\n'
  + `  ${key}\n\n`
  + 'Paste this line into tools/licence-worker/worker.js KEYS:\n'
  + `  '${hash}': { label: '${label}', expires: '${expires}' },\n`,
);
