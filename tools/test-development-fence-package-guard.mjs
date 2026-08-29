#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const fixture = mkdtempSync(join(tmpdir(), 'lplens-package-guard-'));
const packageSource = new URL('./package.mjs', import.meta.url);
const packageCopy = join(fixture, 'tools', 'package.mjs');
const chainsFile = join(fixture, 'extension', 'lib', 'chains.js');
const sentinel = join(fixture, 'build', 'sentinel.txt');

try {
  mkdirSync(dirname(packageCopy), { recursive: true });
  mkdirSync(dirname(chainsFile), { recursive: true });
  mkdirSync(dirname(sentinel), { recursive: true });
  copyFileSync(packageSource, packageCopy);
  writeFileSync(chainsFile,
    '// TESTING ONLY - STRIP THIS BLOCK BEFORE ANY DISTRIBUTION\n');
  writeFileSync(sentinel, 'existing build must survive\n');

  const result = spawnSync(process.execPath, [packageCopy, '--skip-live-probe'], {
    cwd: fixture,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0, 'packaging unexpectedly accepted a development key fence');
  assert.match(result.stderr, /TESTING ONLY fence is back in extension\/lib\/chains\.js/i,
    'packaging failure did not clearly identify the development key fence');
  assert.equal(existsSync(sentinel), true, 'guard ran after build output was removed');
  assert.equal(readFileSync(sentinel, 'utf8'), 'existing build must survive\n',
    'guard modified existing build output before aborting');
  console.log('development key fence package guard: blocked before touching build output');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
