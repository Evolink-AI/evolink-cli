import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { fixture } from './fixture.mjs';
import { commandHelp } from '../src/help.mjs';
import { WORKFLOW_COMMANDS, Workflows } from '../src/workflow.mjs';
import { CliError } from '../src/errors.mjs';
import { installSkill } from '../src/skills.mjs';

const bin = fileURLToPath(new URL('../bin/evolink.mjs', import.meta.url));
const TOKEN = 'fixture-workflow-token';
const RUN = `wfr-${'0'.repeat(20)}-${'a'.repeat(10)}`;
/** Longer than the 2,000 characters an error message keeps, with a link an error message would hide. */
const LONG = `# Rules\n\nSee https://files.example.com/reference/frame-001.png for the frame.\n${'| 0.0-0.5 | faces camera | right hand lifts the bottle | closed -> open |\n'.repeat(60)}end of text`;

async function run(server, home, args, { json = true, token = TOKEN } = {}) {
  const child = spawn(process.execPath, [bin, ...args, '--server', server, ...(json ? ['--json'] : []), '--token-stdin'],
    { env: { ...process.env, EVOLINK_CLI_HOME: home, EVOLINK_CLI_UPDATE_CHECK: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(token);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.ok(!stdout.includes(token) && !stderr.includes(token), 'the login token is never printed');
  return { code, stdout, stderr, view: json ? JSON.parse(stdout) : undefined };
}

/** A loopback address nothing listens on: a port that was just free. */
async function nowhere() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return `http://127.0.0.1:${port}/mcp`;
}

async function context(t) {
  const f = await fixture();
  t.after(f.close);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-workflow-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  f.mcpHeaders = [];
  f.responses = {};
  const cli = (args, options) => run(f.server.href, home, args, options);
  const calls = name => f.calls.filter(call => call.name === name);
  return { f, home, cli, calls };
}

/**
 * The workflow client on canned answers, with no process and no socket: for the many shapes one answer can take.
 * The commands themselves are tested through the real CLI process above each such list.
 */
function direct(answer) {
  const requests = [];
  const credentials = { server: new URL('https://mcp.evolink.ai/mcp'), access: async () => ({ access_token: TOKEN }) };
  const fetchFn = async (url, init) => {
    const message = JSON.parse(init.body);
    requests.push({ url: String(url), name: message.params.name, args: message.params.arguments });
    const reply = await answer(message.params.name);
    return reply instanceof Response ? reply : Response.json({ jsonrpc: '2.0', id: message.id, ...reply });
  };
  return { workflows: new Workflows(credentials, { fetchFn }), requests };
}
/** A tool that ran and failed; the text-only error result of the MCP SDK; a JSON-RPC error. */
const failed = (error, more = {}) => ({ result: { isError: true, structuredContent: { ok: false, error, ...more }, content: [{ type: 'text', text: error.message ?? '' }] } });
const textOnly = text => ({ result: { isError: true, content: [{ type: 'text', text }] } });
const rpcError = (code, message) => ({ error: { code, message } });
async function failure(action) {
  try { await action(); } catch (error) { assert.ok(error instanceof CliError, String(error?.stack ?? error)); return error; }
  return assert.fail('the call was expected to fail');
}
const LINK = 'https://files.evolink.ai/u/reference.mp4';
const ANALYSIS = `va-${'1'.repeat(32)}`;
/** One call of each tool, as the commands make it. */
const CALLS = {
  get_media_workflow: workflows => workflows.rules('ad-rebuild'),
  analyze_video: workflows => workflows.analyze(LINK, { run: RUN, step: 'reference_analysis', purpose: 'breakdown' }),
  get_video_analysis: workflows => workflows.analysis(ANALYSIS),
};

test('workflow rules: one tools/call with the login token; the rules come back whole, with the CLI command for each tool', async t => {
  const { f, cli, calls } = await context(t);
  f.responses.get_media_workflow = args => ({ workflow: args.workflow, workflow_version: '1.0.0', run_id: args.run_id ?? RUN, section: args.section ?? 'overview',
    content: LONG, sections: [{ id: 'overview', kind: 'stage' }, { id: 'plan', kind: 'stage', step: 3 }], _text: `EvoLink workflow "ad-rebuild". Run ID: ${RUN}.\n\n${LONG}` });

  const first = await cli(['workflow', 'rules', 'ad-rebuild']);
  assert.equal(first.code, 0, first.stdout);
  assert.deepEqual(calls('get_media_workflow')[0].args, { workflow: 'ad-rebuild' }, 'nothing is sent that was not asked for');
  assert.equal(first.view.ok, true);
  assert.equal(first.view.run_id, RUN);
  assert.equal(first.view.content, LONG, 'the rules are not shortened and their links are kept');
  assert.ok(first.view.text.endsWith(LONG) && first.view.text.includes(`Run ID: ${RUN}`));
  assert.ok(first.view.text.startsWith('In this CLI the tools named in the rules are these commands:'));
  assert.deepEqual(first.view.cli_commands, WORKFLOW_COMMANDS);
  assert.ok(!Object.keys(first.view).some(key => key.startsWith('_')));
  assert.equal(f.mcpHeaders.length, 1, 'one request, with no initialize or tools/list around it');
  const headers = f.mcpHeaders[0];
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
  assert.match(headers['user-agent'], /^EvoLinkCLI\//);
  assert.match(headers.accept, /application\/json/);
  assert.equal(headers['content-type'], 'application/json');

  const later = await cli(['workflow', 'rules', 'ad-rebuild', '--section', 'plan', '--run', RUN]);
  assert.deepEqual(calls('get_media_workflow')[1].args, { workflow: 'ad-rebuild', section: 'plan', run_id: RUN });
  assert.equal(later.view.section, 'plan');

  const plain = await cli(['workflow', 'rules', 'ad-rebuild'], { json: false });
  assert.equal(plain.code, 0);
  assert.ok(plain.stdout.includes('analyze_video: evolink video analyze') && plain.stdout.includes('end of text'), 'without --json the rules are printed as text');
});

test('workflow estimate: the planned output goes to the service; nothing is sent when it is incomplete or malformed', async t => {
  const { f, cli, calls } = await context(t);
  f.responses.get_media_workflow = args => ({ workflow: args.workflow, run_id: args.run_id ?? RUN, estimate: { total_credits: 355.2, total_usd: 5.22, charged: 'no' },
    _text: 'Estimated total: about $5.22 (355.2 credits). Nothing has been charged.' });

  const full = await cli(['workflow', 'estimate', 'ad-rebuild', '--run', RUN, '--seconds', '15', '--keyframes', '6', '--quality', '720p', '--aspect-ratio', '9:16', '--creator-images', '1']);
  assert.equal(full.code, 0, full.stdout);
  assert.deepEqual(calls('get_media_workflow')[0].args, { workflow: 'ad-rebuild', run_id: RUN,
    estimate: { output_seconds: 15, keyframes: 6, quality: '720p', aspect_ratio: '9:16', creator_images: 1 } });
  assert.equal(full.view.estimate.total_credits, 355.2);
  assert.match(full.view.text, /^Estimated total: about \$5\.22/);

  const short = await cli(['workflow', 'estimate', 'ad-rebuild', '--seconds', '8', '--keyframes', '4']);
  assert.deepEqual(calls('get_media_workflow')[1].args, { workflow: 'ad-rebuild', estimate: { output_seconds: 8, keyframes: 4 } });
  assert.equal(short.code, 0);

  // Every resolution the workflow estimate takes, 4k included, goes to the service as given.
  for (const [index, quality] of ['480p', '1080p', '4k'].entries()) {
    const each = await cli(['workflow', 'estimate', 'ad-rebuild', '--seconds', '10', '--keyframes', '5', '--quality', quality]);
    assert.equal(each.code, 0, `${quality}: ${each.stdout}`);
    assert.deepEqual(calls('get_media_workflow')[2 + index].args, { workflow: 'ad-rebuild', estimate: { output_seconds: 10, keyframes: 5, quality } });
  }

  const before = f.mcpHeaders.length;
  for (const [args, code] of [
    [['--keyframes', '6'], 'missing_option'], [['--seconds', '15'], 'missing_option'],
    [['--seconds', '15.5', '--keyframes', '6'], 'invalid_option'], [['--seconds', '0', '--keyframes', '6'], 'invalid_option'],
    [['--seconds', '15', '--keyframes', '101'], 'invalid_option'], [['--seconds', '15', '--keyframes', '6', '--quality', '2160p'], 'invalid_option'],
    [['--seconds', '15', '--keyframes', '6', '--quality', '4K'], 'invalid_option'], [['--seconds', '15', '--keyframes', '6', '--quality', '8k'], 'invalid_option'],
    [['--seconds', '15', '--keyframes', '6', '--aspect-ratio', '2:1'], 'invalid_option'], [['--seconds', '15', '--keyframes', '6', '--creator-images', '-1'], 'invalid_option'],
    [['--seconds', '15', '--keyframes', '6', '--purpose', 'sound'], 'invalid_option'],
  ]) {
    const refused = await cli(['workflow', 'estimate', 'ad-rebuild', ...args]);
    assert.equal(refused.code, 1, args.join(' '));
    assert.equal(refused.view.error.code, code, args.join(' '));
  }
  assert.equal(f.mcpHeaders.length, before, 'a refused command sends nothing');
});

test('video analyze: the read is passed on as asked, and its analysis comes back whole', async t => {
  const { f, home, cli, calls } = await context(t);
  const analysis = `### Task 1\n\n${LONG}`;
  f.responses.analyze_video = args => ({ status: 'completed', complete: true, analysis_id: `va-${'1'.repeat(32)}`, run_id: args.run_id, step: args.step, purpose: args.purpose,
    analysis, charged: 'yes', estimated_credits: 0.49, _text: `Video analysis (${args.purpose}) for step ${args.step}: complete.\n\n${analysis}` });
  const link = 'https://files.evolink.ai/u/reference.mp4';

  const read = await cli(['video', 'analyze', link, '--run', RUN, '--step', 'reference_analysis', '--purpose', 'breakdown']);
  assert.equal(read.code, 0, read.stdout);
  assert.deepEqual(calls('analyze_video')[0].args, { run_id: RUN, step: 'reference_analysis', purpose: 'breakdown', video_url: link });
  assert.equal(read.view.analysis, analysis);
  assert.ok(read.view.text.endsWith(analysis));
  assert.equal(read.view.charged, 'yes');

  const target = path.join(home, 'target.md');
  await fs.writeFile(target, '# Target\n\nShot 1 (0-3 s): creator holds the product in the right hand.\n');
  await cli(['video', 'analyze', link, '--run', RUN, '--step', 'delivery_check', '--purpose', 'compare', '--target-file', target, '--attempt', '2']);
  assert.deepEqual(calls('analyze_video')[1].args, { run_id: RUN, step: 'delivery_check', purpose: 'compare', video_url: link,
    target: '# Target\n\nShot 1 (0-3 s): creator holds the product in the right hand.\n', attempt: 2 });

  const before = f.mcpHeaders.length;
  const empty = path.join(home, 'empty.md');
  await fs.writeFile(empty, '  \n');
  const huge = path.join(home, 'huge.md');
  await fs.writeFile(huge, 'x'.repeat(1_000_001));
  for (const [args, code] of [
    [['--step', 'reference_analysis', '--purpose', 'breakdown'], 'missing_option'],
    [['--run', RUN, '--purpose', 'breakdown'], 'missing_option'],
    [['--run', RUN, '--step', 'reference_analysis'], 'missing_option'],
    [['--run', RUN, '--step', 'reference_analysis', '--purpose', 'breakdown', '--attempt', '4'], 'invalid_option'],
    [['--run', RUN, '--step', 'delivery_check', '--purpose', 'compare', '--target-file', path.join(home, 'missing.md')], 'file_not_found'],
    [['--run', RUN, '--step', 'delivery_check', '--purpose', 'compare', '--target-file', empty], 'invalid_input'],
    [['--run', RUN, '--step', 'delivery_check', '--purpose', 'compare', '--target-file', huge], 'invalid_input'],
    [['--run', RUN, '--step', 'delivery_check', '--purpose', 'compare', '--target-file', home], 'invalid_file'],
    [['--run', RUN, '--step', 'reference_analysis', '--purpose', 'breakdown', '--seconds', '5'], 'invalid_option'],
  ]) {
    const refused = await cli(['video', 'analyze', link, ...args]);
    assert.equal(refused.code, 1, args.join(' '));
    assert.equal(refused.view.error.code, code, args.join(' '));
  }
  assert.equal(f.mcpHeaders.length, before, 'a refused command sends nothing, so nothing can be charged');

  f.responses.get_video_analysis = args => ({ status: 'processing', analysis_id: args.analysis_id, charged: 'unknown' });
  const pending = await cli(['video', 'analysis', `va-${'1'.repeat(32)}`]);
  assert.deepEqual(calls('get_video_analysis')[0].args, { analysis_id: `va-${'1'.repeat(32)}` });
  assert.deepEqual([pending.code, pending.view.status], [0, 'processing']);
});

test('a failed read exits non-zero with the service\'s code and next step; a cut-off read keeps what was read', async t => {
  const { f, cli } = await context(t);
  const read = () => cli(['video', 'analyze', LINK, '--run', RUN, '--step', 'reference_analysis', '--purpose', 'breakdown']);

  f.responses.analyze_video = () => ({ error: { category: 'invalid_request', code: 'video_too_long', message: 'The video is 42.3 seconds long; this workflow reads videos of 30 seconds or less.',
    next_step: 'Cut a segment of 30 seconds or less, upload it and pass the new link.', retryable: false, retry: 'after_fix' }, status: 'failed', charged: 'no', run_id: RUN });
  const long = await read();
  assert.equal(long.code, 1);
  assert.equal(long.view.ok, false);
  assert.equal(long.view.error.code, 'video_too_long', 'for a broad category the code names the cause');
  assert.match(long.view.error.message, /42\.3 seconds long/);
  assert.equal(long.view.error.details.charged, 'no');
  assert.equal(long.view.error.details.error.next_step, 'Cut a segment of 30 seconds or less, upload it and pass the new link.');

  // The service passes on the gateway's own answer: its category names the cause, its code is the gateway's raw one.
  f.responses.analyze_video = () => ({ error: { status: 402, category: 'account_balance_insufficient', code: 'insufficient_quota',
    headline: 'Your EvoLink account balance is too low for this request.', message: 'Your EvoLink account balance is too low for this request.',
    next_step: 'Ask the user to top up at https://evolink.ai/dashboard/credits?utm_source=cli&utm_medium=mcp&utm_campaign=cli&utm_content=top_up, then retry.',
    retryable: false, retry: 'after_fix' }, status: 'failed', charged: 'no' });
  const broke = await read();
  assert.equal(broke.code, 1);
  assert.equal(broke.view.error.code, 'account_balance_insufficient', 'the account category is the code, as in every other command');
  assert.match(broke.view.error.details.error.next_step, /top up at https:\/\/evolink\.ai\/dashboard\/credits\?utm_source=cli/, 'the top-up link is kept');

  for (const [error, code] of [
    [{ category: 'account_balance_insufficient', code: 'insufficient_quota' }, 'account_balance_insufficient'],
    [{ category: 'mcp_daily_limit_reached', code: 'token_daily_quota_exceeded' }, 'mcp_daily_limit_reached'],
    [{ category: 'mcp_limit_reached', code: 'token_quota_exhausted' }, 'mcp_limit_reached'],
    [{ category: 'connection_ended', code: 'invalid_api_key' }, 'connection_ended'],
    [{ category: 'unauthorized' }, 'unauthorized'],
    [{ category: 'content_policy', code: 'content_policy' }, 'content_policy'],
    [{ category: 'rate_limited', code: 'rate_limited' }, 'rate_limited'],
    [{ category: 'model_unavailable', code: 'model_unavailable' }, 'model_unavailable'],
    [{ category: 'service_unavailable', code: 'service_unavailable' }, 'service_unavailable'],
    [{ category: 'estimate_unavailable', code: 'estimate_unavailable' }, 'estimate_unavailable'],
    [{ category: 'invalid_request', code: 'video_too_long' }, 'video_too_long'],
    [{ category: 'invalid_request', code: 'source_not_accessible' }, 'source_not_accessible'],
    [{ category: 'invalid_request', code: 'invalid_request' }, 'invalid_request'],
    [{ category: 'invalid_request' }, 'invalid_request'],
    [{ category: 'server_error', code: 'analysis_timeout' }, 'analysis_timeout'],
    [{ category: 'server_error', code: 'analysis_pending' }, 'analysis_pending'],
    [{ category: 'not_found', code: 'workflow_version_retired' }, 'workflow_version_retired'],
    [{ category: 'not_found', code: 'analysis_not_found' }, 'analysis_not_found'],
    [{ category: 'analysis_incomplete', code: 'analysis_empty' }, 'analysis_empty'],
    [{ code: 'video_too_large' }, 'video_too_large'],
    [{}, 'workflow_failed'],
  ]) {
    for (const call of Object.values(CALLS)) {
      const thrown = await failure(() => call(direct(() => failed({ ...error, message: 'The read did not finish.', next_step: 'See the code.' }, { charged: 'no' })).workflows));
      assert.deepEqual([thrown.code, thrown.message, thrown.details.charged, thrown.details.error.next_step], [code, 'The read did not finish.', 'no', 'See the code.'], JSON.stringify(error));
    }
  }
  // A result that is not marked as a success is not passed on as one.
  for (const result of [{ structuredContent: { workflow: 'ad-rebuild' }, content: [] }, { structuredContent: { ok: 'yes' }, content: [] }]) {
    assert.equal((await failure(() => CALLS.get_media_workflow(direct(() => ({ result })).workflows))).code, 'unsupported_response');
    assert.match((await failure(() => CALLS.analyze_video(direct(() => ({ result })).workflows))).message, /Repeat exactly the same command: a read that had started is collected without a second charge\./);
  }

  const partial = `### Task 1 (cut off)\n\n${LONG}`;
  f.responses.analyze_video = () => ({ error: { category: 'analysis_incomplete', code: 'analysis_truncated', message: 'The analysis reached the output limit and is incomplete.',
    next_step: 'Do not repeat the same call.', retryable: false }, status: 'failed', charged: 'yes', complete: false, partial_analysis: partial, _text: `Video analysis failed (analysis_truncated).\n\n${partial}` });
  const cut = await read();
  assert.equal(cut.code, 1, 'still a failure for scripts');
  assert.equal(cut.view.ok, false);
  assert.equal(cut.view.error.code, 'analysis_truncated');
  assert.equal(cut.view.charged, 'yes');
  assert.equal(cut.view.partial_analysis, partial, 'the partial analysis was paid for: it is passed on whole');
  assert.ok(cut.view.text.endsWith(partial));
});

test('a service without workflows, a refused login, a rate limit and an outage each get their own code', async t => {
  const { f, home, cli } = await context(t);
  f.responses.get_media_workflow = () => ({ workflow: 'ad-rebuild', run_id: RUN, content: 'ok' });
  const analyze = ['video', 'analyze', LINK, '--run', RUN, '--step', 'reference_analysis', '--purpose', 'breakdown'];

  // A service without a workflow pack does not have these tools. The MCP SDK says so in an error result with text only;
  // other servers answer with a JSON-RPC error.
  f.toolErrors = { get_media_workflow: 'MCP error -32602: Tool get_media_workflow not found' };
  const missing = await cli(['workflow', 'rules', 'ad-rebuild']);
  assert.deepEqual([missing.code, missing.view.error.code, missing.view.error.details.tool], [1, 'workflow_unavailable', 'get_media_workflow']);
  assert.match(missing.view.error.message, /does not offer workflows for this login yet\. Nothing was charged\./);
  for (const [tool, call] of Object.entries(CALLS)) {
    for (const answer of [textOnly(`MCP error -32602: Tool ${tool} not found`), rpcError(-32602, `MCP error -32602: Tool ${tool} not found`), rpcError(-32601, `Unknown tool: ${tool}`)]) {
      const { workflows, requests } = direct(() => answer);
      const thrown = await failure(() => call(workflows));
      assert.deepEqual([thrown.code, thrown.details.tool, requests.length], ['workflow_unavailable', tool, 1], JSON.stringify(answer));
      assert.match(thrown.message, /does not offer workflows for this login yet\. Nothing was charged\./);
    }
  }

  // Arguments the service refuses before the tool runs: the reason is passed on, and nothing ran.
  const issues = 'MCP error -32602: Input validation error: Invalid arguments for tool get_media_workflow: [\n  {\n    "origin": "string",\n    "code": "invalid_format",\n'
    + '    "format": "regex",\n    "path": [\n      "run_id"\n    ],\n    "message": "Invalid string: must match pattern"\n  }\n]';
  f.toolErrors = { get_media_workflow: issues };
  const refused = await cli(['workflow', 'rules', 'ad-rebuild', '--run', 'not-a-run']);
  assert.deepEqual([refused.code, refused.view.error.code, refused.view.error.details.tool], [1, 'invalid_option', 'get_media_workflow']);
  assert.match(refused.view.error.message, /does not accept these values\..* Nothing was charged\./);
  assert.match(refused.view.error.details.reason, /Input validation error[^]*run_id[^]*must match pattern/);
  f.toolErrors = undefined;
  for (const answer of [textOnly(issues), rpcError(-32602, issues), rpcError(-32602, 'Invalid params'), textOnly(`MCP error -32602: Invalid arguments for tool analyze_video: ${'x'.repeat(5000)}`)]) {
    for (const [tool, call] of Object.entries(CALLS)) {
      const thrown = await failure(() => call(direct(() => answer).workflows));
      assert.deepEqual([thrown.code, thrown.details.tool], ['invalid_option', tool], JSON.stringify(answer).slice(0, 80));
      assert.ok(thrown.details.reason.length <= 600, 'a long reason is cut');
    }
  }

  // An answer that cannot be read says nothing about a charge: a read is collected by repeating the same command.
  for (const answer of [textOnly('MCP error -32602: Output validation error: Invalid structured content for tool analyze_video'), textOnly('Unexpected text.'),
    rpcError(-32603, 'Internal error'), { result: {} }, { result: { content: [{ type: 'text', text: 'Tool analyze_video not found' }] } }, {}]) {
    const reading = await failure(() => CALLS.analyze_video(direct(() => answer).workflows));
    assert.deepEqual([reading.code, reading.message], ['unsupported_response',
      'EvoLink returned no structured result. Repeat exactly the same command: a read that had started is collected without a second charge. If it keeps happening, update the CLI.'], JSON.stringify(answer));
    const free = await failure(() => CALLS.get_media_workflow(direct(() => answer).workflows));
    assert.deepEqual([free.code, free.message], ['unsupported_response', 'EvoLink returned no structured result. Retry, or update the CLI.'], JSON.stringify(answer));
  }

  // The first answer refuses the login: the command renews it and asks once more.
  let refusals = 1;
  f.mcpStatus = () => refusals-- > 0 ? { status: 401 } : undefined;
  let before = f.mcpHeaders.length;
  const renewed = await cli(['workflow', 'rules', 'ad-rebuild']);
  assert.equal(renewed.code, 0, renewed.stdout);
  assert.equal(f.mcpHeaders.length, before + 2);
  f.mcpStatus = () => ({ status: 401 });
  before = f.mcpHeaders.length;
  const rejected = await cli(['workflow', 'rules', 'ad-rebuild']);
  assert.deepEqual([rejected.code, rejected.view.error.code], [1, 'login_required']);
  assert.equal(f.mcpHeaders.length, before + 2, 'two attempts, then the user is told to log in');

  f.mcpStatus = () => ({ status: 429, headers: { 'Retry-After': '17' } });
  const limited = await cli(['workflow', 'rules', 'ad-rebuild']);
  assert.deepEqual([limited.view.error.code, limited.view.error.details.retry_after_seconds], ['rate_limited', 17]);

  f.mcpStatus = () => ({ status: 503 });
  const down = await cli(['workflow', 'rules', 'ad-rebuild']);
  assert.deepEqual([down.code, down.view.error.code, down.view.error.message], [1, 'workflow_unavailable', 'The EvoLink workflow service returned HTTP 503. Retry later; nothing was charged by this command.']);
  f.mcpStatus = () => ({ status: 504 });
  const cutShort = await cli(analyze);
  assert.deepEqual([cutShort.code, cutShort.view.error.code], [1, 'workflow_unavailable']);
  assert.match(cutShort.view.error.message, /returned HTTP 504\. If the read had started it may still finish: repeat exactly the same command to collect it without a second charge\.$/);
  f.mcpStatus = undefined;
  // A proxy can answer 5xx while a paid read is under way: then nothing is said about the charge. A refusal ran nothing.
  for (const status of [400, 403, 404, 405, 406, 413, 500, 502, 503, 504, 520]) {
    for (const [tool, call] of Object.entries(CALLS)) {
      const thrown = await failure(() => call(direct(() => new Response('{}', { status })).workflows));
      assert.deepEqual([thrown.code, thrown.message], ['workflow_unavailable', `The EvoLink workflow service returned HTTP ${status}. ${tool === 'analyze_video' && status >= 500
        ? 'If the read had started it may still finish: repeat exactly the same command to collect it without a second charge.' : 'Retry later; nothing was charged by this command.'}`], `${tool} HTTP ${status}`);
    }
  }
  // An answer that is not JSON is treated like no answer.
  const garbled = await failure(() => CALLS.analyze_video(direct(() => new Response('<html>busy</html>', { status: 200 })).workflows));
  assert.deepEqual([garbled.code, /repeat exactly the same command to collect it without a second charge/.test(garbled.message)], ['connection_failed', true]);

  // Nothing listening: a read may have started, so the message says how to collect it without paying twice.
  const gone = await run(await nowhere(), home, ['video', 'analyze', 'https://files.evolink.ai/u/a.mp4', '--run', RUN, '--step', 'reference_analysis', '--purpose', 'sound']);
  assert.deepEqual([gone.code, gone.view.error.code], [1, 'connection_failed']);
  assert.match(gone.view.error.message, /repeat exactly the same command to collect it without a second charge/);
  const free = await run(await nowhere(), home, ['workflow', 'rules', 'ad-rebuild']);
  assert.match(free.view.error.message, /Retry the command; it is free\./);
});

test('workflow deliver and a task ID for video analyze: the task and its run go to the service as given', async t => {
  const { f, cli, calls } = await context(t);
  f.responses.analyze_video = args => ({ status: 'completed', complete: true, analysis_id: ANALYSIS, run_id: args.run_id, step: args.step, purpose: args.purpose,
    analysis: 'The video matches the plan.', charged: 'yes', _text: 'Video analysis (compare) for step delivery_check: complete.' });
  const task = 'task-unified-1763712000-ab12cd34';
  const read = await cli(['video', 'analyze', task, '--run', RUN, '--step', 'delivery_check', '--purpose', 'compare']);
  assert.equal(read.code, 0, read.stdout);
  assert.deepEqual(calls('analyze_video')[0].args, { run_id: RUN, step: 'delivery_check', purpose: 'compare', input_task_id: task });
  // Only a whole task ID is a task: a link that contains one, a shorter ID and another kind of ID stay file links.
  for (const [index, other] of [`https://files.evolink.ai/u/${task}.mp4`, 'task-unified-abc', 'unified-1763712000-ab12cd34'].entries()) {
    await cli(['video', 'analyze', other, '--run', RUN, '--step', 'delivery_check', '--purpose', 'compare']);
    assert.deepEqual(calls('analyze_video')[1 + index].args, { run_id: RUN, step: 'delivery_check', purpose: 'compare', video_url: other }, other);
  }

  f.responses.record_workflow_delivery = args => ({ run_id: args.run_id, delivered_task_id: args.task_id, _text: 'The delivered video was recorded.' });
  const delivered = await cli(['workflow', 'deliver', task, '--run', RUN]);
  assert.equal(delivered.code, 0, delivered.stdout);
  assert.deepEqual(calls('record_workflow_delivery')[0].args, { run_id: RUN, task_id: task }, 'nothing is sent that was not asked for');
  assert.deepEqual([delivered.view.ok, delivered.view.delivered_task_id], [true, task]);
  const replacement = 'task-unified-1763712999-ef56ab78';
  const replaced = await cli(['workflow', 'deliver', replacement, '--run', RUN, '--previous-task', task]);
  assert.equal(replaced.code, 0, replaced.stdout);
  assert.deepEqual(calls('record_workflow_delivery')[1].args, { run_id: RUN, task_id: replacement, previous_task_id: task });

  const before = f.mcpHeaders.length;
  for (const [args, code] of [
    [[task], 'missing_option'],
    [[task, '--previous-task', replacement], 'missing_option'],
    [[task, '--run', RUN, '--step', 'final_video'], 'invalid_option'],
    [['--run', RUN], 'unknown_command'],
  ]) {
    const refused = await cli(['workflow', 'deliver', ...args]);
    assert.deepEqual([refused.code, refused.view.error.code], [1, code], args.join(' '));
  }
  assert.equal(f.mcpHeaders.length, before, 'a refused command sends nothing');

  // A selection the service does not take comes back with the service's code and words, and exits non-zero.
  f.responses.record_workflow_delivery = () => ({ error: { category: 'invalid_request', code: 'invalid_request', message: 'This task is not a completed video of this run.',
    next_step: 'Pass a completed video task generated in this run.' } });
  const refused = await cli(['workflow', 'deliver', task, '--run', RUN]);
  assert.equal(refused.code, 1);
  assert.equal(refused.view.error.message, 'This task is not a completed video of this run.');

  const top = await cli(['--help'], { json: false });
  assert.match(top.stdout, /workflow deliver TASK_ID --run RUN_ID \[--previous-task TASK_ID\]\n +Record the finished video a workflow run delivered \(free\)/);
  const help = await cli(['workflow', 'deliver', '--help']);
  assert.deepEqual([help.view.command, Object.keys(help.view.options)], ['workflow deliver', ['run', 'previous-task']]);
});

test('command shapes, help and the bundled skill agree on the workflow commands', async t => {
  const { f, home, cli } = await context(t);
  for (const args of [['workflow', 'rules'], ['workflow', 'estimate'], ['video', 'analyze'], ['video', 'analysis'], ['workflow'], ['video'], ['workflow', 'run', 'ad-rebuild']]) {
    const refused = await cli(args);
    assert.deepEqual([refused.code, refused.view.error.code], [1, 'unknown_command'], args.join(' '));
  }
  assert.equal(f.mcpHeaders.length, 0);

  const group = await cli(['workflow', '--help']);
  assert.deepEqual(group.view.subcommands, ['workflow deliver', 'workflow rules', 'workflow estimate']);
  const analyze = await cli(['video', 'analyze', '--help']);
  assert.equal(analyze.view.command, 'video analyze');
  assert.deepEqual(Object.keys(analyze.view.options), ['run', 'step', 'purpose', 'target-file', 'attempt']);
  assert.match(analyze.view.description, /Paid, by tokens/);
  const top = await cli(['--help'], { json: false });
  for (const line of ['workflow rules NAME', 'workflow estimate NAME', 'video analyze FILE_URL', 'video analysis ANALYSIS_ID']) assert.ok(top.stdout.includes(line), line);
  assert.equal(f.mcpHeaders.length, 0, 'help needs no login and sends nothing');

  // Every command the mapping and the skill page name exists in this CLI.
  const page = await fs.readFile(fileURLToPath(new URL('../skills/evolink-cli/references/ad-rebuild.md', import.meta.url)), 'utf8');
  const named = new Set([...Object.values(WORKFLOW_COMMANDS), ...page.split('\n')].flatMap(line => [...line.matchAll(/evolink ((?:workflow|video) [a-z]+)/g)].map(match => match[1])));
  assert.deepEqual([...named].sort(), ['video analysis', 'video analyze', 'workflow deliver', 'workflow estimate', 'workflow rules']);
  for (const command of named) assert.equal(commandHelp(command.split(' ')).command, command);
  // The other commands the mapping names exist too, and the page's table has a row for every tool of the mapping.
  for (const [tools, command] of Object.entries(WORKFLOW_COMMANDS)) {
    for (const tool of tools.replace(' with estimate', '').split(', ')) assert.ok(page.includes(`\`${tool}\``), `${tool} is in the page's table`);
    if (!command.startsWith('evolink ')) { assert.equal(tools, 'make_frames'); continue; }
    const [first, second = ''] = command.slice('evolink '.length).split(' ');
    for (const action of second.split('|')) {
      const help = commandHelp([first, action]);
      assert.ok(help.command === `${first} ${action}` || (help.command === first && !/^[a-z]+$/.test(action)), command);
    }
  }
  // The tools the workflow's rules name, as of the pack this CLI was written for.
  for (const tool of ['get_media_workflow', 'analyze_video', 'get_video_analysis', 'get_model', 'estimate_cost', 'generate_image', 'generate_video', 'generate_audio',
    'get_task', 'list_tasks', 'check_balance', 'make_frames']) assert.ok(Object.keys(WORKFLOW_COMMANDS).some(key => key.split(', ').includes(tool)), tool);
  for (const step of ['0. Check inputs and confirm the cost', '1. Read the reference', '2. Write the target', '3. Plan the whole ad', '4. Build and check all keyframes',
    '5. Build the complete video input', '6. Generate and check', '7. Deliver']) assert.ok(page.split('\n').includes(step), step);
  assert.ok(!/refund|VS Code/i.test(page));

  // The page ships with the skill and the skill points to it.
  const installed = await installSkill({ home, agent: 'codex' });
  const directory = path.dirname(installed.path);
  assert.equal(await fs.readFile(path.join(directory, 'references/ad-rebuild.md'), 'utf8'), page);
  assert.match(await fs.readFile(installed.path, 'utf8'), /\[Ad Rebuild workflow\]\(references\/ad-rebuild\.md\)/);
});
