// B24: when the account balance does not cover an estimate, the refusal says what the estimate needs, the balance, the
// gap (rounded up to 0.1 credit, so topping up that much is enough) and where to top up, as the workflow estimate does.
// Expected gaps are computed here in whole ten-thousandths of a credit, not by the code under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEstimate, balanceShortfall } from '../src/media.mjs';
import { formatCredits } from '../src/platform/core/src/services/error-handler.js';
import { fixture } from './fixture.mjs';

const TOP_UP = 'https://evolink.ai/dashboard/credits?utm_source=cli&utm_medium=mcp&utm_campaign=cli&utm_content=top_up';
const quote = (needed, balance, extra = {}) => ({ input_valid: true, enough_limit: true, enough_daily_limit: true,
  enough_balance: balance === undefined ? false : balance >= needed, ...(balance === undefined ? {} : { balance_credits: balance }),
  estimate: { status: 'estimated', min_usd: needed / 68, max_usd: needed / 68, min_credits: needed, max_credits: needed }, ...extra });
const refusal = q => { try { checkEstimate(q); } catch (error) { return error; } return undefined; };

/** mulberry32: the same seed gives the same cases on every run. */
function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

test('seed 20261118: a short balance names what the estimate needs, the balance, the gap rounded up and the top-up link', () => {
  const rand = rng(20261118);
  let short = 0, enough = 0;
  for (let n = 0; n < 400; n++) {
    const neededUnits = 100 + Math.floor(rand() * 20_000_000); // 0.01 to 2,000.00 credits, in ten-thousandths
    const needed = Math.round(neededUnits / 100) / 100;
    const balanceUnits = Math.floor(rand() * neededUnits * 1.5); // 0 to 1.5 times the estimate, four decimals
    const balance = balanceUnits / 10_000;
    const error = refusal(quote(needed, balance));
    if (balance >= needed) { assert.equal(error, undefined, JSON.stringify({ needed, balance })); enough++; continue; }
    const gapUnits = Math.round(needed * 10_000) - balanceUnits;
    const expected = Math.ceil(gapUnits / 1000) / 10;
    const label = JSON.stringify({ needed, balance, expected });
    assert.equal(error?.code, 'insufficient_balance', label);
    assert.equal(error.details.estimated_credits, needed, label);
    assert.equal(error.details.balance_credits, balance, label);
    assert.equal(error.details.short_by_credits, expected, label);
    assert.ok(error.details.short_by_credits * 10_000 >= gapUnits, `${label}: the gap is never understated`);
    assert.equal(error.details.top_up_url, TOP_UP, label);
    assert.ok(error.details.next_step.includes(TOP_UP), label);
    assert.ok(error.message.includes(`it needs about ${formatCredits(needed)} credits`), `${label} ${error.message}`);
    assert.ok(error.message.includes(`the balance is ${formatCredits(balance)} credits`), `${label} ${error.message}`);
    assert.ok(error.message.includes(`short by about ${formatCredits(expected)} credits`), `${label} ${error.message}`);
    short++;
  }
  assert.ok(short > 100 && enough > 50, `both sides of the boundary are covered (${short} short, ${enough} enough)`);
});

test('a range estimate is compared at its upper end, as the shared core decides that the balance is short', () => {
  const error = refusal({ input_valid: true, enough_balance: false, balance_credits: 20,
    estimate: { status: 'estimated', min_usd: 10 / 68, max_usd: 25 / 68, min_credits: 10, max_credits: 25 } });
  assert.equal(error.details.estimated_credits, 25);
  assert.equal(error.details.short_by_credits, 5);
  assert.equal(balanceShortfall({ estimate: { max_credits: 25 }, balance_credits: 24.95 }).short, 0.1);
});

test('without a balance figure the refusal still says what is needed and where to top up', () => {
  const error = refusal(quote(321.44, undefined));
  assert.equal(error.code, 'insufficient_balance');
  assert.equal(error.details.estimated_credits, 321.44);
  assert.equal(error.details.balance_credits, undefined);
  assert.equal(error.details.short_by_credits, undefined);
  assert.equal(error.details.top_up_url, TOP_UP);
  assert.match(error.message, /^The EvoLink account balance does not cover this estimate: it needs about 321\.44 credits/);
  const bare = refusal({ input_valid: true, enough_balance: false, estimate: { status: 'partial' } });
  assert.equal(bare.message, 'The EvoLink account balance does not cover this estimate.');
  assert.equal(bare.details.top_up_url, TOP_UP);
});

test('the command prints the figures and the link in its JSON error', async t => {
  const f = await fixture(); t.after(f.close);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-b24-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const bin = fileURLToPath(new URL('../bin/evolink.mjs', import.meta.url));
  const input = path.join(home, 'input.json');
  await fs.writeFile(input, JSON.stringify({ prompt: 'short balance', insufficient: true }));
  const token = 'fixture-command-token';
  const child = spawn(process.execPath, [bin, 'estimate', '--model', 'fixture-image', '--input-file', input, '--server', f.server.href, '--json', '--token-stdin'],
    { env: { ...process.env, EVOLINK_CLI_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(token);
  let stdout = '';
  child.stdout.on('data', b => { stdout += b; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.notEqual(code, 0);
  assert.ok(!stdout.includes(token));
  const view = JSON.parse(stdout);
  assert.equal(view.error.code, 'insufficient_balance');
  assert.equal(view.error.details.top_up_url, TOP_UP);
  assert.ok(view.error.details.next_step.includes(TOP_UP));
});
