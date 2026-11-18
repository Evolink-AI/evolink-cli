// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { currentRequestCredentials } from '../request-context.js';
import { RequestTimeoutError } from '../services/http-policy.js';
import { getPricingRules, PricingRulesError, PricingRulesQuery, reusablePricingRules } from '../services/pricing-rules-client.js';
import { accountFallbackNote, accountPricingStatus, accountRulesAccess, readAccountRulesFirst } from '../services/pricing-rules-estimate.js';
import { pricingCallLimitReached } from '../services/pricing-call-limit.js';
import { failure, ok, READ_ONLY, retryText } from './shared.js';
export function registerPricingRules(server, config) {
    server.registerTool('get_pricing_rules', {
        title: 'Read pricing rules',
        description: 'Read schema-2 pricing rules, decimal-string rates including fractional UC, minimum charges, tiers and optional full expressions. Free. A list is always the public default rules (price_scope: public_default), read anonymously. With a model, a signed-in connection or API key gets the rates of its own account when the platform offers them (price_scope: account), otherwise the public default rates. Model IDs and published aliases are case-insensitive; results keep the canonical model_id and published aliases. The returned price_selection, when present, identifies route-priority prices or legacy minimum configuration prices. Coverage follows the returned published policies and supported legacy text adapters, including media when available. These are reference rates, not live availability, a task quote, a bill or a final spending cap; public default rates are not account prices. Do not substitute these rules for media estimate_cost or assume empty media results are free.',
        inputSchema: PricingRulesQuery.shape,
        annotations: { title: 'Read pricing rules', ...READ_ONLY },
    }, async (input) => {
        // One model can be read at the caller's own prices; a list is the public default rules.
        const account = input.model ? accountRulesAccess(config) : undefined;
        // Only a lookup that reads the platform's rules counts; one answered from rules read moments ago does not.
        const over = config.reusePricingRules && reusablePricingRules(input, account) ? undefined : pricingCallLimitReached('get_pricing_rules');
        if (over)
            return failure(`This account already made ${over.limit} get_pricing_rules calls that read the pricing rules in the last minute, the most allowed. Wait ${retryText(over.retryAfterSeconds)}, then try again. No quote or spending limit was established.`, {
                error: { category: 'rate_limited', code: 'pricing_calls_per_minute', retryable: true, retry_after: over.retryAfterSeconds },
                charged: 'no', quote_established: false, final_budget_enforced: false
            });
        try {
            // Hosted: rules stay valid until their own fresh_until, and a burst of lookups must not spend the shared per-IP limit.
            const reuse = config.reusePricingRules ? { reuseUntilFresh: true } : {};
            const { body, source, accountFallback: fallback } = await readAccountRulesFirst(account, from => getPricingRules(input, { ...reuse, ...(from ? { account: from } : {}) }));
            const models = 'model' in body ? [body.model] : body.models;
            const selection = body.meta.price_selection ?? 'configured_minimum';
            const ownRates = body.meta.price_scope === 'account';
            const warnings = [
                selection === 'route_priority'
                    ? 'Public reference rates use enabled routes by priority, with the existing web-price fallback when every route is unavailable. Failover can change the actual routed price.'
                    : 'Legacy public rates use the lowest configured price, which can include an unavailable route and differ from the web-price reference.',
                ownRates
                    ? 'These are the rates of your own account. Routed settlement and promotions can still change what a task is charged.'
                    : 'Public default configuration prices may differ from routed settlement, account-group prices, discounts and promotions.',
                'No task quote or final spending cap was established. Do not multiply unit rates into a bill; minimum charges, tiers and rounding apply.',
                'Coverage follows the models returned for this query. Empty results mean no matching public rules were returned, not zero cost.',
            ];
            const fallbackNote = accountFallbackNote(fallback);
            if (fallbackNote)
                warnings.push(fallbackNote);
            const rejected = 'models' in body ? body.rejected_models ?? [] : [];
            if (rejected.length > 0) {
                warnings.push(`${rejected.length} model(s) were left out because their published rules could not be read: ${rejected.slice(0, 20).join(', ')}${rejected.length > 20 ? `, and ${rejected.length - 20} more` : ''}. Missing rules do not mean these models are free.`);
            }
            const lines = [`${ownRates ? 'Pricing rules at your account\'s rates' : 'Public pricing rules'} (${body.meta.price_scope}; ${selection}; ${source}); ${models.length} model(s).`, ...warnings];
            if (input.model && 'model' in body && input.model !== body.model.model_id) {
                lines.push(`Requested model ${input.model} resolves to ${body.model.model_id} through a published alias.`);
            }
            for (const model of models) {
                lines.push(`${model.model_id} (${model.modality}; ${model.pricing_status}; ${model.policy_source} v${model.policy_version})`);
                for (const component of model.components)
                    lines.push(`- ${component.role}: ${component.rate.usd} USD (${component.rate.credits} credits) per ${component.billing_unit_size} ${component.unit === '1k_tokens' ? 'tokens' : component.unit}; minimum ${component.minimum_charge.usd} USD; ${component.tiers.length} tier(s); ${component.pricing_status}.`);
            }
            return ok(lines.join('\n'), { ...body, ...(input.model ? { requested_model: input.model } : {}), pricing_source: source,
                pricing_endpoint: ownRates ? '/v1/pricing-rules/{model}' : '/v1/catalog/pricing-rules', quote_established: false, final_budget_enforced: false,
                account_price: ownRates, ...accountPricingStatus(account, body.meta.price_scope, fallback), warnings });
        }
        catch (error) {
            // An account read that fails falls back to the anonymous public read, so a failure here is the
            // public read's. A transport failure or cancellation must not ask the user to sign in or expose
            // exception text.
            const safeError = error instanceof PricingRulesError ? error : new PricingRulesError(currentRequestCredentials()?.http?.signal?.aborted ? 'interrupted'
                : error instanceof RequestTimeoutError ? 'pricing_rules_timeout'
                    : error instanceof TypeError ? 'pricing_rules_network_error' : 'pricing_rules_unavailable');
            return failure(safeError.status === 404
                ? 'No public pricing rules are published for this model and filters. This does not mean the model is free or unavailable.'
                : safeError.code === 'interrupted' ? 'Public pricing rules lookup was interrupted. No quote or spending limit was established.'
                    : safeError.code === 'rate_limit_exceeded' ? `The platform is limiting pricing requests right now. Try again in ${retryText(safeError.retryAfter)}. No quote or spending limit was established.`
                        : safeError.message, { error: { category: safeError.code === 'interrupted' ? 'interrupted'
                        : safeError.status === 404 ? 'not_found' : safeError.status === 429 ? 'rate_limit' : 'server_error',
                    code: safeError.code, status: safeError.status,
                    retryable: safeError.status === 429 || safeError.status >= 500
                        || ['pricing_rules_timeout', 'pricing_rules_network_error'].includes(safeError.code),
                    ...(safeError.retryAfter !== undefined ? { retry_after: safeError.retryAfter } : {}) }, charged: 'no',
                quote_established: false, final_budget_enforced: false });
        }
    });
}
