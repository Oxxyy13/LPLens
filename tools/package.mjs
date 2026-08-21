#!/usr/bin/env node
/**
 * Build a distributable tester zip that cannot leak Dan's API keys.
 *
 * Copies extension/ to build/lplens-<version>/, scans every copied file for
 * credentials, live-checks Blockscout history, then zips.
 *
 * As of 2026-08-20 there is nothing to strip: the TESTING ONLY fence was
 * deleted from lib/chains.js so the source could be published publicly, and
 * the build is now byte-identical to the repo. That is the point — anyone can
 * diff the Web Store package against GitHub. Credentials live only in the
 * options page (chrome.storage.local, inside the browser profile) and, for
 * Dan's own convenience, in the gitignored .env that feeds envSecrets() below.
 * A reappearing fence is now a build failure, not something to strip.
 *
 * Usage: node tools/package.mjs
 *        node tools/package.mjs --scan-only   (scan existing build/; used
 *                                              to prove the leak gate fires)
 *        node tools/package.mjs --skip-live-probe  (deterministic CI build;
 *                                                    local releases must not use it)
 */
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync,
  statSync, existsSync,
} from 'fs';
import { join, relative, resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const BUILD = join(ROOT, 'build');
const START_MARKER = 'TESTING ONLY - STRIP THIS BLOCK BEFORE ANY DISTRIBUTION';
const FENCE_RE = /^\s*\/\/\s*-{10,}\s*$/;

function abort(msg) {
  console.error('package: ABORT: ' + msg);
  process.exit(1);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * The fence must stay gone. Re-adding it would put a live credential back into
 * a public repo, so this aborts the build rather than quietly stripping it —
 * stripping is what let source and shipped artefact drift apart in the first
 * place.
 */
export function assertNoFence(srcText) {
  if (srcText.includes(START_MARKER)) {
    abort('TESTING ONLY fence is back in extension/lib/chains.js. The repo is '
      + 'public: put the key in the options page (Advanced), not in source.');
  }
}

function isHexAddressOrHash(token) {
  return /^[0-9A-Fa-f]+$/.test(token) && (token.length === 40 || token.length === 64);
}

/**
 * Every secret value in LPLens/.env, if that file exists.
 *
 * The extension does not read .env — it is a parking spot for credentials that
 * are stored before they are wired in (the Blockscout Pro backup key is the
 * first). Feeding them to the leak scan means a future integration is guarded
 * the moment the key is stored, not whenever someone remembers to add it here.
 * Absent .env is normal (it never syncs, so the Mac has none) and is not an
 * error — but an .env that exists and parses to nothing is, because that is
 * indistinguishable from a scan that silently covers nothing.
 */
export function envSecrets() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return [];
  const vals = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (v.length >= 12) vals.push(v);
  }
  if (!vals.length) abort('.env exists but yielded no secrets to scan for');
  console.log('package: .env contributes ' + vals.length + ' secret(s) to the leak scan');
  return vals;
}

/** Provider credentials use mixed case, so the uppercase shape rule misses them. */
export function providerTokens(line) {
  return line.match(/\b(?:alch_|proapi_)[A-Za-z0-9_-]{12,}/g) || [];
}

export function accessCodeTokens(line) {
  return line.match(/\bLPL(?:-[A-Z0-9]{4}){8}\b/g) || [];
}

/**
 * Scan every file under dir. Any leftover key aborts.
 * Returns the number of files scanned (so a zero-file scan is visible).
 */
export function scanForLeaks(dir) {
  const files = walk(dir);
  console.log('package: scanned ' + files.length + ' file(s) under ' + relative(ROOT, dir));
  if (files.length === 0) abort('scanned zero files — refusing to treat an empty tree as clean');

  const hits = [];
  // Identifier names stay as needles even though the fence is gone: if anyone
  // reintroduces it, this fires on the name before the value ever matters.
  const needles = [
    'DEV_ALCHEMY_KEY',
    'DEV_ETHERSCAN_KEY',
    ...envSecrets(),
  ];

  for (const file of files) {
    if (/\.(png|jpe?g|gif|webp|ico|zip)$/i.test(file)) continue;
    let text;
    try { text = readFileSync(file, 'utf8'); }
    catch { continue; }
    if (text.includes('\0')) continue; // binary; still counted in files.length
    const rel = relative(dir, file).replace(/\\/g, '/');
    const lines = text.split(/\n/);
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n];
      for (const needle of needles) {
        if (line.includes(needle)) {
          hits.push(`${rel}:${n + 1}: literal ${needle.slice(0, 12)}…`);
        }
      }
      // Prefixed provider tokens. These are mixed-case, so the ALL-CAPS
      // key-shape rule below never sees them — they need their own pattern.
      const tokens = providerTokens(line);
      for (const tok of tokens) {
        hits.push(`${rel}:${n + 1}: provider token ${tok.slice(0, 16)}…`);
      }
      for (const tok of accessCodeTokens(line)) {
        hits.push(`${rel}:${n + 1}: LPLens access code ${tok.slice(0, 12)}…`);
      }
      const re = /[A-Z0-9]{30,}/g;
      let m;
      while ((m = re.exec(line))) {
        if (isHexAddressOrHash(m[0])) continue;
        const before = line.slice(Math.max(0, m.index - 2), m.index);
        if (before.toLowerCase() === '0x' && isHexAddressOrHash(m[0])) continue;
        hits.push(`${rel}:${n + 1}: key-shaped ${m[0].slice(0, 16)}… (${m[0].length} chars)`);
      }
    }
  }

  if (hits.length) {
    for (const h of hits) console.error('package: LEAK ' + h);
    abort(hits.length + ' leak(s) in build output');
  }
  console.log('package: leak scan clean');
  return files.length;
}

function nodeCheckAll(dir) {
  const js = walk(dir).filter((f) => f.endsWith('.js'));
  for (const f of js) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) {
      abort('node --check failed for ' + relative(dir, f) + '\n' + (r.stderr || r.stdout));
    }
  }
  console.log('package: node --check passed on ' + js.length + ' .js file(s)');
}

async function proveKeylessChains(dest) {
  const url = pathToFileURL(join(dest, 'lib/chains.js')).href + '?t=' + Date.now();
  const { CHAINS } = await import(url);
  const want = ['ethereum', 'base', 'arbitrum', 'polygon', 'robinhood'];
  for (const k of want) {
    if (!CHAINS[k]) abort('stripped CHAINS missing ' + k);
    if (/alchemy/i.test(CHAINS[k].rpc || '')) abort(k + ' rpc still points at Alchemy');
    if (CHAINS[k].etherscanKey) abort(k + ' still carries etherscanKey');
  }
  if (Object.keys(CHAINS).length !== want.length) {
    abort('expected ' + want.length + ' chains, got ' + Object.keys(CHAINS).join(','));
  }
  console.log('package: CHAINS has ' + want.join(', ')
    + '; every rpc is a public endpoint, no etherscanKey');
  return CHAINS;
}

async function proveBlockscout(dest, CHAINS) {
  const url = pathToFileURL(join(dest, 'lib/logs.js')).href + '?t=' + Date.now();
  const { fetchPositionLogs } = await import(url);
  const eth = CHAINS.ethereum;
  const got = await fetchPositionLogs({
    nfpm: eth.nfpm,
    tokenId: 961877n,
    rpc: 'http://127.0.0.1:9',
    blockscout: eth.blockscout,
  });
  if (got.unavailable) abort('live history unavailable: ' + got.unavailable);
  if (got.source !== 'blockscout') abort('expected source=blockscout, got ' + got.source);
  if (!got.logs || got.logs.length !== 4) {
    abort('expected 4 events for ethereum 961877, got ' + (got.logs && got.logs.length));
  }
  console.log('package: live Blockscout ethereum 961877 -> source='
    + got.source + ' events=' + got.logs.length);
}

function zipExtension(dest, zipPath) {
  if (existsSync(zipPath)) rmSync(zipPath);
  if (process.platform !== 'win32') {
    console.error('package: no zip produced (not win32). Run:');
    console.error(`  Compress-Archive -Path '${dest}\\*' -DestinationPath '${zipPath}'`);
    return false;
  }
  const ps = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath '${dest}' -Force).FullName `
    + `-DestinationPath '${zipPath}' -Force`,
  ], { encoding: 'utf8' });
  if (ps.status !== 0 || !existsSync(zipPath)) {
    console.error(ps.stdout || '');
    console.error(ps.stderr || '');
    console.error('package: no zip produced. Run:');
    console.error(`  Compress-Archive -Path '${dest}\\*' -DestinationPath '${zipPath}'`);
    return false;
  }
  return true;
}

function listZip(zipPath) {
  const ps = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; `
    + `[IO.Compression.ZipFile]::OpenRead('${zipPath}').Entries `
    + `| ForEach-Object { $_.FullName }; `
    + `([IO.Compression.ZipFile]::OpenRead('${zipPath}')).Dispose()`,
  ], { encoding: 'utf8' });
  if (ps.status !== 0) abort('could not list zip: ' + (ps.stderr || ps.stdout));
  const entries = (ps.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  console.log('package: zip listing (' + entries.length + ' entries)');
  for (const e of entries) console.log('  ' + e);
  const banned = entries.filter((e) =>
    /(^|\/|\\)(tools|docs|build|\.git)(\/|\\|$)/i.test(e));
  if (banned.length) abort('zip contains non-extension paths: ' + banned.join(', '));
  if (!entries.some((e) => /manifest\.json$/i.test(e))) {
    abort('zip missing manifest.json');
  }
  return entries;
}

async function main() {
  const scanOnly = process.argv.includes('--scan-only');
  const skipLiveProbe = process.argv.includes('--skip-live-probe');
  assertNoFence(readFileSync(join(EXT, 'lib/chains.js'), 'utf8'));
  console.log('package: source chains.js carries no dev fence');

  if (scanOnly) {
    if (!existsSync(BUILD)) abort('--scan-only: build/ does not exist');
    scanForLeaks(BUILD);
    return;
  }

  const mf = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
  const version = mf.version;
  if (!version) abort('manifest.json has no version');
  const dest = join(BUILD, 'lplens-' + version);
  const zipPath = join(BUILD, 'lplens-' + version + '.zip');

  if (existsSync(BUILD)) rmSync(BUILD, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(EXT, dest, { recursive: true });
  console.log('package: copied extension/ -> ' + relative(ROOT, dest));

  scanForLeaks(dest);
  nodeCheckAll(dest);
  const CHAINS = await proveKeylessChains(dest);
  if (skipLiveProbe) {
    console.log('package: live public Blockscout probe skipped by explicit CI flag');
  } else {
    await proveBlockscout(dest, CHAINS);
  }

  const zipped = zipExtension(dest, zipPath);
  if (zipped) {
    const buf = readFileSync(zipPath);
    const sha = createHash('sha256').update(buf).digest('hex');
    console.log('package: zip ' + zipPath);
    console.log('package: zip size ' + buf.length + ' bytes');
    console.log('package: zip sha256 ' + sha);
    listZip(zipPath);
  }
}

const self = fileURLToPath(import.meta.url).toLowerCase();
const argv1 = resolve(process.argv[1] || '').toLowerCase();
if (self === argv1) {
  main().catch((err) => abort(err.stack || String(err)));
}
