import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { VERSION } from '../../src/version.ts';

it('VERSION matches package.json', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(VERSION, pkg.version);
});

it('pins the TOON encoder exactly to the version Comis uses', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(pkg.dependencies['@toon-format/toon'], '4.4.0');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@toon-format/toon']);
});
