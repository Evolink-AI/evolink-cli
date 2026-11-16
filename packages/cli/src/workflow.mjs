import * as fs from 'node:fs/promises';
import { CliError, requireThat, safeMessage, localFile } from './errors.mjs';
import { USER_AGENT } from './network.mjs';

/**
 * Workflow rules and video reads come from the signed-in EvoLink MCP service (the OAuth resource this CLI
 * logs in to), not from the platform API: the rules and the prompts behind a read stay on that service.
 * The CLI sends one JSON-RPC tools/call with the login token and prints what comes back.
 */

/** How the tool names in workflow rules map to this CLI. Shown with every rules answer. */
export const WORKFLOW_COMMANDS = Object.freeze({
  get_media_workflow: 'evolink workflow rules NAME [--section ID] [--run RUN_ID] --json',
  'get_media_workflow with estimate': 'evolink workflow estimate NAME --run RUN_ID --seconds N --keyframes N [--quality 480p|720p|1080p] [--aspect-ratio 9:16] [--creator-images N] --json',
  analyze_video: 'evolink video analyze FILE_URL --run RUN_ID --step STEP --purpose PURPOSE [--target-file FILE] [--attempt N] --json',
  get_video_analysis: 'evolink video analysis ANALYSIS_ID --json',
  'upload_file, prepare_upload': 'evolink upload FILE --json',
  'search_models, get_model': 'evolink models search|show ... --json',
  estimate_cost: 'evolink estimate --model MODEL --input-file FILE --json',
  'generate_image, generate_video, generate_audio': 'evolink generate image|video|audio --quote ID --confirm --json',
  'get_task, list_tasks': 'evolink tasks get|wait|list|batch ... --json',
  check_balance: 'evolink balance --json',
  make_frames: 'not in the CLI: extract frames, crops and contact sheets with local ffmpeg',
});

const COMMANDS_TEXT = ['In this CLI the tools named in the rules are these commands:',
  ...Object.entries(WORKFLOW_COMMANDS).map(([tool, command]) => `  ${tool}: ${command}`)].join('\n');

/** Results a failed call still carries for the assistant: they are passed on whole, not shortened like an error. */
const KEPT_FAILURES = new Set(['analysis_truncated']);
/** Categories that say only what kind of failure it was; the service's code then names the cause. */
const BROAD_CATEGORIES = new Set(['invalid_request', 'server_error', 'not_found', 'analysis_incomplete']);
const NOT_OFFERED = 'This EvoLink service does not offer workflows for this login yet. Nothing was charged.';
const REFUSED_VALUES = 'The EvoLink workflow service does not accept these values. Check the workflow name and the options against the workflow rules. Nothing was charged.';
/** A read keeps running on EvoLink when the answer is lost; the same command returns it without a second charge. */
const READ_MAY_RUN = 'If the read had started it may still finish: repeat exactly the same command to collect it without a second charge.';
/** An answer that cannot be read says nothing about a charge. The same read command returns a read that had started. */
const unreadable = name => new CliError('unsupported_response', name === 'analyze_video'
  ? 'EvoLink returned no structured result. Repeat exactly the same command: a read that had started is collected without a second charge. If it keeps happening, update the CLI.'
  : 'EvoLink returned no structured result. Retry, or update the CLI.');
/** Far above any target a workflow accepts; stops a video or another large file passed by mistake. */
const MAX_TARGET_BYTES = 1_000_000;

export class Workflows {
  constructor(credentials, { signal, fetchFn = fetch, timeoutMs = 75_000 } = {}) {
    this.credentials = credentials; this.signal = signal; this.fetchFn = fetchFn; this.timeoutMs = timeoutMs;
  }

  /** One tools/call on the MCP service. A refused login is retried once with a renewed token. */
  async call(name, args) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const access = await this.credentials.access(attempt > 0);
      let response, message;
      try {
        const limit = AbortSignal.timeout(this.timeoutMs);
        response = await this.fetchFn(this.credentials.server.href, { method: 'POST', redirect: 'error', credentials: 'omit',
          headers: { Authorization: `Bearer ${access.access_token}`, 'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream', 'User-Agent': USER_AGENT },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
          signal: this.signal ? AbortSignal.any([this.signal, limit]) : limit });
        if (response.status === 401) {
          await response.body?.cancel();
          if (attempt === 0) continue;
          throw new CliError('login_required', 'The EvoLink login was not accepted. Run evolink auth login.');
        }
        if (response.status === 429) {
          const wait = Number(response.headers.get('retry-after'));
          await response.body?.cancel();
          throw new CliError('rate_limited', 'Too many requests on this EvoLink connection. Wait, then retry the same command.',
            Number.isFinite(wait) && wait > 0 ? { retry_after_seconds: wait } : undefined);
        }
        if (!response.ok) {
          await response.body?.cancel();
          // A proxy can answer 5xx while a read is under way: only a refusal, or a free command, is called uncharged.
          throw new CliError('workflow_unavailable', `The EvoLink workflow service returned HTTP ${response.status}. ${
            name === 'analyze_video' && response.status >= 500 ? READ_MAY_RUN : 'Retry later; nothing was charged by this command.'}`);
        }
        message = await response.json();
      } catch (error) {
        if (error instanceof CliError) throw error;
        if (this.signal?.aborted) throw new CliError('interrupted', `Stopped waiting locally.${name === 'analyze_video' ? ` ${READ_MAY_RUN}` : ''}`, undefined, 130);
        throw new CliError('connection_failed', `The EvoLink workflow service did not answer. ${name === 'analyze_video' ? READ_MAY_RUN : 'Retry the command; it is free.'}`);
      }
      const result = message?.result;
      const data = result?.structuredContent;
      const text = (result?.content ?? []).filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n');
      if (!data || typeof data !== 'object') {
        // Before a tool runs, the service answers with text only (the MCP SDK) or with a JSON-RPC error:
        // a tool it does not have, because no workflow is offered, or arguments it does not accept.
        const said = String(message?.error?.message ?? (result?.isError ? text : ''));
        const unknown = /tool \S+ not found|unknown tool/i.test(said);
        if (unknown) throw new CliError('workflow_unavailable', NOT_OFFERED, { tool: name });
        if (/input validation error|invalid arguments|invalid params/i.test(said)) throw new CliError('invalid_option', REFUSED_VALUES, { tool: name, reason: safeMessage(said).slice(0, 600) });
        throw unreadable(name);
      }
      if (result.isError || data.ok === false) {
        // The category names account and limit problems the way the rest of this CLI does; for a broad one the code says more.
        const { category, code: finer } = data.error ?? {};
        const code = (BROAD_CATEGORIES.has(category) || !category ? finer : category) || category || 'workflow_failed';
        // A cut-off read was charged and carries what was read so far: return it whole, marked as failed.
        if (KEPT_FAILURES.has(code)) return { ...data, ok: false, text };
        throw new CliError(code, safeMessage(data.error?.message || text || 'The EvoLink workflow service refused this request.'),
          { ...data, text: safeMessage(text) });
      }
      if (data.ok !== true) throw unreadable(name);
      return { ...data, text };
    }
    throw new CliError('login_required', 'The login expired. Run evolink auth login.');
  }

  async rules(workflow, { section, run } = {}) {
    const result = await this.call('get_media_workflow', { workflow, ...(section !== undefined ? { section } : {}), ...(run !== undefined ? { run_id: run } : {}) });
    return { ...result, cli_commands: WORKFLOW_COMMANDS, text: `${COMMANDS_TEXT}\n\n${result.text}` };
  }

  async estimate(workflow, { run, seconds, keyframes, quality, aspectRatio, creatorImages } = {}) {
    return this.call('get_media_workflow', { workflow, ...(run !== undefined ? { run_id: run } : {}), estimate: {
      output_seconds: seconds, keyframes, ...(quality !== undefined ? { quality } : {}),
      ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}), ...(creatorImages !== undefined ? { creator_images: creatorImages } : {}) } });
  }

  async analyze(videoUrl, { run, step, purpose, targetFile, attempt } = {}) {
    let target;
    if (targetFile !== undefined) {
      const stat = await localFile(() => fs.stat(targetFile), { file: targetFile });
      requireThat(stat.isFile(), 'invalid_file', 'The target path is not a regular file.');
      requireThat(stat.size <= MAX_TARGET_BYTES, 'invalid_input', 'The target file is larger than 1 MB. Pass the target sheet and timeline as a text file.');
      target = await localFile(() => fs.readFile(targetFile, 'utf8'), { file: targetFile });
      requireThat(target.trim(), 'invalid_input', 'The target file is empty.');
    }
    return this.call('analyze_video', { run_id: run, step, purpose, video_url: videoUrl,
      ...(target !== undefined ? { target } : {}), ...(attempt !== undefined ? { attempt } : {}) });
  }

  async analysis(id) {
    return this.call('get_video_analysis', { analysis_id: id });
  }
}
