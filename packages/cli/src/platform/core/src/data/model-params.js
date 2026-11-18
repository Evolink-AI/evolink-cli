// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { MODEL_PARAMS_JSON } from './model-params.generated.js';
import { MODEL_PARAMS_OVERRIDES_JSON } from './model-params.overrides.generated.js';
import { withModelConstraints } from './model-constraints.js';
let index;
/** The docs version of each model refreshed on its own, which can be newer than the full index's. */
const overrideMeta = new Map();
function load() {
    if (!index) {
        index = JSON.parse(MODEL_PARAMS_JSON);
        // Targeted refreshes, oldest first; each snapshot keeps the docs commit its models were generated from.
        const stored = JSON.parse(MODEL_PARAMS_OVERRIDES_JSON);
        for (const snapshot of 'snapshots' in stored ? stored.snapshots : [stored]) {
            for (const [model, params] of Object.entries(snapshot.models)) {
                index.models[model] = params;
                overrideMeta.set(model, snapshot.meta);
            }
        }
        for (const model of Object.values(index.models))
            withModelConstraints(model);
    }
    return index;
}
export function modelParamsMeta(model) {
    const loaded = load();
    return (model ? overrideMeta.get(model) : undefined) ?? loaded.meta;
}
export function allModelParams() {
    return Object.values(load().models);
}
/** Exact model ID first, then a case-insensitive match. */
export function findModelParams(model) {
    const models = load().models;
    const trimmed = model.trim();
    if (models[trimmed])
        return models[trimmed];
    const lower = trimmed.toLowerCase();
    return Object.values(models).find(entry => entry.model.toLowerCase() === lower);
}
