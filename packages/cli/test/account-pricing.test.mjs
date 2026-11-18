// Account prices through the CLI. Signed in, an estimate and the generation after it read the caller's own prices from
// the API host with the login token (GET /v1/pricing-rules/{model}, price_scope "account"); so do `models pricing` (one
// model or a list, GET /v1/pricing-rules) and `models search`, while `models pricing` without a login reads the public
// default rules and sends no credential; a gateway without account prices quotes the public price as before;
// EVOLINK_MCP_ACCOUNT_PRICING=0 turns account prices off.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Api } from '../src/api.mjs';
import { Credentials } from '../src/auth.mjs';
import { Media } from '../src/media.mjs';
import { State } from '../src/state.mjs';
import { resetPricingRulesCacheForTests } from '../src/platform/core/src/services/pricing-rules-client.js';
import { fixture, MemoryVault } from './fixture.mjs';

const token = 'fixture-account-pricing-token';
const input = prompt => ({ model: 'fixture-image', input: { prompt } });
const submissions = f => (f.restCalls ?? []).filter(call => call.method === 'POST' && call.path.endsWith('/generations')).length;

test.beforeEach(() => { resetPricingRulesCacheForTests(); delete process.env.EVOLINK_MCP_ACCOUNT_PRICING; });

async function context(t, { signedIn = true } = {}) {
  const f = await fixture(); t.after(f.close); f.mcpUnavailable = true;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-account-pricing-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const state = new State(home);
  const client = new Api(new Credentials({ state, server: f.server, vault: new MemoryVault(), ...(signedIn ? { token } : {}) }));
  return { f, client, media: new Media({ client, state, server: f.server }) };
}

test('signed in, an estimate is at the account\'s own price, read from the API host with the login token', async t => {
  const { f, media } = await context(t);
  f.accountMultiplier = 0.75;
  const view = await media.estimate(input('account price'));
  assert.equal(view.pricing_scope, 'account');
  assert.equal(view.account_pricing, 'used');
  assert.equal(view.amounts.uc, '10200', 'the account pays 0.75 of the 13,600 UC default');
  assert.equal(view.pricing_quote.price_scope, 'account');
  assert.match(view.text ?? '', /Estimate at your account's rates\./);
  assert.deepEqual(f.accountReads.map(read => [read.model, read.authorization]), [['fixture-image', `Bearer ${token}`]]);
  assert.equal(submissions(f), 0);
});

test('models pricing and models search are at the account\'s own rates when signed in', async t => {
  const { f, client } = await context(t);
  f.accountMultiplier = 0.75;
  const own = await client.call('get_pricing_rules', { model: 'fixture-image', view: 'full' });
  assert.equal(own.meta.price_scope, 'account'); assert.equal(own.account_price, true); assert.equal(own.account_pricing, 'used');
  assert.equal(own.model.components[0].rate.uc, '10200');
  const list = await client.call('get_pricing_rules', { modality: 'image', view: 'summary' });
  assert.equal(list.meta.price_scope, 'account'); assert.equal(list.pricing_endpoint, '/v1/pricing-rules');
  assert.ok(list.models.length > 0 && list.models.every(model => model.modality === 'image'));
  assert.equal(list.models.find(model => model.model_id === 'fixture-image').components[0].rate.uc, '10200');
  const search = await client.call('search_models', { query: 'fixture', type: 'image' });
  assert.equal(search.starting_price_scope, 'account'); assert.equal(search.account_pricing, 'used');
  const accountCalls = f.restCalls.filter(call => call.path === '/v1/pricing-rules' || call.path.startsWith('/v1/pricing-rules/'));
  assert.ok(accountCalls.length >= 3 && accountCalls.every(call => call.headers.authorization === `Bearer ${token}`),
    'the login token goes to the API host for account prices');
  assert.ok(f.restCalls.filter(call => call.path.startsWith('/v1/catalog/')).every(call => call.headers.authorization === undefined),
    'never to the public catalog');
});

test('models pricing without a login reads the public default rules and sends no credential', async t => {
  const { f, client } = await context(t, { signedIn: false });
  f.accountMultiplier = 0.75;
  for (const query of [{ model: 'fixture-image', view: 'full' }, { view: 'summary' }]) {
    const rules = await client.call('get_pricing_rules', query);
    assert.equal(rules.meta.price_scope, 'public_default');
    assert.equal(rules.account_price, false); assert.equal('account_pricing' in rules, false);
  }
  const one = await client.call('get_pricing_rules', { model: 'fixture-image', view: 'full' });
  assert.equal(one.model.components[0].rate.uc, '13600');
  assert.equal((f.accountReads?.length ?? 0) + (f.accountListReads?.length ?? 0), 0, 'the account routes are never asked without a login');
  const reads = f.restCalls.filter(call => call.path.endsWith('/pricing-rules'));
  assert.ok(reads.length >= 1 && reads.every(call => call.headers.authorization === undefined), 'no credential on the public rules');
});

test('a generation is checked against the account\'s own price: unchanged it submits once, raised it is refused', async t => {
  const { f, media } = await context(t);
  f.accountMultiplier = 0.75;
  const first = await media.estimate(input('account generation'));
  const read = f.accountReads.length;
  await media.generate('image', first.quote_id, { confirmed: true });
  assert.ok(f.accountReads.length > read, 'the account\'s price is read again right before submitting');
  assert.equal(submissions(f), 1);

  const second = await media.estimate(input('account price rises'));
  f.accountMultiplier = 1.25;
  await assert.rejects(media.generate('image', second.quote_id, { confirmed: true }), { code: 'price_changed' });
  assert.equal(submissions(f), 1, 'nothing is submitted at a higher price than the one approved');
});

test('a gateway without account prices quotes the public price as before, and EVOLINK_MCP_ACCOUNT_PRICING=0 never asks', async t => {
  const { f, media } = await context(t);
  const view = await media.estimate(input('no account route'));
  assert.equal(view.pricing_scope, 'public_default');
  assert.equal(view.account_pricing, 'not_offered');
  assert.equal(view.amounts.uc, '13600');
  assert.match(view.text ?? '', /Public default estimate; account discounts are not included\./);
  assert.equal(f.accountReads.length, 1);

  resetPricingRulesCacheForTests();
  f.accountMultiplier = 0.75;
  process.env.EVOLINK_MCP_ACCOUNT_PRICING = '0';
  const off = await media.estimate(input('switched off'));
  assert.equal(off.pricing_scope, 'public_default');
  assert.equal('account_pricing' in off, false);
  assert.equal(off.amounts.uc, '13600');
  assert.equal(f.accountReads.length, 1, 'switched off, the account route is not asked');
});
