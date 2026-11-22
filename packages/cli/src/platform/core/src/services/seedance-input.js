// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
/**
 * Seedance 2.5 Flash takes the request of the matching 2.5 route (GroAPI controller/unified_videos.go
 * validateSeedance25Request), except that it has no draft mode and its text-to-video refuses web search without the
 * content filter.
 */
const FLASH_MODELS = new Set([
    'seedance-2.5-flash-text-to-video',
    'seedance-2.5-flash-image-to-video',
    'seedance-2.5-flash-reference-to-video',
    'seedance-2.5-flash-video-edit',
    'seedance-2.5-flash-video-extend',
]);
const GENERATION_MODELS = new Set([
    'seedance-2.5-text-to-video',
    'seedance-2.5-image-to-video',
    'seedance-2.5-reference-to-video',
    'seedance-2.5-video-edit',
    'seedance-2.5-video-extend',
    ...FLASH_MODELS,
]);
/** Video edits: duration is always -1 there, which selects the edit and is never an expected output length. */
const EDIT_MODELS = new Set(['seedance-2.5-video-edit', 'seedance-2.5-flash-video-edit']);
/** The routes that can search the web (model_params.web_search). */
const SEARCH_MODELS = new Set(['seedance-2.5-text-to-video', 'seedance-2.5-flash-text-to-video']);
/** Match the resolved catalog identity, never a borrowed documentation alias. */
export function isSeedanceGeneration(entry) {
    return entry.id !== undefined && GENERATION_MODELS.has(entry.id)
        && entry.kind === 'video' && entry.spec?.path === '/v1/videos/generations';
}
const isFlash = (entry) => FLASH_MODELS.has(entry.id ?? '');
/** A Seedance 2.5 or 2.5 Flash video edit, whose duration -1 is an operation setting. */
export function isSeedanceEdit(entry) {
    return isSeedanceGeneration(entry) && EDIT_MODELS.has(entry.id);
}
export function isSeedanceSearch(entry) {
    return isSeedanceGeneration(entry) && SEARCH_MODELS.has(entry.id);
}
export function seedanceSearchEnabled(entry, input) {
    const params = input.model_params;
    return isSeedanceSearch(entry) && !!params && typeof params === 'object' && !Array.isArray(params)
        && params.web_search === true;
}
/** Only reviewed gateway checks are blocking. Documentation-only differences warn. */
export function prepareSeedanceInput(entry, input) {
    const applies = isSeedanceGeneration(entry);
    const errors = [], warnings = [];
    const defaults = [];
    if (!applies)
        return { applies, input, errors, warnings, defaults };
    // Do not mutate the shared catalog spec, caller input, or nested references.
    const effective = { ...input };
    const params = input.model_params && typeof input.model_params === 'object' && !Array.isArray(input.model_params)
        ? input.model_params : undefined;
    if (input.web_search !== undefined)
        errors.push({ param: 'web_search', problem: 'must be provided as model_params.web_search for this model.' });
    // Seedance 2.5 Flash has no draft mode: the documented parameters refuse a draft field wherever it is given.
    if (params?.draft !== undefined && !isFlash(entry))
        errors.push({ param: 'model_params.draft', problem: 'must be provided as the top-level draft field.' });
    if (params?.web_search !== undefined && typeof params.web_search !== 'boolean') {
        errors.push({ param: 'model_params.web_search', problem: 'must be a boolean.' });
    }
    if (input.draft === true && !isFlash(entry)) {
        if (input.quality === undefined) {
            effective.quality = '480p';
            defaults.push({ param: 'quality', value: '480p', reason: 'draft=true requires 480p' });
        }
        else if (input.quality !== '480p') {
            errors.push({ param: 'quality', problem: 'must be 480p when draft is true; omit quality to use the 480p draft default.' });
        }
    }
    if (typeof input.duration === 'number' && (input.duration === 0 || input.duration < -1)) {
        errors.push({ param: 'duration', problem: 'must be an integer between 4 and 30 seconds, or -1 for automatic duration.' });
    }
    else if (!isFlash(entry) && entry.id !== 'seedance-2.5-video-edit' && typeof input.duration === 'number' && Number.isInteger(input.duration)
        && input.duration !== -1 && (input.duration < 4 || input.duration > 30)) {
        // Seedance 2.5 Flash documents its durations as -1 or 4–30, so the documented parameters refuse the others.
        warnings.push({ param: 'duration', problem: 'is outside the documented 4–30 seconds or -1; acceptance by the service has not been verified.' });
    }
    if (seedanceSearchEnabled(entry, input) && input.content_filter === false) {
        if (isFlash(entry))
            errors.push({ param: 'content_filter', problem: 'cannot be false while model_params.web_search is true on this model; keep content_filter true to search the web.' });
        else
            warnings.push({ param: 'content_filter', problem: 'false with model_params.web_search=true is documented as unsupported; service acceptance has not been verified.' });
    }
    return { applies, input: effective, errors, warnings, defaults };
}
/** A fresh object for the resolved model; never augment the shared docs index. */
export function seedanceInputRules(entry) {
    if (!isSeedanceGeneration(entry))
        return undefined;
    const flash = isFlash(entry);
    return {
        model: entry.id, endpoint: entry.spec.path,
        ...(flash ? {} : { conditional_defaults: [{ when: { draft: true }, parameter: 'quality', value: '480p' }] }),
        blocking: [...flash ? [] : ['draft=true requires quality=480p or omitted'], 'duration=0 and duration<-1 are rejected',
            ...flash ? [] : ['draft must be top-level'], 'model_params.web_search must be boolean when provided',
            ...flash && isSeedanceSearch(entry) ? ['model_params.web_search=true requires content_filter=true'] : []],
        warnings_only: [flash ? 'Other unverified search and content_filter combinations do not add blocking checks.'
                : 'Other unverified duration boundaries and search/content_filter combinations do not add blocking checks.'],
        ...(isSeedanceEdit(entry) ? { duration_usage: 'duration=-1 selects video editing; supply expected output seconds separately as pricing_parameters.duration_seconds, not as input.duration.' } : {}),
        ...(isSeedanceSearch(entry) ? { search_usage: 'Search defaults to off. When model_params.web_search=true, missing search_count produces a partial subtotal assuming zero searches, with separate per-search rates. Expected counts are not execution limits; one task may search multiple times.' } : {}),
    };
}
