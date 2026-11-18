// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { z } from 'zod';
import { currentRequestCredentials } from '../request-context.js';
import { controlBaseURL } from './pricing-client.js';
import { DEFAULT_READ_TIMEOUT_MS, evoHeaders, fetchWithTimeout, timeoutFromEnv } from './http-policy.js';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 64;
// Account prices: one entry per account and model, a few KB each, kept apart from the public entries.
const MAX_ACCOUNT_CACHE_ENTRIES = 2_000;
// How long a gateway that said it does not serve account prices is not asked again.
const ACCOUNT_PRICES_RECHECK_MS = 60_000;
const CACHE_TTL_MS = 60_000;
// Media policies nest arrays and lookup keys around their expressions. Keep
// bounded JSON traversal while allowing the published schema's deeper trees.
const MAX_JSON_DEPTH = 64;
const decimal = z.string().max(64).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const signedDecimal = z.string().max(64).regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const identifier = (max) => z.string().trim().max(max).regex(/^[a-z0-9][a-z0-9._:-]*$/);
const modelName = z.string().trim().toLowerCase().pipe(identifier(100));
const aliasName = z.string().trim().max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const optionalFilter = (schema) => z.preprocess(value => typeof value === 'string' && value.trim() === '' ? undefined : value, schema.optional());
export const PricingRulesQuery = z.object({
    model: optionalFilter(modelName).describe('Model ID or a published alias; model names are case-insensitive.'), product_id: optionalFilter(identifier(100)),
    operation: optionalFilter(z.string().trim().toLowerCase().pipe(identifier(50))),
    modality: optionalFilter(z.string().trim().toLowerCase().pipe(z.enum(['text', 'image', 'video', 'audio']))),
    lifecycle: optionalFilter(z.string().trim().toLowerCase().pipe(z.enum(['active', 'preview', 'deprecated']))),
    view: z.preprocess(value => typeof value === 'string' && value.trim() === '' ? undefined : value, z.string().trim().toLowerCase().pipe(z.enum(['summary', 'full'])).default('full')),
}).strict();
// Preserve decimal strings. Do not sum display USD floats or infer a bill.
function fraction(value) {
    const [whole, part = ''] = value.split('.');
    return [BigInt(whole + part), 10n ** BigInt(part.length)];
}
export const PricingMoney = z.object({ uc: decimal, credits: decimal, cny: decimal, usd: decimal })
    .refine(value => {
    // Live configuration rates can contain fractional UC (e.g. 1102.5),
    // although the initial HTML describes UC as an integer. Settlement
    // rounding belongs to the server; never truncate configuration amounts.
    if (!Object.values(value).every(part => typeof part === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(part)))
        return false;
    const [uc, udc] = fraction(value.uc), [credits, cd] = fraction(value.credits), [cny, yd] = fraction(value.cny), [usd, ud] = fraction(value.usd);
    const delta = usd * 680000n * udc - uc * ud;
    return credits * 10000n * udc === uc * cd && cny * 100000n * udc === uc * yd
        && (delta < 0n ? -delta : delta) * 100000000n <= 680000n * ud * udc;
}, 'Currency fields must represent the same UC amount.');
const LookupValues = z.record(z.string().min(1).max(100), signedDecimal)
    .refine(values => Object.keys(values).length > 0 && Object.keys(values).length <= 100, 'Lookup tables must contain between 1 and 100 entries.');
const ExpressionSchema = z.lazy(() => z.object({
    op: z.string().min(1).max(40), name: z.string().max(100).optional(), value: z.string().max(128).optional(),
    args: z.array(ExpressionSchema).max(32).optional(),
    key: ExpressionSchema.optional(), values: LookupValues.optional(),
}).refine(node => node.op !== 'lookup' || (node.key !== undefined && node.values !== undefined), 'Lookup expressions require a key and a values table.'));
const Rounding = z.object({ point: z.string().max(80), mode: z.string().max(40) });
const rateFields = {
    sku_id: z.string().min(1).max(100), rate: PricingMoney, official_rate: PricingMoney.optional(), minimum_charge: PricingMoney,
    billing_rule: z.string().min(1).max(60), pricing_status: z.enum(['available', 'unavailable']),
    effective_at: z.string().datetime({ offset: true }),
};
// Legacy text adapters express a tier as base rate × multiplier; published policies give each tier its own
// SKU and absolute rate and omit the multiplier. Either way tier.rate is the rate to charge.
const Tier = z.object({ ...rateFields, multiplier: decimal.refine(value => /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
        && fraction(value)[0] > 0n).optional(), when: ExpressionSchema.optional() });
const Component = z.object({ ...rateFields, id: z.string().min(1).max(100), role: z.string().min(1).max(100),
    label_key: z.string().min(1).max(100).optional(),
    dimension: z.string().min(1).max(100), unit: z.string().min(1).max(100),
    billing_unit_size: z.number().int().positive().max(1_000_000_000), display_unit_size: z.number().int().positive().max(1_000_000_000),
    condition: ExpressionSchema.optional(), quantity_rule: ExpressionSchema.optional(), rounding: Rounding.optional(),
    tiers: z.array(Tier).max(100),
});
const Parameter = z.object({ name: z.string().min(1).max(100), type: z.string().min(1).max(60),
    required: z.boolean().optional(), default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    enum: z.array(z.union([z.string(), z.number(), z.boolean()])).max(100).optional(),
    values: z.array(z.union([z.string(), z.number(), z.boolean()])).max(100).optional(),
    description: z.string().max(2000).optional(), minimum: signedDecimal.optional(), maximum: signedDecimal.optional(),
});
const Model = z.object({
    model_id: identifier(100), product_id: identifier(100), operation: identifier(50),
    aliases: z.array(aliasName).max(100).optional(),
    modality: z.enum(['text', 'image', 'video', 'audio']), lifecycle: z.enum(['active', 'preview', 'deprecated']),
    pricing_status: z.enum(['available', 'unavailable']), settlement_basis: z.string().min(1).max(100),
    policy_version: z.number().int().nonnegative(), policy_checksum: z.string().regex(/^[a-f0-9]{64}$/),
    policy_source: z.enum(['published', 'legacy_text_adapter']), parameters: z.array(Parameter).max(100).optional(),
    components: z.array(Component).min(1).max(200),
});
const Meta = z.object({ schema_version: z.literal('2'), catalog_version: z.string().min(1).max(128),
    pricing_version: z.string().min(1).max(128), price_scope: z.enum(['public_default', 'account']), currency: z.literal('USD'),
    price_selection: z.enum(['configured_minimum', 'route_priority']).optional(),
    exchange_rate_version: z.literal('pricing-fx/v1:USD-CNY=6.8'),
    updated_at: z.string().datetime({ offset: true }), fresh_until: z.string().datetime({ offset: true }),
});
// A list is checked model by model, so one unreadable model cannot void every other price.
const Envelope = z.object({ meta: Meta, models: z.array(z.unknown()).max(1000) });
const Single = z.object({ meta: Meta, model: Model });
const cache = new Map();
const accountCache = new Map();
/** Gateways that answered that they do not serve account prices, and until when they are not asked again. */
const accountPricesNotOffered = new Map();
const pending = new Map();
/** Public rules and each account's own prices never share a cache. */
const cacheOf = (account) => account ? accountCache : cache;
export class PricingRulesError extends Error {
    code;
    status;
    retryAfter;
    constructor(code, status = 0, retryAfter) {
        super('Public pricing rules are unavailable or invalid. No quote or spending limit was established.');
        this.code = code;
        this.status = status;
        this.retryAfter = retryAfter;
    }
}
function bounded(value, depth = 0, budget = { nodes: 0 }) {
    if (depth > MAX_JSON_DEPTH || ++budget.nodes > 100_000)
        return false;
    if (Array.isArray(value))
        return value.every(item => bounded(item, depth + 1, budget));
    if (value && typeof value === 'object')
        return Object.values(value).every(item => bounded(item, depth + 1, budget));
    return true;
}
/** A rejected model is named by its ID when that is a readable identifier, otherwise by its position. */
function rejectedName(raw, index) {
    const id = identifier(100).safeParse(raw && typeof raw === 'object' ? raw.model_id : undefined);
    return id.success ? id.data : `#${index}`;
}
/**
 * Bounds, metadata and freshness apply to the whole response and fail closed. In a list, a model whose rules
 * cannot be read is left out and named in `rejected_models`; the list fails only when no model is readable.
 * A single-model response fails when its model cannot be read.
 *
 * `scope` is the price scope that was asked for. A response of the other scope fails: public rules are never taken
 * for an account's prices, nor an account's prices for the public ones.
 */
export function validatePricingRules(body, single, scope = 'public_default') {
    if (!bounded(body))
        throw new PricingRulesError('invalid_pricing_rules');
    const parsed = (single ? Single : Envelope).safeParse(body);
    if (!parsed.success)
        throw new PricingRulesError('invalid_pricing_rules');
    if (parsed.data.meta.price_scope !== scope)
        throw new PricingRulesError('mismatched_pricing_rules');
    if (Date.parse(parsed.data.meta.fresh_until) <= Date.now())
        throw new PricingRulesError('expired_pricing_rules');
    if ('model' in parsed.data)
        return parsed.data;
    const models = [], rejected = [];
    parsed.data.models.forEach((raw, index) => {
        const model = Model.safeParse(raw);
        if (model.success)
            models.push(model.data);
        else
            rejected.push(rejectedName(raw, index));
    });
    if (rejected.length > 0 && models.length === 0)
        throw new PricingRulesError('invalid_pricing_rules');
    return { meta: parsed.data.meta, models, ...(rejected.length > 0 ? { rejected_models: rejected } : {}) };
}
const completeRule = (model) => model.components.every(component => component.quantity_rule && component.rounding
    && component.tiers.every(tier => tier.when));
/**
 * The full view must carry every expression an estimate evaluates. A single model without them fails; in a
 * list, such a model is left out and named like an unreadable one, and the list fails only when none is left.
 */
function completeRules(body) {
    if ('model' in body) {
        if (!completeRule(body.model))
            throw new PricingRulesError('incomplete_pricing_rules');
        return body;
    }
    const kept = body.models.filter(completeRule);
    if (kept.length === body.models.length)
        return body;
    if (kept.length === 0)
        throw new PricingRulesError('incomplete_pricing_rules');
    return { meta: body.meta, models: kept,
        rejected_models: [...(body.rejected_models ?? []), ...body.models.filter(model => !completeRule(model)).map(model => model.model_id)] };
}
async function readBody(response) {
    if (!response.body)
        throw new PricingRulesError('invalid_pricing_rules');
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    let rejectRead;
    const stopped = new Promise((_resolve, reject) => { rejectRead = reject; });
    const stop = (code) => { rejectRead(new PricingRulesError(code)); void reader.cancel().catch(() => { }); };
    const timer = setTimeout(() => stop('pricing_rules_timeout'), timeoutFromEnv('EVOLINK_MCP_READ_TIMEOUT_MS', DEFAULT_READ_TIMEOUT_MS));
    const signal = currentRequestCredentials()?.http?.signal;
    const abort = () => stop('interrupted');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted)
        abort();
    try {
        while (true) {
            const { done, value } = await Promise.race([reader.read(), stopped]);
            if (done)
                break;
            size += value.byteLength;
            if (size > MAX_BODY_BYTES)
                throw new PricingRulesError('pricing_rules_too_large');
            chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch (error) {
        await reader.cancel().catch(() => { });
        if (error instanceof PricingRulesError)
            throw error;
        throw new PricingRulesError('invalid_pricing_rules');
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        reader.releaseLock();
    }
}
function rulesURL(query, account) {
    // Account prices are served one model at a time.
    if (account && !query.model)
        throw new PricingRulesError('account_rules_need_model');
    const base = account ? account.baseUrl.replace(/\/+$/, '') : controlBaseURL();
    const url = new URL(account ? `${base}/v1/pricing-rules/${encodeURIComponent(query.model)}`
        : query.model ? `${base}/v1/catalog/models/${encodeURIComponent(query.model)}/pricing-rules`
            : `${base}/v1/catalog/pricing-rules`);
    for (const key of ['product_id', 'operation', 'modality', 'lifecycle', 'view']) {
        if (query[key] !== undefined)
            url.searchParams.set(key, query[key]);
    }
    return url;
}
/** Public entries are keyed by their URL alone, as before; an account's entries carry the account in front. */
function cacheKey(url, account) {
    return account ? `account ${account.identity} ${url.href}` : url.href;
}
/**
 * False for a minute after this gateway answered that it does not serve account prices (an older version, or the
 * feature switched off), so that is not asked again with every price.
 */
export function accountPricesOffered(account) {
    return (accountPricesNotOffered.get(account.baseUrl) ?? 0) <= Date.now();
}
/** The cached answer to this query while it is still within its cache time; nothing is requested. */
export function cachedPricingRules(input) {
    const old = cache.get(rulesURL(PricingRulesQuery.parse(input)).href);
    return old && old.expires > Date.now() ? old.body : undefined;
}
const stillFresh = (entry) => Date.parse(entry.body.meta.fresh_until) > Date.now();
/** Only identities explicitly published by this rule match; never infer names from a prefix or resemblance. */
function matchesModel(rule, model) {
    const name = model.trim().toLowerCase();
    return rule.model_id === name || rule.aliases?.some(alias => alias.toLowerCase() === name) === true;
}
/**
 * One model's full rules from the cache: its own entry, else its row in the cached full list. An account's rules only
 * come from that account's own entry: the full list is public.
 */
function cachedModel(model, usable, account) {
    const query = PricingRulesQuery.parse({ model, view: 'full' });
    const own = cacheOf(account).get(cacheKey(rulesURL(query, account), account));
    if (own && usable(own))
        return own;
    if (account)
        return undefined;
    const list = cache.get(rulesURL(PricingRulesQuery.parse({ view: 'full' })).href);
    const rows = list && usable(list) && 'models' in list.body ? list.body.models : [];
    const exact = rows.find(item => item.model_id === model.toLowerCase());
    const aliases = exact ? [] : rows.filter(item => matchesModel(item, model));
    // An ambiguous alias in a list is resolved by the single-model endpoint, not by list order.
    const rule = exact ?? (aliases.length === 1 ? aliases[0] : undefined);
    return list && rule ? { body: { meta: list.body.meta, model: rule }, fetchedAt: list.fetchedAt } : undefined;
}
/** One model's full rules read at most maxAgeMs ago, even past their fresh_until: an estimate's fallback while the platform limits requests. */
export function recentModelRules(model, maxAgeMs) {
    return cachedModel(model, entry => Date.now() - entry.fetchedAt <= maxAgeMs);
}
/** The cached answer to a query that `usable` accepts: a model's full rules may come from its row in the cached full list. */
function reusable(query, usable, account) {
    if (query.model && query.view === 'full' && !query.product_id && !query.operation && !query.modality && !query.lifecycle)
        return cachedModel(query.model, usable, account);
    const old = cacheOf(account).get(cacheKey(rulesURL(query, account), account));
    return old && usable(old) ? old : undefined;
}
/**
 * Whether a price for this query would be answered from the cache now, without reading the platform: from the
 * account's own entry with `account`, or from the public rules when the gateway does not serve account prices.
 */
export function reusablePricingRules(input, account) {
    const query = PricingRulesQuery.parse(input);
    return reusable(query, stillFresh, account && accountPricesOffered(account) ? account : undefined) !== undefined;
}
/**
 * `reuseUntilFresh` serves a model's full rules from the cache (its own entry or the full list) until the rules' own
 * fresh_until, which estimates use so a burst of them does not spend the platform's per-IP catalog limit; generation
 * reads `fresh` rules and asks for a new approval when the price moved. `maxAgeMs` lets a fresh read take rules read
 * that recently, still within their fresh_until, so a batch of generations reads them once. Concurrent reads of one
 * query always share a single request.
 *
 * `account` asks the gateway for one model at the prices this caller is billed instead of the public default prices
 * (see AccountRulesAccess). The answer must say price_scope "account", and a public read "public_default"
 * (validatePricingRules).
 */
export async function getPricingRules(input, options = {}) {
    const query = PricingRulesQuery.parse(input), account = options.account, url = rulesURL(query, account);
    const store = cacheOf(account), key = cacheKey(url, account), old = store.get(key);
    const scope = account ? 'account' : 'public_default';
    // Not served by this gateway a moment ago: nothing cached is used either, so switching the feature off takes effect at once.
    if (account && !accountPricesOffered(account))
        throw new PricingRulesError('account_prices_not_offered', 404);
    if (options.reuseUntilFresh) {
        const cached = reusable(query, stillFresh, account);
        if (cached)
            return { body: cached.body, source: 'cache' };
    }
    if (options.maxAgeMs !== undefined) {
        const maxAgeMs = options.maxAgeMs;
        const recent = reusable(query, entry => stillFresh(entry) && Date.now() - entry.fetchedAt <= maxAgeMs, account);
        if (recent)
            return { body: recent.body, source: 'recent' };
    }
    if (!options.fresh && old && old.expires > Date.now())
        return { body: old.body, source: 'cache' };
    const existing = pending.get(key);
    if (existing)
        return existing;
    const task = (async () => {
        let conditional = Boolean(old?.etag);
        for (let attempt = 0; attempt < 2; attempt++) {
            // redirect: 'error' also keeps an account read's credential from following a redirect to another host.
            const response = await fetchWithTimeout(url.href, { method: 'GET', redirect: 'error',
                headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', ...evoHeaders('get_pricing_rules'),
                    ...(account?.headers ?? {}), ...(conditional ? { 'If-None-Match': old.etag } : {}) },
            }, timeoutFromEnv('EVOLINK_MCP_READ_TIMEOUT_MS', DEFAULT_READ_TIMEOUT_MS));
            if (response.status === 304) {
                if (!conditional || !old)
                    throw new PricingRulesError('invalid_pricing_rules', 304);
                if (Date.parse(old.body.meta.fresh_until) <= Date.now()) {
                    conditional = false;
                    continue;
                }
                old.expires = Math.min(Date.now() + CACHE_TTL_MS, Date.parse(old.body.meta.fresh_until));
                old.fetchedAt = Date.now();
                return { body: old.body, source: 'revalidated' };
            }
            if (!response.ok) {
                const status = response.status;
                // A model without rules answers 404 not_found. Any other 404 to an account read is a gateway that does not
                // serve account prices: an older version (no such route) or the feature switched off.
                if (account && status === 404 && await errorCodeOf(response) !== 'not_found') {
                    accountPricesNotOffered.set(account.baseUrl, Date.now() + ACCOUNT_PRICES_RECHECK_MS);
                    throw new PricingRulesError('account_prices_not_offered', 404);
                }
                await response.body?.cancel();
                throw new PricingRulesError(status === 404 ? 'not_found' : status === 429 ? 'rate_limit_exceeded'
                    : status === 503 ? 'pricing_rules_unavailable' : 'pricing_rules_http_error', status, status === 429 ? retryAfterSeconds(response.headers.get('Retry-After')) : undefined);
            }
            let body = validatePricingRules(await readBody(response), Boolean(query.model), scope);
            const models = 'model' in body ? [body.model] : body.models;
            if (models.some(model => (query.model && !matchesModel(model, query.model))
                || (query.product_id && model.product_id !== query.product_id) || (query.operation && model.operation !== query.operation)
                || (query.modality && model.modality !== query.modality) || (query.lifecycle && model.lifecycle !== query.lifecycle))) {
                throw new PricingRulesError('mismatched_pricing_rules');
            }
            if (query.view === 'full')
                body = completeRules(body);
            if (store.size >= (account ? MAX_ACCOUNT_CACHE_ENTRIES : MAX_CACHE_ENTRIES))
                store.delete(store.keys().next().value);
            store.set(key, { body, etag: response.headers.get('ETag') ?? undefined,
                expires: Math.min(Date.now() + CACHE_TTL_MS, Date.parse(body.meta.fresh_until)), fetchedAt: Date.now() });
            return { body, source: 'live' };
        }
        throw new PricingRulesError('expired_pricing_rules');
    })().finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
}
export function resetPricingRulesCacheForTests() { cache.clear(); accountCache.clear(); accountPricesNotOffered.clear(); pending.clear(); }
/** The error code of a refused request, when its body is the gateway's JSON error envelope. */
async function errorCodeOf(response) {
    try {
        const code = (await readBody(response))?.error?.code;
        return typeof code === 'string' ? code : undefined;
    }
    catch (error) {
        if (error instanceof PricingRulesError && error.code === 'interrupted')
            throw error;
        return undefined;
    }
}
function retryAfterSeconds(value) {
    if (!value)
        return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0)
        return Math.ceil(seconds);
    const until = Date.parse(value);
    return Number.isFinite(until) ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : undefined;
}
