// test/http-versions-config.test.js — which official versions a server offers (DESIGN §35.23, M1;
// server/http/config.js versionsFrom): the `versions` option, else SP_VERSIONS / SP_VERSION_DEFAULT /
// SP_MAX_VERSION_HOSTS. Only act2autochess by default; unknown ids and a default that is not enabled are warned about.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { versionsFrom } from '../server/http/config.js';

const ENV = ['SP_VERSIONS', 'SP_VERSION_DEFAULT', 'SP_MAX_VERSION_HOSTS'];

/** versionsFrom(opts) with exactly `env` of the three variables set; returns the result and the warnings. */
function run(opts = {}, env = {}) {
  const saved = new Map(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, env);
  const warnings = [];
  try {
    const out = versionsFrom(opts, { warn: (m) => warnings.push(m) });
    return { ...out, warnings };
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('nothing set: act2autochess alone, no hosts, no warning', () => {
  assert.deepEqual(run(), { enabled: ['act2autochess'], default: 'act2autochess', maxHosts: 0, warnings: [] });
});

test("SP_VERSIONS=all enables the four versions in registry order, one host each beyond the default", () => {
  const r = run({}, { SP_VERSIONS: 'all' });
  assert.deepEqual(r.enabled, ['act2autochess', 'act2autochess@V2_1', 'act1autochess', 'act1autochess@V1_1']);
  assert.equal(r.default, 'act2autochess');
  assert.equal(r.maxHosts, 3);
  assert.deepEqual(r.warnings, []);
});

test('a comma list keeps registry order; an unknown id is warned about and dropped', () => {
  const r = run({}, { SP_VERSIONS: ' act1autochess , nope@X, act2autochess ', SP_VERSION_DEFAULT: 'act1autochess' });
  assert.deepEqual(r.enabled, ['act2autochess', 'act1autochess']);
  assert.equal(r.default, 'act1autochess');
  assert.equal(r.maxHosts, 1);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /unknown version "nope@X"/);
});

test('nothing known left keeps act2autochess with a warning', () => {
  const r = run({}, { SP_VERSIONS: 'foo,bar' });
  assert.deepEqual(r.enabled, ['act2autochess']);
  assert.equal(r.default, 'act2autochess');
  assert.equal(r.warnings.length, 3);
  assert.match(r.warnings[2], /no known version enabled/);
});

test('a default that is not enabled is replaced by the first enabled one', () => {
  const r = run({}, { SP_VERSIONS: 'act1autochess@V1_1,act1autochess', SP_VERSION_DEFAULT: 'act2autochess' });
  assert.deepEqual(r.enabled, ['act1autochess', 'act1autochess@V1_1']);
  assert.equal(r.default, 'act1autochess');
  assert.equal(r.maxHosts, 2);
  assert.match(r.warnings[0], /default version "act2autochess" is not enabled, using act1autochess/);
});

test('the option wins over the environment', () => {
  const r = run({ versions: { enabled: ['act2autochess@V2_1'], default: 'act2autochess@V2_1', maxHosts: 4 } },
    { SP_VERSIONS: 'all', SP_VERSION_DEFAULT: 'act1autochess', SP_MAX_VERSION_HOSTS: '9' });
  assert.deepEqual(r, { enabled: ['act2autochess@V2_1'], default: 'act2autochess@V2_1', maxHosts: 4, warnings: [] });
  assert.deepEqual(run({ versions: { enabled: 'all' } }).enabled.length, 4);
});

test('SP_MAX_VERSION_HOSTS: junk keeps the default with a warning; 0 is raised to 1 while a version needs a host', () => {
  const junk = run({}, { SP_VERSIONS: 'all', SP_MAX_VERSION_HOSTS: 'many' });
  assert.equal(junk.maxHosts, 3);
  assert.match(junk.warnings[0], /SP_MAX_VERSION_HOSTS=many ignored/);
  const zero = run({}, { SP_VERSIONS: 'all', SP_MAX_VERSION_HOSTS: '0' });
  assert.equal(zero.maxHosts, 1);
  assert.match(zero.warnings[0], /raised to 1/);
  assert.equal(run({}, { SP_VERSIONS: 'all', SP_MAX_VERSION_HOSTS: '2' }).maxHosts, 2);
  assert.deepEqual(run({}, { SP_MAX_VERSION_HOSTS: '0' }).warnings, [], 'no non-default version, no host needed');
});
