#!/usr/bin/env node
import assert from 'node:assert/strict';
import { accessCodeTokens, providerTokens } from './package.mjs';

const alchemy = 'alch' + '_' + 'a'.repeat(24);
const blockscout = 'proapi' + '_' + 'b'.repeat(24);
assert.deepEqual(providerTokens(`https://example.invalid/${alchemy}`), [alchemy]);
assert.deepEqual(providerTokens(`apikey=${blockscout}`), [blockscout]);
assert.deepEqual(providerTokens('alch' + '_short proapi' + '_'), []);
assert.deepEqual(providerTokens(`malch_${'c'.repeat(24)}`), []);
const accessCode = 'LPL-' + Array.from({ length: 8 }, () => 'AB12').join('-');
assert.deepEqual(accessCodeTokens(`key=${accessCode}`), [accessCode]);
assert.deepEqual(accessCodeTokens('LPL-FAKE-0000'), []);
console.log('package guard: provider-prefix regression pass');
