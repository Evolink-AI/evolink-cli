// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { gatewayAuthHeaders } from '../config.js';
import { currentRequestCredentials } from '../request-context.js';
import { RequestTimeoutError } from './http-policy.js';
import { PricingRulesError, getPricingRules, recentModelRules } from './pricing-rules-client.js';
import { QuoteError, compareDecimal, isUsageParameter, prepareQuoteParameters, quoteRequestHash, reservationErrorOrigin } from './pricing-quote-client.js';
import { prepareSeedanceInput } from './seedance-input.js';
import { searchUsage } from './search-usage.js';
import { CONSERVATIVE_QUOTE_PARAMETERS } from './pricing-derived.js';
import { INPUT_IMAGE_TOKENS, SVG_AUTHOR_INPUT_TOKENS, SVG_AUTHOR_OUTPUT_TOKENS, SVG_DEFAULT_AUTHOR, isTokenImageModel, tokenImageReservation } from './gpt-image-tokens.js';
import { OMNI_IMAGE_TOKENS, OMNI_UNREAD_TIER, isOmniTokenModel, omniInputTiers, omniLowerInputTier, omniQuotedTier, omniReservation } from './omni-tokens.js';
import { isQwenTTSModel, qwenTTSInput, qwenTTSReservation } from './qwen-tts-tokens.js';
import { MINIMAX_ENHANCE_TEXT_TOKENS, MINIMAX_OUTPUT_TOKENS_4K, MINIMAX_OUTPUT_TOKENS_UP_TO_2K, MINIMAX_REFERENCE_IMAGE_TOKENS, isMiniMaxH3ImageModel, miniMaxH3ImageReservation } from './minimax-h3-image-tokens.js';
/**
 * How long an approval from estimate_cost holds: 24 hours from the estimate. The rules' own `fresh_until`
 * is a short refresh window (minutes); people confirming a price in a chat may come back much
 * later. generate_* re-evaluates the current rules every time: it refuses an approval past this
 * time (`quote_expired`) or one whose price rose (`price_changed`), and submits at an unchanged or
 * lower price (checkRulesApproval). The gateway keeps a request ID for 24 hours, so a retry under
 * one approval is still within that window of the first submission.
 */
export const APPROVAL_TTL_MS = 24 * 60 * 60_000;
function fail(code, message) { throw new QuoteError(code, message); }
function gcd(a, b) { while (b)
    [a, b] = [b, a % b]; return a < 0n ? -a : a; }
function rat(n, d = 1n) {
    if (!d)
        fail('invalid_pricing_expression', 'The pricing rule divides by zero.');
    if (n.toString().length > 4096 || d.toString().length > 4096)
        fail('invalid_pricing_expression', 'The pricing calculation exceeds its size limit.');
    if (d < 0n) {
        n = -n;
        d = -d;
    }
    const g = gcd(n, d);
    return { n: n / g, d: d / g };
}
function decimal(value) {
    const text = String(value);
    if (text.length > 128 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text))
        fail('invalid_pricing_expression', 'The pricing rule requires a finite decimal.');
    const [whole, part = ''] = text.split('.');
    return rat(BigInt(whole + part), 10n ** BigInt(part.length));
}
function numeric(value) {
    if (typeof value === 'object')
        return value;
    if (typeof value === 'string')
        return decimal(value);
    return fail('invalid_pricing_expression', 'The pricing rule requires a number.');
}
function boolean(value) {
    if (typeof value !== 'boolean')
        fail('invalid_pricing_expression', 'The pricing rule requires a boolean condition.');
    return value;
}
const cmp = (a, b) => a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0;
const mul = (a, b) => rat(a.n * b.n, a.d * b.d);
const div = (a, b) => rat(a.n * b.d, a.d * b.n);
const add = (a, b) => rat(a.n * b.d + b.n * a.d, a.d * b.d);
function rounded(a, mode) {
    const trunc = a.n / a.d, remainder = a.n % a.d;
    if (mode === 'floor')
        return rat(trunc - (remainder < 0n ? 1n : 0n));
    if (mode === 'ceil')
        return rat(trunc + (remainder > 0n ? 1n : 0n));
    if (mode === 'half_up')
        return rat(trunc + ((remainder < 0n ? -remainder : remainder) * 2n >= a.d ? (a.n < 0n ? -1n : 1n) : 0n));
    return fail('invalid_pricing_expression', 'The pricing rule uses an unsupported rounding mode.');
}
function exact(a) { return a.d === 1n ? String(a.n) : `${a.n}/${a.d}`; }
function display(a, places) {
    const scale = 10n ** BigInt(places), n = rounded(mul(a, rat(scale)), 'half_up').n;
    const text = n.toString().padStart(places + 1, '0');
    return places ? `${text.slice(0, -places)}.${text.slice(-places)}`.replace(/\.?0+$/, '') : text;
}
export function amountsForUC(uc) {
    const a = decimal(uc);
    return { uc, credits: display(div(a, rat(10000n)), 4), cny: display(div(a, rat(100000n)), 5), usd: display(div(a, rat(680000n)), 8) };
}
function budgetUC(budget) {
    // String(number) may use scientific notation for a small, explicit budget.
    const [mantissa, exp = '0'] = String(budget).split('e');
    const power = Number(exp), b = decimal(mantissa);
    const value = power < 0 ? div(b, rat(10n ** BigInt(-power))) : mul(b, rat(10n ** BigInt(power)));
    return mul(value, rat(680000n));
}
export function rulesBudgetExceeded(uc, budget) {
    return cmp(decimal(uc), budgetUC(budget)) > 0;
}
/**
 * A token-billed reference price fits a budget only with room for the tokens a task actually uses: 1.5 times the
 * reference must fit. The largest overrun on record is 20% (gpt-image-2, 4K high); large reference images are unmeasured.
 */
export const REFERENCE_BUDGET_FACTOR = '1.5';
/** The amount a budget has to cover for a reference price, for messages. */
export function referenceAllowance(uc) { return amountsForUC(display(mul(decimal(uc), decimal(REFERENCE_BUDGET_FACTOR)), 4)); }
export function referenceBudgetExceeded(uc, budget) {
    return cmp(mul(decimal(uc), decimal(REFERENCE_BUDGET_FACTOR)), budgetUC(budget)) > 0;
}
const arity = { constant: [0, 0], variable: [0, 0], lookup: [0, 0],
    add: [2, 32], multiply: [2, 32], subtract: [2, 2], divide: [2, 2], min: [2, 32], max: [2, 32], clamp: [3, 3],
    ceil: [1, 1], floor: [1, 1], if: [3, 3], eq: [2, 2], neq: [2, 2], lt: [2, 2], lte: [2, 2], gt: [2, 2], gte: [2, 2],
    and: [2, 32], or: [2, 32], not: [1, 1] };
function checkExpression(node, declared, depth = 0, budget = { nodes: 0 }) {
    const bounds = arity[node.op], size = node.args?.length ?? 0;
    if (depth > 32 || ++budget.nodes > 10_000 || !bounds || size < bounds[0] || size > bounds[1]) {
        fail('invalid_pricing_expression', 'The pricing rule has an unsupported or malformed expression.');
    }
    if (node.op === 'constant' && node.value === undefined || node.op === 'variable' && (!node.name || !declared.has(node.name))) {
        fail('invalid_pricing_expression', 'The pricing rule references an undeclared value.');
    }
    if (node.op === 'lookup') {
        if (!node.key || !node.values)
            fail('invalid_pricing_expression', 'The pricing lookup is incomplete.');
        checkExpression(node.key, declared, depth + 1, budget);
    }
    for (const child of node.args ?? [])
        checkExpression(child, declared, depth + 1, budget);
}
/** Every value an expression reads, so a component short of several usages can name all of them. */
function variables(node, found) {
    if (!node)
        return;
    if (node.op === 'variable' && node.name)
        found.add(node.name);
    if (node.op === 'lookup')
        variables(node.key, found);
    for (const child of node.args ?? [])
        variables(child, found);
}
function componentReads(c) {
    const read = new Set();
    for (const expr of [c.condition, c.quantity_rule, ...c.tiers.map(t => t.when)])
        variables(expr, read);
    return read;
}
/** How to give a usage value an estimate lacks, or why only the finished task knows it. */
function usageHint(name, entry, declared) {
    if (name === 'media_seconds')
        return 'pass the length of the input video in seconds as media_seconds (for several reference videos, the longest one\'s): EvoLink measures it at submission and reserves its tokens with the output\'s.';
    if (name === 'input_seconds' || name === 'first_input_video_seconds')
        return 'pass the length of the input video or audio, in seconds, as media_seconds.';
    if (name === 'source_output_seconds')
        return `pass the length of the source task's output, in seconds, in pricing_parameters.${name}.`;
    if (name === 'output_seconds' || name === 'duration_seconds') {
        // As prepareQuoteParameters reads it: media_seconds stands for the billed length only where the model takes no duration.
        return entry.spec && !entry.spec.params.duration && !declared.has('duration') && entry.spec.constraints?.outputDuration !== 'unknown'
            ? 'pass the billed length, usually that of the input video or audio, in seconds, as media_seconds.'
            : `the generated length is known only after the task runs; pass an expected length in pricing_parameters.${name} only when the user gives one.`;
    }
    if (name === 'output_fps')
        return `pass the source video's frame rate in pricing_parameters.${name}, or, if a 30 fps output is acceptable, set model_params.max_fps to "30".`;
    if (/search_count$/.test(name))
        return `the number of searches is known only after the task runs; pass an expected count in pricing_parameters.${name} only when the user gives one.`;
    return `pass measured or expected usage in pricing_parameters.${name}.`;
}
/** Said with every estimate priced from the public default rules. */
export const PUBLIC_PRICES_NOTE = 'Public default prices; account discounts are not included.';
/** Said with every estimate priced from the rules the gateway returned for the caller's own account. */
export const ACCOUNT_PRICES_NOTE = 'Priced at the rates of your own EvoLink account.';
/** How a result names the rates it used. */
export const ratesOf = (scope) => scope === 'account' ? 'your account\'s rates' : 'public default rates';
/** Token usage is known only once the task has run; name the published rates instead. */
function tokenHelp(names, rule, scope) {
    const unit = (text) => text === '1k_tokens' ? '1K tokens' : text.replace(/_/g, ' ');
    const rates = rule.components.filter(c => names.some(name => componentReads(c).has(name)))
        .map(c => `${c.id} ${c.tiers.length ? 'from ' : ''}$${c.rate.usd} per ${unit(c.unit)}`);
    return `${names.join(', ')}: billed by the tokens the task actually uses, known only after it runs${rates.length ? ` (${ratesOf(scope)}: ${rates.join('; ')})` : ''}.`;
}
function helpLines(names, entry, rule, declared, scope = 'public_default') {
    const tokens = names.filter(name => /tokens$/.test(name));
    return [...names.filter(name => !tokens.includes(name)).map(name => `${name}: ${usageHint(name, entry, declared)}`),
        ...(tokens.length ? [tokenHelp(tokens, rule, scope)] : [])];
}
/** Every usage value a rule can bill by, with how to give it; get_model lists them before any estimate. */
export function billingUsageHelp(rule, entry, scope = 'public_default') {
    if (reservesTokens(rule, entry))
        return [];
    const declared = new Set((rule.parameters ?? []).map(p => p.name));
    return helpLines([...declared].filter(name => isUsageParameter(entry.id, name)).sort(), entry, rule, declared, scope);
}
// GPT Image, Gemini Omni, Qwen TTS and MiniMax H3 Image token models: the reference price counts the tokens the gateway
// reserves at submission for the input.
const RESERVED_TOKENS = new Set(['image_input_tokens', 'image_cached_input_tokens', 'image_output_tokens',
    'text_input_tokens', 'text_cached_input_tokens', 'text_output_tokens']);
const OMNI_TOKENS = new Set(['input_tokens', 'video_output_tokens', 'other_output_tokens']);
const QWEN_TOKENS = new Set(['input_tokens', 'output_tokens']);
/** MiniMax H3 Image: each role's tokens. The gateway prices all three and refuses a model with any of them unpriced. */
const MINIMAX_ROLES = { image_output: 'image_output_tokens', text_input: 'text_input_tokens', image_input: 'image_input_tokens' };
/**
 * GPT Image 2.6 rules also bill an SVG's author model (svg_model and its tokens): a request without SVG output uses none,
 * and an SVG request the author model and the tokens EvoLink reserves for it.
 */
const NO_SVG_AUTHOR = { svg_model: 'none', svg_input_tokens: 0, svg_output_tokens: 0 };
const svgAuthor = (name) => Object.hasOwn(NO_SVG_AUTHOR, name);
/**
 * The input without its SVG author: the reservation gives the author model as the gateway reads it (trimmed and
 * lower-cased), so the spelling in the input is not checked against the rule again.
 */
function withoutSvgAuthor(input) {
    const params = input.model_params;
    if (!params || typeof params !== 'object' || Array.isArray(params) || !Object.hasOwn(params, 'svg_model'))
        return input;
    const { svg_model: _author, ...rest } = params;
    return { ...input, model_params: rest };
}
function svgAuthorParameter(name, author) {
    if (!author)
        return NO_SVG_AUTHOR[name];
    return name === 'svg_model' ? author.model : name === 'svg_input_tokens' ? author.input_tokens : author.output_tokens;
}
/**
 * An SVG request is priced only by a rule that prices its author model: estimateGPTImage26SVGAuthorCost refuses a model
 * without both of its roles (svg_input:<model>, svg_output:<model>) rather than reserve nothing for it.
 */
function checkSvgAuthorPriced(rule, model) {
    const author = (rule.parameters ?? []).find(p => p.name === 'svg_model');
    const tokens = ['svg_input_tokens', 'svg_output_tokens'];
    const priced = (author?.values ?? author?.enum ?? []).includes(model) && tokens.every(name => (rule.parameters ?? []).some(p => p.name === name))
        && [`svg_input:${model}`, `svg_output:${model}`].every((role, i) => rule.components.some(c => c.role === role
            && c.pricing_status === 'available' && componentReads(c).has(tokens[i])));
    if (!priced)
        fail('pricing_rules_unavailable', `The published rules do not price the SVG author model ${model}.`);
}
/** Only a rule billed by these token counts alone, with an output component, can price the reservation. */
function reservesTokens(rule, entry) {
    const id = entry.id.toLowerCase();
    if (rule.settlement_basis !== 'actual_usage')
        return false;
    if (isOmniTokenModel(id)) {
        return (rule.parameters ?? []).every(p => OMNI_TOKENS.has(p.name))
            && rule.components.some(c => c.role === 'video_output' && c.pricing_status === 'available' && componentReads(c).has('video_output_tokens'));
    }
    if (isQwenTTSModel(id)) {
        return (rule.parameters ?? []).every(p => QWEN_TOKENS.has(p.name))
            && rule.components.some(c => c.role === 'output' && c.pricing_status === 'available' && componentReads(c).has('output_tokens'));
    }
    if (isMiniMaxH3ImageModel(id)) {
        const tokens = new Set(Object.values(MINIMAX_ROLES));
        return (rule.parameters ?? []).every(p => tokens.has(p.name)) && Object.entries(MINIMAX_ROLES).every(([role, name]) => rule.components.some(c => c.role === role && c.pricing_status === 'available' && componentReads(c).has(name)));
    }
    return isTokenImageModel(id)
        && (rule.parameters ?? []).every(p => RESERVED_TOKENS.has(p.name)
            || svgAuthor(p.name) && (p.name !== 'svg_model' || (p.values ?? p.enum ?? []).includes(NO_SVG_AUTHOR.svg_model)))
        && rule.components.some(c => c.role === 'image_output' && c.pricing_status === 'available' && componentReads(c).has('image_output_tokens'));
}
/** How estimate_cost prices a token model, for get_model, at the rates of `scope` (the rule's own). */
export function tokenReferenceHelp(rule, entry, scope = 'public_default') {
    if (!reservesTokens(rule, entry))
        return undefined;
    const rates = rule.components.filter(c => ![...componentReads(c)].some(svgAuthor))
        .map(c => `${c.id} $${c.rate.usd} per ${c.unit === '1k_tokens' ? '1K tokens' : c.unit.replace(/_/g, ' ')}`);
    if (isOmniTokenModel(entry.id.toLowerCase())) {
        return `Billed by actual token usage. estimate_cost gives a reference price for the exact input: the tokens EvoLink reserves at submission for its resolution, duration, prompt, images and input videos, at the published rates (${ratesOf(scope)}: ${rates.join('; ')}). Give an input or reference video's length as media_seconds; its resolution is read at submission, so the reference counts the highest (${OMNI_UNREAD_TIER}) and the estimate also lists the price at each input resolution. The task settles at the tokens it actually uses.`;
    }
    if (isQwenTTSModel(entry.id)) {
        return `Billed by actual token usage. estimate_cost gives a reference price for the exact input: the tokens EvoLink reserves at submission for the text (after hot_fix.replace), an instruction or [tags] and hot_fix, at the published rates (${ratesOf(scope)}: ${rates.join('; ')}). It counts each character's worst case, so the task usually settles below it, at the tokens it actually uses.`;
    }
    if (isMiniMaxH3ImageModel(entry.id)) {
        return `Billed by actual token usage. estimate_cost gives a reference price for the exact input: the tokens EvoLink reserves at submission for each image, ${tokenText(MINIMAX_OUTPUT_TOKENS_UP_TO_2K)} output tokens up to 2K, ${tokenText(MINIMAX_OUTPUT_TOKENS_4K)} at 4K or one per 32×32 pixels of an explicit size, the prompt (plus ${tokenText(MINIMAX_ENHANCE_TEXT_TOKENS)} when it is enhanced) and ${tokenText(MINIMAX_REFERENCE_IMAGE_TOKENS)} per reference image, times n, at the published rates (${ratesOf(scope)}: ${rates.join('; ')}). The task settles at the tokens it actually uses.`;
    }
    // GPT Image 2.6: an SVG's author model is reserved on top of the image.
    const svg = (rule.parameters ?? []).some(p => p.name === 'svg_model')
        ? ` With output_format svg it adds what EvoLink reserves for the SVG author model (model_params.svg_model, default ${SVG_DEFAULT_AUTHOR}): ${tokenText(SVG_AUTHOR_INPUT_TOKENS)} input and ${tokenText(SVG_AUTHOR_OUTPUT_TOKENS)} output tokens at that model's published rates.` : '';
    return `Billed by actual token usage. estimate_cost gives a reference price for the exact input: the tokens EvoLink reserves at submission for its size, quality, n, prompt and reference images, at the published rates (${ratesOf(scope)}: ${rates.join('; ')}).${svg} The task settles at the tokens it actually uses.`;
}
/** An Omni or Qwen TTS reservation's tokens as the rule's parameters. */
const tokenParameters = (rule, tokens) => Object.fromEntries((rule.parameters ?? []).map(p => [p.name, tokens[p.name] ?? 0]));
const omniParameters = (rule, usage) => tokenParameters(rule, usage.tokens);
function reservation(rule, entry, input, countPromptTokens, mediaSeconds) {
    if (!reservesTokens(rule, entry))
        return undefined;
    try {
        return tokenReservation(rule, entry, input, countPromptTokens, mediaSeconds);
    }
    catch (error) {
        throw error instanceof QuoteError ? reservationErrorOrigin(error, entry, input) : error;
    }
}
function tokenReservation(rule, entry, input, countPromptTokens, mediaSeconds) {
    const id = entry.id.toLowerCase();
    if (isOmniTokenModel(id)) {
        const usage = omniReservation(id, input, mediaSeconds, { countPromptTokens });
        return 'needs' in usage ? usage : { omni: usage, parameters: omniParameters(rule, usage) };
    }
    if (isQwenTTSModel(id)) {
        const usage = qwenTTSReservation(input);
        return { qwen: usage, parameters: tokenParameters(rule, usage.tokens) };
    }
    if (isMiniMaxH3ImageModel(id)) {
        const usage = miniMaxH3ImageReservation(input, countPromptTokens);
        return { minimax: usage, parameters: tokenParameters(rule, usage.per_image) };
    }
    const usage = tokenImageReservation(id, input, countPromptTokens);
    if (usage.svg_author)
        checkSvgAuthorPriced(rule, usage.svg_author.model);
    const parameters = {};
    for (const p of rule.parameters ?? []) {
        parameters[p.name] = svgAuthor(p.name) ? svgAuthorParameter(p.name, usage.svg_author)
            : usage.per_image[p.name] ?? 0;
    }
    return { gpt: usage, parameters };
}
const CONFIRM_REFERENCE = 'Confirm this reference price before generation. It is billed by actual token usage: EvoLink reserves this amount at submission and settles the task at the tokens it actually uses, refunding or charging the difference when it finishes, so the final charge may be lower or slightly higher.';
const ignoredNote = (ignored) => `pricing_parameters ${ignored.join(', ')} ${ignored.length > 1 ? 'are' : 'is'} not used for this model: the reference price comes from the generation input.`;
function reservationNotes(usage, ignored, svgAuthorPart) {
    const notes = [CONFIRM_REFERENCE];
    const gif = usage.output.gif, author = usage.svg_author;
    if (author && svgAuthorPart)
        notes.push(`output_format is svg: the author model ${author.model} writes the SVG, and the reference includes ${svgAuthorPart.credits} credits (about $${svgAuthorPart.usd}) for it, the ${tokenText(author.input_tokens)} input and ${tokenText(author.output_tokens)} output tokens EvoLink reserves for it at submission. That part is also settled at the tokens the author model actually uses; its reasoning counts as output tokens, so a higher svg_reasoning_effort can cost more.`);
    if (gif)
        notes.push(`output_format is gif: the ${gif.frames} frames of ${gif.frame_width}×${gif.frame_height}${usage.output.size === 'auto' ? ' (size auto)' : ''} are drawn ${gif.columns}×${gif.rows} on one ${usage.output.width}×${usage.output.height} image, and the reference counts that image's output tokens.`);
    else if (usage.output.size === 'auto')
        notes.push('size is auto, so the reference counts a 2048×2048 output, as EvoLink reserves for auto; the image is often smaller, so set a size for a closer reference price.');
    if (usage.reference_images)
        notes.push(`Each reference image or mask counts ${INPUT_IMAGE_TOKENS.toLocaleString('en-US')} input tokens; larger reference images can use more.`);
    if (usage.images > 1)
        notes.push(`n=${usage.images}: the reference covers ${usage.images} images; the model often returns fewer, and the task is billed for what it returns.`);
    notes.push('Prompt tokens are approximated; EvoLink counts them exactly at submission.');
    if (ignored.length)
        notes.push(ignoredNote(ignored));
    return notes;
}
const tokenText = (tokens) => tokens.toLocaleString('en-US');
function omniBasis(usage) {
    const t = usage.tokens, videos = usage.input_videos;
    const parts = [`${tokenText(t.video_output_tokens)} video output tokens (${usage.upscale ? `upscale ${usage.upscale.source} to ${usage.upscale.target}` : usage.output.resolution}, ${usage.output.seconds} s)`];
    if (t.input_tokens) {
        const inputs = [`about ${tokenText(usage.prompt_tokens)} prompt tokens`, ...usage.images ? [`${usage.images} image${usage.images > 1 ? 's' : ''}`] : [],
            ...videos ? [`${videos.count > 1 ? `${videos.count} reference videos of` : 'an input video of'} ${videos.seconds} s at ${videos.resolution}`] : []];
        parts.push(`${tokenText(t.input_tokens)} input tokens (${inputs.join(', ')})`);
    }
    if (t.other_output_tokens)
        parts.push(`${tokenText(t.other_output_tokens)} other output tokens`);
    return `Reference price: published token rates applied to what EvoLink reserves at submission for this input: ${parts.join(', ')}, each part rounded up.`;
}
const tierList = (prices) => prices.map(price => `${price.resolution}${price.quoted ? ' (quoted)' : ''}: ${price.amounts.credits} credits (about $${price.amounts.usd})`).join('; ');
function omniNotes(usage, ignored, prices) {
    const notes = [CONFIRM_REFERENCE];
    const videos = usage.input_videos;
    if (videos?.resolution_assumed) {
        notes.push(`EvoLink reads the input video's resolution at submission; the request does not give it, so the reference counts the highest, ${videos.resolution}, as EvoLink reserves when it cannot read it.${prices.length ? ` If the ${videos.count > 1 ? 'reference videos are' : 'input video is'} ${tierList(prices)}.` : ''}`);
        const output = usage.output.resolution;
        if (!usage.output.follows_input && output !== '360p')
            notes.push(`An input video at or below the output resolution, ${output}, reserves the same as one at ${output}.`);
    }
    if (usage.upscale?.source_assumed) {
        notes.push(`EvoLink reads the source video's resolution at submission; the reference counts the source that costs most for ${usage.upscale.target}, ${usage.upscale.source}.${prices.length ? ` If the source video is ${tierList(prices)}.` : ''}`);
    }
    if (videos && usage.route !== 'upscale')
        notes.push(`media_seconds counts ${videos.count > 1 ? 'each reference video' : 'the input video'} at ${videos.seconds} s (rounded up); EvoLink measures ${videos.count > 1 ? 'each' : 'it'} at submission.`);
    if (usage.output.follows_input)
        notes.push('quality is auto, so the output follows the input video\'s resolution.');
    if (usage.images)
        notes.push(`Each input image counts ${tokenText(OMNI_IMAGE_TOKENS)} input tokens.`);
    if (usage.prompt_tokens)
        notes.push('Prompt tokens are approximated; EvoLink counts them exactly at submission.');
    if (ignored.length > 0)
        notes.push(ignoredNote(ignored));
    return notes;
}
function qwenBasis(usage) {
    return `Reference price: published token rates applied to what EvoLink reserves at submission for this input: ${tokenText(usage.tokens.input_tokens)} input tokens and ${tokenText(usage.tokens.output_tokens)} output tokens for ${tokenText(usage.characters)} characters of text${usage.hot_fix_characters ? ' and hot_fix' : ''}, each part rounded up.`;
}
function qwenNotes(usage, ignored) {
    const notes = [CONFIRM_REFERENCE, 'EvoLink reserves the most each kind of character uses (Han characters, letters without case, lowercase letters, spaces and punctuation, other characters), so the task usually settles below the reference price.'];
    if (usage.expressive)
        notes.push('An instruction or a [tag] in the text raises the reserved output tokens.');
    if (usage.hot_fix_characters)
        notes.push('The text is counted after hot_fix.replace, as it is synthesized; hot_fix itself also counts toward the input tokens.');
    if (ignored.length > 0)
        notes.push(ignoredNote(ignored));
    return notes;
}
function minimaxBasis(usage) {
    const t = usage.per_image, o = usage.output, plural = (count, word) => `${count} ${word}${count > 1 ? 's' : ''}`;
    const output = o.size === 'pixels' ? `${o.width}×${o.height}` : `${o.resolution}${o.size === 'ratio' ? `, ${o.aspect_ratio}` : ', size auto'}`;
    const text = `about ${tokenText(usage.prompt_tokens)} prompt tokens${usage.prompt_enhanced ? ` and ${tokenText(MINIMAX_ENHANCE_TEXT_TOKENS)} for prompt enhancement` : ''}`;
    return `Reference price: published token rates applied to what EvoLink reserves at submission for this input. Per image: ${tokenText(t.image_output_tokens)} output tokens (${output}), ${tokenText(t.text_input_tokens)} text input tokens (${text})${t.image_input_tokens ? ` and ${tokenText(t.image_input_tokens)} image input tokens (${plural(usage.reference_images, 'reference image')})` : ''}, each part rounded up; ${plural(usage.images, 'image')}.`;
}
function minimaxNotes(usage, ignored) {
    const notes = [CONFIRM_REFERENCE];
    if (usage.reference_images) {
        notes.push(`Editing with image_urls always enhances the prompt, which adds ${tokenText(MINIMAX_ENHANCE_TEXT_TOKENS)} text input tokens per image.`);
        notes.push(`Each reference image counts ${tokenText(MINIMAX_REFERENCE_IMAGE_TOKENS)} input tokens, as EvoLink reserves without reading its size; a very wide or tall image can use more.`);
    }
    else if (usage.prompt_enhanced) {
        notes.push(`prompt_extend is on (the default), which adds ${tokenText(MINIMAX_ENHANCE_TEXT_TOKENS)} text input tokens per image; with size as a ratio or WIDTHxHEIGHT it can be set to false.`);
    }
    if (usage.output.size === 'pixels')
        notes.push(`An explicit size counts one output token per 32×32 pixels, at least ${tokenText(MINIMAX_OUTPUT_TOKENS_UP_TO_2K)}.`);
    if (usage.images > 1)
        notes.push(`n=${usage.images}: the reference covers ${usage.images} images; an image that fails (for example, a content check) is not billed.`);
    notes.push('Prompt tokens are approximated; EvoLink counts them exactly at submission.');
    if (ignored.length > 0)
        notes.push(ignoredNote(ignored));
    return notes;
}
function evaluate(node, params) {
    const nodes = node.args ?? [], at = (i) => evaluate(nodes[i], params), number = (i) => numeric(at(i));
    switch (node.op) {
        case 'constant': return node.value === 'true' ? true : node.value === 'false' ? false : node.value;
        case 'variable': {
            if (!Object.hasOwn(params, node.name))
                throw new QuoteError('quote_usage_required', `Provide measured or expected usage for ${node.name} in pricing_parameters.`, node.name);
            return typeof params[node.name] === 'number' ? decimal(params[node.name]) : params[node.name];
        }
        case 'lookup': {
            const key = evaluate(node.key, params), text = typeof key === 'object' ? exact(key) : String(key);
            if (!Object.hasOwn(node.values, text))
                fail('invalid_pricing_expression', 'No published pricing rule matches the selected parameter.');
            return decimal(node.values[text]);
        }
        case 'if': return boolean(at(0)) ? at(1) : at(2);
        case 'and': return nodes.every((_n, i) => boolean(at(i)));
        case 'or': return nodes.some((_n, i) => boolean(at(i)));
        case 'not': return !boolean(at(0));
        case 'eq':
        case 'neq': {
            const a = at(0), b = at(1);
            const equal = typeof a === 'boolean' || typeof b === 'boolean' ? a === b
                : typeof a === 'object' || typeof b === 'object' || /^-?\d+(?:\.\d+)?$/.test(String(a)) && /^-?\d+(?:\.\d+)?$/.test(String(b))
                    ? cmp(numeric(a), numeric(b)) === 0 : a === b;
            return node.op === 'eq' ? equal : !equal;
        }
        case 'lt': return cmp(number(0), number(1)) < 0;
        case 'lte': return cmp(number(0), number(1)) <= 0;
        case 'gt': return cmp(number(0), number(1)) > 0;
        case 'gte': return cmp(number(0), number(1)) >= 0;
        case 'add': return nodes.reduce((sum, _n, i) => add(sum, number(i)), rat(0n));
        case 'multiply': return nodes.reduce((product, _n, i) => mul(product, number(i)), rat(1n));
        case 'subtract': {
            const b = number(1);
            return add(number(0), rat(-b.n, b.d));
        }
        case 'divide': return div(number(0), number(1));
        case 'ceil':
        case 'floor': return rounded(number(0), node.op);
        case 'min':
        case 'max': return nodes.map((_n, i) => number(i)).reduce((a, b) => (cmp(a, b) < 0) === (node.op === 'min') ? a : b);
        case 'clamp': {
            const a = number(0), low = number(1), high = number(2);
            if (cmp(low, high) > 0)
                fail('invalid_pricing_expression', 'The pricing rule has invalid clamp bounds.');
            return cmp(a, low) < 0 ? low : cmp(a, high) > 0 ? high : a;
        }
        default: return fail('invalid_pricing_expression', 'The pricing rule uses an unsupported operation.');
    }
}
/** The rule's components for these parameters: each subtotal rounded and at least its minimum, times count. */
function chargeComponents(rule, declared, params, images, missing) {
    const components = [];
    const ids = new Set();
    let total = 0n;
    for (const c of rule.components) {
        if (ids.has(c.id) || !c.quantity_rule || !c.rounding)
            fail('invalid_pricing_expression', 'The pricing rule is incomplete or has duplicate components.');
        ids.add(c.id);
        for (const expr of [c.condition, c.quantity_rule, ...c.tiers.map(t => t.when)])
            if (expr)
                checkExpression(expr, declared);
        if (!['per_quantity', 'per_tier', 'per_component_subtotal'].includes(c.rounding.point)
            || !['half_up', 'ceil', 'floor'].includes(c.rounding.mode))
            fail('invalid_pricing_expression', 'The pricing rule has unsupported rounding.');
        try {
            if (c.condition && !boolean(evaluate(c.condition, params)))
                continue;
            const matches = c.tiers.filter(t => t.when && boolean(evaluate(t.when, params)));
            if (matches.length > 1)
                fail('invalid_pricing_expression', 'Multiple pricing tiers match the request.');
            const selected = matches[0] ?? c;
            if (selected.pricing_status !== 'available')
                fail('pricing_rules_unavailable', 'A required pricing component is unavailable.');
            const q = numeric(evaluate(c.quantity_rule, params)), m = decimal(matches[0]?.multiplier ?? '1'), rate = decimal(selected.rate.uc);
            if (q.n < 0n)
                fail('invalid_pricing_expression', 'The pricing rule produces a negative quantity.');
            // Catalog tier.rate already includes its multiplier. Applying it twice overcharges.
            const billed = mul(q, m);
            const subtotal = c.rounding.point === 'per_quantity' ? mul(rounded(billed, c.rounding.mode), div(rate, m))
                : c.rounding.point === 'per_tier' ? mul(q, rounded(rate, c.rounding.mode))
                    : rounded(mul(q, rate), c.rounding.mode);
            const minimum = decimal(selected.minimum_charge.uc);
            const charge = cmp(subtotal, minimum) < 0 ? minimum : subtotal;
            if (charge.d !== 1n || charge.n < 0n || charge.n > BigInt(Number.MAX_SAFE_INTEGER))
                fail('invalid_pricing_expression', 'The pricing rule does not produce a supported integer UC charge.');
            total += charge.n * images;
            components.push({ id: c.id, sku_id: selected.sku_id, quantity: exact(mul(q, rat(images))), billed_quantity: exact(mul(billed, rat(images))),
                subtotal_uc: String(charge.n * images), minimum_charge_applied: cmp(subtotal, minimum) < 0 });
        }
        catch (error) {
            if (error instanceof QuoteError && error.code === 'quote_usage_required' && error.param) {
                missing.add(error.param);
                // The evaluator stops at the first absent usage; name every one this component reads.
                for (const name of componentReads(c))
                    if (!Object.hasOwn(params, name))
                        missing.add(name);
            }
            else
                throw error;
        }
    }
    return { components, total };
}
/** The most inputs one estimate_cost or generate_* call takes (`inputs`), all for one model. */
export const MAX_BATCH_ITEMS = 50;
/** `batch_items` marks an approval of a whole batch (inputs); it never approves a single input, nor the reverse. */
export const ApprovedRulesEstimate = z.object({ source: z.literal('pricing_rules'), price_scope: z.enum(['public_default', 'account']),
    model_id: z.string().min(1).max(100), request_hash: z.string().regex(/^[a-f0-9]{64}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/), total_uc: z.string().max(32).regex(/^\d+$/),
    expires_at: z.string().datetime({ offset: true }), batch_items: z.number().int().min(1).max(MAX_BATCH_ITEMS).optional() }).strict();
function economicRules(rule) {
    // Identity aliases, freshness and configuration timestamps do not change the approved price.
    const { aliases: _aliases, ...economic } = rule;
    return { ...economic, components: rule.components.map(({ effective_at, official_rate, ...c }) => ({ ...c,
            tiers: c.tiers.map(({ effective_at, official_rate, ...t }) => t) })) };
}
/**
 * The pricing parameters that change what is priced. A value that the generation input, a default or the service
 * gives anyway is left out, so passing back the pricing_parameters an estimate showed is the same request. When the
 * parameters cannot be resolved without the given ones, every given one counts.
 */
export function explicitPricingParameters(rule, entry, input, pricingParameters, mediaSeconds) {
    const given = Object.entries(pricingParameters ?? {}).filter(([, value]) => value !== undefined);
    if (!given.length)
        return {};
    let resolved;
    try {
        resolved = prepareQuoteParameters(rule, entry, input, {}, mediaSeconds, true);
    }
    catch {
        return Object.fromEntries(given);
    }
    return Object.fromEntries(given.filter(([name, value]) => resolved[name] === undefined || String(resolved[name]) !== String(value)));
}
const isAutoDuration = (node) => {
    const n = node;
    return n?.op === 'eq' && Array.isArray(n.args) && n.args.length === 2
        && n.args.some(arg => arg.op === 'variable' && arg.name === 'duration')
        && n.args.some(arg => arg.op === 'constant' && String(arg.value) === '-1');
};
/** Whether the rule reads duration_seconds anywhere but in the branch for an automatic duration (duration = -1). */
function readsDurationSecondsOutsideAuto(node, auto = false) {
    if (Array.isArray(node))
        return node.some(item => readsDurationSecondsOutsideAuto(item, auto));
    if (!node || typeof node !== 'object')
        return false;
    const n = node;
    if (n.op === 'variable' && n.name === 'duration_seconds')
        return !auto;
    if (n.op === 'if' && Array.isArray(n.args) && n.args.length === 3 && isAutoDuration(n.args[0])) {
        return readsDurationSecondsOutsideAuto(n.args[1], true) || readsDurationSecondsOutsideAuto(n.args[2], auto);
    }
    return Object.values(n).some(value => readsDurationSecondsOutsideAuto(value, auto));
}
/**
 * The parameters an estimate shows. A rule that reads duration_seconds only for an automatic duration (Seedance 2.5:
 * duration -1) does not use its default (30) for a set duration, so it is not shown then.
 */
export function shownQuoteParameters(rule, params) {
    if (!('duration_seconds' in params) || params.duration === undefined || String(params.duration) === '-1')
        return params;
    if (readsDurationSecondsOutsideAuto(rule.components))
        return params;
    return Object.fromEntries(Object.entries(params).filter(([name]) => name !== 'duration_seconds'));
}
/** countPromptTokens replaces the approximate prompt token count, for comparing with the gateway's exact count. */
export function calculateRulesEstimate(body, entry, input, options = {}) {
    const rule = 'model' in body ? body.model : body.models.find(model => model.model_id === entry.id);
    if (!rule || rule.model_id !== entry.id.toLowerCase() || rule.modality !== entry.kind || rule.policy_source !== 'published' || rule.pricing_status !== 'available') {
        fail('pricing_rules_unavailable', 'This model has no available published media pricing policy.');
    }
    // The approval and every note say whose prices these are: the body's own scope, never an assumption.
    const scope = body.meta.price_scope;
    const prepared = prepareSeedanceInput(entry, qwenTTSInput(entry.id, input));
    if (prepared.errors.length) {
        const issue = prepared.errors[0];
        const check = issue.param === 'duration' ? 'range' : issue.param === 'quality' ? 'conflict'
            : issue.param === 'model_params.web_search' ? 'type' : 'shape';
        throw new QuoteError('invalid_quote_parameter', `${issue.param} ${issue.problem}`, issue.param, 'caller', check, 'seedance');
    }
    const effectiveInput = prepared.input;
    const declared = new Set((rule.parameters ?? []).map(p => p.name));
    const id = entry.id.toLowerCase();
    // GPT Image, Gemini Omni, Qwen TTS and MiniMax H3 Image token models never use token counts from pricing_parameters: the reference counts
    // what the gateway reserves for this input. Leaving them out of the request hash lets a generation pass them or not.
    const ignored = isTokenImageModel(id) || isOmniTokenModel(id) || isQwenTTSModel(id) || isMiniMaxH3ImageModel(id)
        ? Object.keys(options.pricingParameters ?? {}).filter(name => declared.has(name) && (/tokens$/.test(name) || svgAuthor(name))).sort() : [];
    const pricingParameters = ignored.length
        ? Object.fromEntries(Object.entries(options.pricingParameters).filter(([name]) => !ignored.includes(name))) : options.pricingParameters;
    const reserved = reservation(rule, entry, effectiveInput, options.countPromptTokens, options.mediaSeconds);
    const params = { ...prepareQuoteParameters(rule, entry, reserved?.gpt ? withoutSvgAuthor(effectiveInput) : effectiveInput, pricingParameters, options.mediaSeconds, true), ...reserved?.parameters };
    // The gateway rounds each image's charge up separately, then reserves it once per image.
    const images = BigInt(reserved?.gpt?.images ?? reserved?.minimax?.images ?? 1);
    const missing = new Set();
    // An Omni input video is billed by its length, which only media_seconds gives before submission.
    if (reserved?.needs)
        missing.add('media_seconds');
    const searchCharges = searchUsage(entry, effectiveInput).filter(search => search.enabled).map(search => {
        const component = rule.components.find(item => item.role === search.role);
        if (!declared.has(search.parameter) || !component || component.pricing_status !== 'available' || component.unit !== 'search'
            || component.billing_unit_size !== 1 || component.tiers.length) {
            fail('search_pricing_unavailable', 'The enabled search unit price could not be verified. Refresh pricing before generation.');
        }
        const expected = options.pricingParameters?.[search.parameter] !== undefined || effectiveInput[search.parameter] !== undefined;
        if (!expected)
            missing.add(search.parameter);
        return { role: search.role, input_parameter: search.input_parameter, usage_parameter: search.parameter,
            assumed_count: String(params[search.parameter]), assumption: expected ? 'expected_usage' : 'zero_searches',
            actual_count_known: false, unit: 'search', unit_price_amounts: amountsForUC(component.rate.uc) };
    });
    const { components, total } = reserved?.needs ? { components: [], total: 0n } : chargeComponents(rule, declared, params, images, missing);
    if (total > BigInt(Number.MAX_SAFE_INTEGER))
        fail('invalid_pricing_expression', 'The estimated charge exceeds its supported range.');
    // No media generation is free. A total of 0 comes only from usage given as 0, which then counts as missing, so
    // nothing is quoted; if no usage explains it, the published rules themselves price the input at 0.
    const zeroUsage = total === 0n ? [...declared].filter(name => isUsageParameter(entry.id, name) && pricingParameters?.[name] !== undefined
        && /^\d+(?:\.\d+)?$/.test(String(params[name])) && compareDecimal(String(params[name]), '0') === 0
        && rule.components.some(c => componentReads(c).has(name))) : [];
    if (total === 0n) {
        if (!zeroUsage.length && !missing.size)
            fail('pricing_rules_unavailable', 'The published rules price this input at 0, and no media generation is free, so it cannot be quoted.');
        for (const name of zeroUsage)
            missing.add(name);
        components.length = 0;
    }
    const amounts = amountsForUC(String(total));
    // The pricing_parameters an estimate showed, passed back to generate_*, change nothing: only values that alter what
    // is priced count. The hash over every given parameter (what 1.13.0 and earlier issued) is still accepted.
    const explicit = explicitPricingParameters(rule, entry, effectiveInput, pricingParameters, options.mediaSeconds);
    const requestHash = quoteRequestHash(entry.id, effectiveInput, options.mediaSeconds, explicit);
    const requestHashes = { exact: quoteRequestHash(entry.id, effectiveInput, options.mediaSeconds, pricingParameters),
        withoutPricingParameters: quoteRequestHash(entry.id, effectiveInput, options.mediaSeconds, {}),
        // Each explicit parameter left out in turn: an approval matching one was estimated without that parameter.
        withoutEach: Object.fromEntries(Object.keys(explicit).map(name => [name, quoteRequestHash(entry.id, effectiveInput, options.mediaSeconds, Object.fromEntries(Object.entries(explicit).filter(([key]) => key !== name)))])) };
    const approval = { source: 'pricing_rules', price_scope: scope, model_id: entry.id,
        request_hash: requestHash, total_uc: amounts.uc, expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
        fingerprint: quoteRequestHash(entry.id, { rules: economicRules(rule), parameters: params,
            exchange_rate_version: body.meta.exchange_rate_version, components, missing: [...missing].sort(), total_uc: amounts.uc,
            ...(reserved?.gpt || reserved?.omni || reserved?.qwen || reserved?.minimax ? { reservation: reserved.gpt ?? reserved.omni ?? reserved.qwen ?? reserved.minimax } : {}) }) };
    const status = missing.size ? components.length ? 'partial' : 'needs_input'
        : reserved?.gpt || reserved?.omni || reserved?.qwen || reserved?.minimax ? 'token_billed' : 'estimated';
    const missingUsage = [...missing].sort(), usageHelp = helpLines(missingUsage, entry, rule, declared, scope);
    const usage = reserved?.gpt, omni = reserved?.omni, qwen = reserved?.qwen, minimax = reserved?.minimax;
    // A GPT Image 2.6 SVG: what the author model's components add, for its note.
    const authorComponents = new Set(rule.components.filter(c => /^svg_(?:input|output):/.test(c.role)).map(c => c.id));
    const svgAuthorPart = usage?.svg_author ? amountsForUC(String(components.filter(c => authorComponents.has(c.id))
        .reduce((sum, c) => sum + BigInt(c.subtotal_uc), 0n))) : undefined;
    // An Omni input video of unknown resolution counts the highest; the same input at each resolution EvoLink can read
    // it at, for the notes. lower_input keeps the one lower price 1.12.0 gave (720p; an upscale: the cheaper source).
    const tierPrices = [];
    if (omni && status === 'token_billed') {
        const quoted = omniQuotedTier(omni);
        for (const tier of omniInputTiers(omni)) {
            const alternative = omniReservation(id, effectiveInput, options.mediaSeconds, { countPromptTokens: options.countPromptTokens, inputTier: tier });
            if ('needs' in alternative)
                continue;
            const cost = chargeComponents(rule, declared, { ...params, ...omniParameters(rule, alternative) }, 1n, new Set()).total;
            tierPrices.push({ resolution: tier, amounts: amountsForUC(String(cost)), ...(tier === quoted ? { quoted: true } : {}) });
        }
    }
    const lowerTier = omni && status === 'token_billed' ? omniLowerInputTier(omni) : undefined;
    const lowerPrice = tierPrices.find(price => price.resolution === lowerTier);
    const lower = lowerPrice && BigInt(lowerPrice.amounts.uc) < total ? { tier: lowerPrice.resolution, amounts: lowerPrice.amounts } : undefined;
    const estimate = { status,
        // Nothing could be priced: a zero amount would read as free.
        ...(status === 'needs_input' ? {} : { min_usd: Number(amounts.usd), max_usd: Number(amounts.usd),
            min_credits: Number(amounts.credits), max_credits: Number(amounts.credits) }),
        total_known: status === 'estimated',
        basis: [status === 'token_billed' && usage
                ? `Reference price: published token rates applied to what EvoLink reserves at submission for this input. Per image: ${usage.per_image.image_output_tokens.toLocaleString('en-US')} output tokens (${usage.output.width}×${usage.output.height}${usage.output.gif ? `, ${usage.output.gif.frames} GIF frames` : ''}, quality ${usage.output.quality}), about ${usage.per_image.text_input_tokens.toLocaleString('en-US')} prompt tokens and ${usage.per_image.image_input_tokens.toLocaleString('en-US')} reference-image tokens, each part rounded up; ${usage.images} image${usage.images > 1 ? 's' : ''}.${usage.svg_author ? ` SVG author model ${usage.svg_author.model}: ${tokenText(usage.svg_author.input_tokens)} input and ${tokenText(usage.svg_author.output_tokens)} output tokens, each part rounded up.` : ''}`
                : status === 'token_billed' && omni ? omniBasis(omni)
                    : status === 'token_billed' && qwen ? qwenBasis(qwen)
                        : status === 'token_billed' && minimax ? minimaxBasis(minimax)
                            : 'Published full pricing rules evaluated for the supplied generation parameters; exact UC rounding and component minimums.'],
        ...(missing.size ? { uncheckable_reason: 'usage', missing_usage: missingUsage, usage_help: usageHelp } : {}),
        ...(status === 'token_billed' && usage ? { reference_usage: usage } : {}),
        ...(status === 'token_billed' && omni ? { reference_usage: { ...omni, ...(lower ? { lower_input: { resolution: lower.tier, amounts: lower.amounts } } : {}),
                ...(tierPrices.length ? { input_resolution_prices: tierPrices } : {}) } } : {}),
        ...(status === 'token_billed' && qwen ? { reference_usage: qwen } : {}),
        ...(status === 'token_billed' && minimax ? { reference_usage: minimax } : {}),
        possible_extras: status === 'partial' ? usageHelp.map(line => `Additional charge depends on ${line}`) : [],
        notes: [scope === 'account' ? ACCOUNT_PRICES_NOTE : PUBLIC_PRICES_NOTE, ...status === 'needs_input'
                ? ['No total is quoted until the missing usage is known, and generate_* will not submit before then.']
                : status === 'token_billed' && usage ? reservationNotes(usage, ignored, svgAuthorPart)
                    : status === 'token_billed' && omni ? omniNotes(omni, ignored, tierPrices)
                        : status === 'token_billed' && qwen ? qwenNotes(qwen, ignored)
                            : status === 'token_billed' && minimax ? minimaxNotes(minimax, ignored)
                                : ['Confirm the estimated cost before generation. Actual billed usage and final charges may differ.']] };
    if (zeroUsage.length)
        estimate.notes.push(`pricing_parameters ${zeroUsage.join(', ')} given as 0 would price this generation at 0. No media generation is free, so ${zeroUsage.length > 1 ? 'they count' : 'it counts'} as missing.`);
    if (ignored.length && status !== 'token_billed')
        estimate.notes.push(`pricing_parameters ${ignored.join(', ')} ${ignored.length > 1 ? 'are' : 'is'} not used for this model.`);
    for (const p of rule.parameters ?? []) {
        const assumed = CONSERVATIVE_QUOTE_PARAMETERS[`${entry.id.toLowerCase()} ${p.name}`];
        if (assumed && options.pricingParameters?.[p.name] === undefined)
            estimate.notes.push(assumed.note);
    }
    if (searchCharges.length) {
        estimate.search_charges = searchCharges;
        for (const search of searchCharges) {
            const label = search.role === 'web_search' ? 'Web search' : 'Image search';
            const assumption = search.assumption === 'zero_searches'
                ? `The displayed subtotal assumes 0 searches and excludes ${label.toLowerCase()} fees.`
                : `${search.usage_parameter}=${search.assumed_count} is expected usage, not a limit; actual searches and final charges may differ, including when the expected count is zero.`;
            estimate.notes.push(`${label} is enabled. ${assumption} Each actual search costs ${search.unit_price_amounts.credits} credits (approximately $${search.unit_price_amounts.usd}) at ${ratesOf(scope)}. A single task may perform no searches or multiple searches. Actual search count and search fees are unknown before generation and depend on the task and the model's search strategy.`);
        }
    }
    return { approval, estimate, amounts, components, parameters: params, shownParameters: shownQuoteParameters(rule, params), requestHashes, rule };
}
/** While the platform limits pricing requests, an estimate may use rules read this recently; generation never does. */
export const RECENT_RULES_MAX_AGE_MS = 10 * 60_000;
/** The longest Retry-After a generation waits, once, before its fresh rules read gives up. */
export const GENERATION_RULES_RETRY_MAX_SECONDS = 5;
/** Generation takes a model's rules read this recently (and still fresh), so a batch of submissions reads them once. */
export const GENERATION_RULES_REUSE_MS = 10_000;
const limited = (error) => error instanceof PricingRulesError && error.code === 'rate_limit_exceeded';
function pause(ms, signal) {
    return new Promise(resolve => {
        const timer = setTimeout(done, ms);
        function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
        signal?.addEventListener('abort', done, { once: true });
        if (signal?.aborted)
            done();
    });
}
async function generationRules(model, signal, account) {
    try {
        return (await getPricingRules({ model, view: 'full' }, { fresh: true, maxAgeMs: GENERATION_RULES_REUSE_MS, account })).body;
    }
    catch (error) {
        const wait = limited(error) ? error.retryAfter ?? 1 : undefined;
        if (wait === undefined || wait > GENERATION_RULES_RETRY_MAX_SECONDS || signal?.aborted)
            throw error;
        await pause(wait * 1000, signal);
        if (signal?.aborted)
            throw error;
        return (await getPricingRules({ model, view: 'full' }, { fresh: true, maxAgeMs: GENERATION_RULES_REUSE_MS, account })).body;
    }
}
/** EVOLINK_MCP_ACCOUNT_PRICING=0 turns account prices off: every price is read from the public default rules, as in earlier versions. */
export function accountPricingEnabled() {
    return (process.env.EVOLINK_MCP_ACCOUNT_PRICING ?? '').trim() !== '0';
}
/**
 * How this request reads the prices its own account is billed, or undefined when it carries no credential or account
 * pricing is switched off; prices are then the public default ones. The account read goes to the gateway that every
 * other authenticated call uses, with the same credential. A signed-in connection is cached under its verified
 * account, whose token changes every few minutes; an API key under a digest of the key.
 */
export function accountRulesAccess(config) {
    if (!config || !accountPricingEnabled())
        return undefined;
    let headers;
    try {
        headers = gatewayAuthHeaders();
    }
    catch {
        return undefined;
    }
    if (!headers.Authorization)
        return undefined;
    const owner = currentRequestCredentials()?.uploadOwner;
    const identity = owner ? `sub:${owner}` : `key:${createHash('sha256').update(headers.Authorization).digest('hex').slice(0, 32)}`;
    return { baseUrl: config.baseUrl, headers, identity };
}
function accountFallback(error) {
    if (error instanceof PricingRulesError)
        return { reason: error.status === 404 ? 'not_offered' : 'unavailable', code: error.code };
    return { reason: 'unavailable', code: error instanceof RequestTimeoutError ? 'pricing_rules_timeout' : 'pricing_rules_network_error' };
}
/** Said with a price that fell back to the public default rules because the account's own could not be read. */
export function accountFallbackNote(fallback) {
    return fallback?.reason === 'unavailable'
        ? `Your account's own prices could not be read just now (${fallback.code}), so this uses public default prices; what your account is charged may differ. generate_* reads the prices again before submitting and asks for a new approval if the price rose.`
        : undefined;
}
/**
 * One read of a model's rules from one source. Generation reads them fresh, or takes them from a read in the last
 * 10 seconds. A hosted estimate (`reuseRules`) reuses them until their fresh_until and, for the public rules only,
 * may use rules read in the last 10 minutes while the platform limits requests (`readAt`); any other estimate reads
 * them fresh.
 */
async function readRules(model, options, account) {
    if (options.purpose === 'generation')
        return { body: await generationRules(model, options.signal, account) };
    if (!options.reuseRules)
        return { body: (await getPricingRules({ model, view: 'full' }, { fresh: true, account })).body };
    try {
        return { body: (await getPricingRules({ model, view: 'full' }, { reuseUntilFresh: true, account })).body };
    }
    catch (error) {
        const recent = !account && limited(error) ? recentModelRules(model, RECENT_RULES_MAX_AGE_MS) : undefined;
        if (!recent)
            throw error;
        return { body: recent.body, readAt: new Date(recent.fetchedAt).toISOString() };
    }
}
/**
 * The rules an estimate or a generation evaluates; a batch reads them once for all its inputs. With `account`, the
 * caller's own prices are read first. When that read does not succeed the public default rules are read instead and
 * `accountFallback` says why, so a gateway without account prices, or one that cannot serve them for a moment, still
 * prices the request; a caller that stopped waiting gets no second read. The body's own price_scope always says which
 * prices it carries.
 */
export async function readPricingRulesFor(entry, options = {}) {
    const model = entry.id.toLowerCase();
    return readAccountRulesFirst(options.account, account => readRules(model, options, account), options.signal);
}
/**
 * Runs `read` for the account's own prices and, when that does not succeed, for the public default ones, reporting
 * why in `accountFallback`. Without `account` it is one public read. A caller that stopped waiting gets no second read.
 */
export async function readAccountRulesFirst(account, read, signal) {
    if (!account)
        return read();
    try {
        return await read(account);
    }
    catch (error) {
        if (signal?.aborted || currentRequestCredentials()?.http?.signal?.aborted
            || error instanceof PricingRulesError && error.code === 'interrupted')
            throw error;
        return { ...await read(), accountFallback: accountFallback(error) };
    }
}
/** Said with an estimate made from rules read earlier, while the platform limits pricing requests. */
export function recentRulesNote(readAt) {
    return `The platform is limiting pricing requests right now, so this estimate uses the published rules read at ${readAt}. generate_* reads the current rules again before submitting and asks for a new approval if the price rose.`;
}
/** An approval from cached or recent rules can never submit at a higher price: checkRulesApproval refuses it. */
export async function createRulesEstimate(entry, input, options = {}) {
    const { body, readAt, accountFallback: fallback } = await readPricingRulesFor(entry, options);
    const result = calculateRulesEstimate(body, entry, input, options);
    const fallbackNote = accountFallbackNote(fallback);
    if (fallbackNote)
        result.estimate.notes.push(fallbackNote);
    if (readAt)
        result.estimate.notes.push(recentRulesNote(readAt));
    return { ...result, ...(readAt ? { rules_read_at: readAt } : {}), ...(fallback ? { account_fallback: fallback } : {}) };
}
/**
 * What a result reports as `account_pricing` when the request could read its account's prices: `used`, or why the
 * public default prices were used instead. A request without a credential reports nothing.
 */
export function accountPricingStatus(account, scope, fallback) {
    if (!account)
        return {};
    return { account_pricing: scope === 'account' ? 'used' : fallback?.reason ?? 'unavailable' };
}
/** An approval holds until its expires_at, not at it. */
export const approvalExpired = (approval, now = Date.now()) => Date.parse(approval.expires_at) <= now;
/**
 * Only a higher total needs a new approval: an unchanged or lower one submits, whatever else changed in the rules. A
 * partial estimate's total is the part it prices.
 */
export const priceRose = (approval, fresh) => BigInt(fresh.total_uc) > BigInt(approval.total_uc);
/** Said when the approval matches this request without its pricing_parameters: the estimate was made without them. */
export const PRICING_PARAMETERS_NOT_ESTIMATED = 'The approved estimate was made without these pricing_parameters. Submit again with the same input and pricing_quote and without pricing_parameters: that is the request the user approved.';
/** Said when the approval matches this request without one of its pricing_parameters. */
export const pricingParameterNotEstimated = (name) => `The approved estimate was made without pricing_parameters.${name}. Submit again without it, with the same input and pricing_quote: that is the request the user approved.`;
export const QUOTE_INPUT_CHANGED = 'The generation input, media_seconds or pricing_parameters differ from the approved estimate. Pass exactly what was given to estimate_cost (pricing_parameters only if it was given some), or estimate this request again and obtain approval.';
/**
 * An approval holds for the same input until its expires_at, at the approved price or lower. A changed input
 * (quote_input_changed), an expired approval (quote_expired) or a higher price (price_changed) needs a new estimate and
 * approval.
 */
export function checkRulesApproval(approval, fresh) {
    if (approval.batch_items !== undefined) {
        fail('quote_input_changed', 'This pricing_quote approves a batch (inputs); pass the same inputs, or estimate this input and obtain approval.');
    }
    const sameRequest = approval.request_hash === fresh.approval.request_hash || approval.request_hash === fresh.requestHashes.exact;
    if (!sameRequest || approval.model_id !== fresh.approval.model_id) {
        if (approval.model_id === fresh.approval.model_id) {
            if (approval.request_hash === fresh.requestHashes.withoutPricingParameters) {
                throw new QuoteError('quote_input_changed', PRICING_PARAMETERS_NOT_ESTIMATED, 'pricing_parameters', 'caller');
            }
            const added = Object.entries(fresh.requestHashes.withoutEach).find(([, hash]) => hash === approval.request_hash)?.[0];
            if (added)
                throw new QuoteError('quote_input_changed', pricingParameterNotEstimated(added), 'pricing_parameters', 'caller');
        }
        fail('quote_input_changed', QUOTE_INPUT_CHANGED);
    }
    if (approvalExpired(approval))
        fail('quote_expired', `The approved estimate expired at ${approval.expires_at}. Estimate again and obtain approval.`);
    if (priceRose(approval, fresh.approval))
        fail('price_changed', 'The estimated price rose after it was approved. Estimate again and obtain approval.');
}
