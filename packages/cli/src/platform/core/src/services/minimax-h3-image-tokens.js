// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { QuoteError } from './pricing-quote-client.js';
import { approximatePromptTokens } from './gpt-image-tokens.js';
// The tokens the gateway reserves for a MiniMax H3 Image task at submission. Ported from GroAPI
// (feat/task-microservice-split) common/minimax_h3_image.go (ParseMiniMaxH3ImageSize, NormalizeMiniMaxH3ImageResolution,
// MiniMaxH3ImagePreBillingTokens) and controller/unified_images_minimax_h3_image.go (validateMiniMaxH3ImageRequest and
// calculateMiniMaxH3ImagePreBillingCost). Each requested image reserves its output, its text input and its reference
// images; each part is rounded up at its rate and the sum is reserved once per image. The task settles at the tokens the
// upstream reports.
const MODELS = new Set(['minimax-h3-image', 'minimax-h3-image-highspeed']);
/** MiniMax H3 Image and its Highspeed variant: the same parameters and token counts, each at its own rates. */
export const isMiniMaxH3ImageModel = (model) => MODELS.has(model.trim().toLowerCase());
const MAX_REFERENCES = 16, MAX_IMAGES = 10, MAX_PROMPT_CHARACTERS = 32_000, MAX_PROMPT_BYTES = 65_000;
const MIN_PIXELS = 655_360, MAX_PIXELS = 20_000_000, MAX_ASPECT = 3, MAX_RATIO_TERM = 300, PATCH = 32;
/** Output tokens reserved per image up to 2K and at 4K; an explicit pixel size counts one per 32×32 patch, at least the 2K count. */
export const MINIMAX_OUTPUT_TOKENS_UP_TO_2K = 4_200, MINIMAX_OUTPUT_TOKENS_4K = 16_800;
/** Text tokens prompt enhancement adds to each image. An edit (with reference images) always enhances the prompt. */
export const MINIMAX_ENHANCE_TEXT_TOKENS = 4_000;
/** Reserved per reference image and output image: the gateway does not read the image's size. */
export const MINIMAX_REFERENCE_IMAGE_TOKENS = 10_300;
function invalid(param, message, check = 'range') {
    throw new QuoteError('invalid_quote_parameter', message, param, undefined, check, 'minimax_h3_image');
}
/** strings.TrimSpace: Go's white space (unicode.IsSpace), which differs from String.prototype.trim at U+0085 and U+FEFF. */
const GO_SPACE = '[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const goTrim = (value) => value.replace(new RegExp(`^${GO_SPACE}+|${GO_SPACE}+$`, 'g'), '');
const text = (param, value) => value === undefined || value === null ? '' : typeof value === 'string' ? value
    : invalid(param, `${param} must be a string.`, 'type');
const filled = (value) => typeof value === 'string' && value !== '';
/** parseFlexibleStringArray: one string or a list; empty and non-string entries are not read. */
const links = (value) => Array.isArray(value) ? value.filter(filled) : filled(value) ? [value] : [];
const aspectFits = (a, b) => a <= MAX_ASPECT * b && b <= MAX_ASPECT * a;
/** ParseMiniMaxH3ImageSize: auto (or nothing), a ratio X:Y with terms 1–300, or WIDTHxHEIGHT of 655,360–20,000,000 pixels; at most 3:1. */
function imageSize(raw) {
    const trimmed = goTrim(raw);
    if (trimmed === '' || trimmed.toLowerCase() === 'auto')
        return { mode: 'auto' };
    const ratio = /^(\d{1,4}):(\d{1,4})$/.exec(trimmed);
    if (ratio) {
        const x = Number(ratio[1]), y = Number(ratio[2]);
        if (x < 1 || y < 1 || x > MAX_RATIO_TERM || y > MAX_RATIO_TERM || !aspectFits(x, y)) {
            invalid('size', `size ${raw} needs ratio terms from 1 to ${MAX_RATIO_TERM} and a ratio within 1:${MAX_ASPECT} and ${MAX_ASPECT}:1.`);
        }
        return { mode: 'ratio', aspect_ratio: `${x}:${y}` };
    }
    const pixels = /^(\d{1,6})[xX×*](\d{1,6})$/.exec(trimmed);
    if (pixels) {
        const width = Number(pixels[1]), height = Number(pixels[2]), area = width * height;
        if (width <= 0 || height <= 0 || area < MIN_PIXELS || area > MAX_PIXELS || !aspectFits(width, height)) {
            invalid('size', `size ${raw} needs ${MIN_PIXELS.toLocaleString('en-US')}–${MAX_PIXELS.toLocaleString('en-US')} pixels and a ratio within 1:${MAX_ASPECT} and ${MAX_ASPECT}:1.`);
        }
        return { mode: 'pixels', width, height };
    }
    return invalid('size', `size ${raw} must be auto, a ratio like 16:9 or WIDTHxHEIGHT.`, 'shape');
}
/** NormalizeMiniMaxH3ImageResolution: resolution, else quality (its alias), else 2K; case-insensitive. */
function imageResolution(input) {
    const raw = goTrim(text('resolution', input.resolution)) || goTrim(text('quality', input.quality));
    if (raw === '')
        return '2K';
    const tier = raw.toUpperCase();
    if (tier === '1K' || tier === '2K' || tier === '4K')
        return tier;
    return invalid('resolution', `resolution ${raw} must be 1K, 2K or 4K.`, 'enum');
}
/**
 * The tokens the gateway reserves at submission for this input, after the checks it makes first. countPromptTokens
 * replaces the approximate prompt count when the exact o200k_base count is known.
 */
export function miniMaxH3ImageReservation(input, countPromptTokens = approximatePromptTokens) {
    const prompt = text('prompt', input.prompt);
    if (goTrim(prompt) === '')
        invalid('prompt', 'prompt is required.', 'required');
    const characters = [...prompt].length;
    if (characters > MAX_PROMPT_CHARACTERS)
        invalid('prompt', `prompt has ${characters} characters; the limit is ${MAX_PROMPT_CHARACTERS}.`, 'length');
    const size = imageSize(text('size', input.size));
    const resolution = imageResolution(input);
    const format = goTrim(text('output_format', input.output_format)).toLowerCase();
    if (!['', 'jpeg', 'jpg', 'png', 'webp'].includes(format))
        invalid('output_format', `output_format ${input.output_format} must be jpeg, png or webp.`, 'enum');
    const n = input.n === undefined || input.n === null || input.n === 0 ? 1
        : Number.isInteger(input.n) ? input.n : invalid('n', 'n must be a whole number.', 'type');
    if (n < 1 || n > MAX_IMAGES)
        invalid('n', `n must be from 1 to ${MAX_IMAGES}.`);
    if (goTrim(text('mask_url', input.mask_url)) !== '')
        invalid('mask_url', 'mask_url is not supported by this model.', 'conflict');
    if (goTrim(text('background', input.background)).toLowerCase() === 'transparent')
        invalid('background', 'a transparent background is not supported by this model.', 'conflict');
    const references = [...links(input.image_url), ...links(input.image_urls)];
    for (const link of references) {
        if (!link.startsWith('http://') && !link.startsWith('https://'))
            invalid('image_urls', 'each image URL must start with http:// or https://.', 'shape');
    }
    if (references.length > MAX_REFERENCES)
        invalid('image_urls', `at most ${MAX_REFERENCES} reference images are allowed, got ${references.length}.`, 'count');
    if (input.prompt_extend !== undefined && input.prompt_extend !== null && typeof input.prompt_extend !== 'boolean') {
        invalid('prompt_extend', 'prompt_extend must be a boolean.', 'type');
    }
    if (input.prompt_extend === false) {
        if (references.length)
            invalid('prompt_extend', 'prompt_extend false is not supported for editing (with image_urls).', 'conflict');
        if (size.mode === 'auto')
            invalid('prompt_extend', 'prompt_extend false needs size as a ratio or WIDTHxHEIGHT.', 'conflict');
    }
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES)
        invalid('prompt', `prompt is longer than ${MAX_PROMPT_BYTES} bytes.`, 'length');
    // An edit is always enhanced, whatever prompt_extend says.
    const enhanced = input.prompt_extend !== false || references.length > 0;
    const promptTokens = countPromptTokens(prompt);
    const outputTokens = size.mode === 'pixels'
        ? Math.max(MINIMAX_OUTPUT_TOKENS_UP_TO_2K, Math.ceil(size.width / PATCH) * Math.ceil(size.height / PATCH))
        : resolution === '4K' ? MINIMAX_OUTPUT_TOKENS_4K : MINIMAX_OUTPUT_TOKENS_UP_TO_2K;
    return {
        per_image: { image_output_tokens: outputTokens, text_input_tokens: promptTokens + (enhanced ? MINIMAX_ENHANCE_TEXT_TOKENS : 0),
            image_input_tokens: references.length * MINIMAX_REFERENCE_IMAGE_TOKENS },
        images: n,
        output: { resolution, size: size.mode, ...(size.mode === 'ratio' ? { aspect_ratio: size.aspect_ratio } : {}),
            ...(size.mode === 'pixels' ? { width: size.width, height: size.height } : {}) },
        prompt_tokens: promptTokens, prompt_enhanced: enhanced, reference_images: references.length,
    };
}
