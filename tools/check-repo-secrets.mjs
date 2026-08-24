#!/usr/bin/env node
/**
 * Dependency-free credential scan for every tracked or publishable untracked
 * file. It reports only the kind and location of a hit, never the value.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BINARY = new Set(['.gif', '.ico', '.jpeg', '.jpg', '.png', '.webp', '.zip']);

export const SECRET_PATTERNS = Object.freeze([
  ['provider API token', /\b(?:alch_|proapi_)[A-Za-z0-9_-]{12,}/g],
  ['LPLens access code', /\bLPL(?:-[A-Z0-9]{4}){8}\b/g],
  ['private key block', /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ['OpenAI secret key', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['Stripe live secret', /\bsk_live_[A-Za-z0-9]{20,}\b/g],
]);

export function patternHits(text) {
  const hits = [];
  for (const [kind, source] of SECRET_PATTERNS) {
    const re = new RegExp(source.source, source.flags);
    let match;
    while ((match = re.exec(text))) {
      hits.push({ kind, index: match.index });
      if (match[0].length === 0) re.lastIndex++;
    }
  }
  return hits;
}

function envNeedles() {
  const path = resolve(ROOT, '.env');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return [];
    const at = trimmed.indexOf('=');
    if (at < 1) return [];
    const value = trimmed.slice(at + 1).trim().replace(/^['"]|['"]$/g, '');
    return value.length >= 12 ? [value] : [];
  });
}

function candidateFiles() {
  const result = spawnSync(
    'git', ['ls-files', '-co', '--exclude-standard', '-z'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(result.stderr || 'git ls-files failed');
  return result.stdout.split('\0').filter(Boolean).map((path) => resolve(ROOT, path));
}

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function scan() {
  const exact = envNeedles();
  const hits = [];
  let scanned = 0;
  for (const file of candidateFiles()) {
    if (BINARY.has(extname(file).toLowerCase())) continue;
    let body;
    try { body = readFileSync(file, 'utf8'); } catch { continue; }
    if (body.includes('\0')) continue;
    scanned++;
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    for (const needle of exact) {
      let at = body.indexOf(needle);
      while (at !== -1) {
        hits.push({ kind: 'exact local .env value', rel, line: lineAt(body, at) });
        at = body.indexOf(needle, at + needle.length);
      }
    }
    for (const hit of patternHits(body)) {
      hits.push({ kind: hit.kind, rel, line: lineAt(body, hit.index) });
    }
  }
  for (const hit of hits) {
    console.error(`secret scan: ${hit.kind} at ${hit.rel}:${hit.line}`);
  }
  if (hits.length) throw new Error(`${hits.length} possible credential leak(s)`);
  console.log(`secret scan: clean (${scanned} text file(s), ${exact.length} local secret needle(s))`);
}

function selfTest() {
  const samples = [
    'alch' + '_' + 'a'.repeat(24),
    'proapi' + '_' + 'b'.repeat(24),
    'LPL-' + Array.from({ length: 8 }, () => 'AB12').join('-'),
    'ghp' + '_' + 'c'.repeat(36),
    'AKIA' + 'D'.repeat(16),
    'AIza' + 'e'.repeat(35),
    'sk-' + 'f'.repeat(30),
    'xoxb-' + 'g'.repeat(30),
    'sk' + '_live_' + 'h'.repeat(24),
    '-----BEGIN ' + 'PRIVATE KEY-----',
  ];
  for (const sample of samples) {
    assert.ok(patternHits(sample).length > 0, `missed fixture with length ${sample.length}`);
  }
  assert.equal(patternHits('0x' + 'a'.repeat(64)).length, 0);
  console.log('secret scan: matcher self-test pass');
}

if (process.argv.includes('--self-test')) selfTest();
else scan();
