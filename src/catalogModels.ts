/**
 * Unified model resolution layer.
 *
 * Every OpenCode Go model flows through the same two-layer merge chain:
 *
 *   1. resolveFromCatalog() — models.dev catalog
 *      (provider entry → global entry → conservative defaults, per field)
 *   2. applyOverride()      — MODEL_OVERRIDES[modelId] wins per field when present
 */

import * as vscode from "vscode";
import type { LanguageModelChatInformation } from "vscode";
import type { OpenCodeGoModelItem } from "./types";
import { l10n } from "./localize";
import { MODEL_OVERRIDES, type ModelMetaOverride } from "./modelOverrides";
import {
    deduceApiModeFromFamily,
    ensureModelsDevLoaded,
    getCatalogProviderBaseUrl,
    getCatalogProviderModelEntry,
    getCatalogProviderModelIds,
    inferDefaultReasoningEffort,
    inferPdf,
    inferReasoningEfforts,
    inferThinkingBudget,
    inferThinkingMode,
    inferVision,
    lookupModelDevEntry,
    type ModelsDevEntry,
} from "./modelsDev";

/**
 * Supported provider ID. Only OpenCode Go remains: the OpenCode Zen free
 * tier rejects requests originating outside OpenCode with a 403
 * FreeTierError. Go-plan free models ("-free" IDs) are served by the Go API
 * and stay in the picker.
 */
export type ProviderId = "opencode-go";

/** Fallback base URL used when the catalog is not loaded. */
const FALLBACK_BASE_URLS: Record<ProviderId, string> = {
    "opencode-go": "https://opencode.ai/zen/go/v1/",
};

/** Provider display metadata (family grouping, picker detail text). */
const PROVIDER_LABELS: Record<ProviderId, { family: string; detail: string }> = {
    "opencode-go": { family: "OpenCodeGo", detail: "OpenCode Go" },
};

const DEFAULT_CONTEXT_LENGTH = 128000;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Resolved model metadata. Every field that the catalog can supply has a
 * conservative default, so the object is always complete.
 */
export interface ModelMeta {
    displayName: string;
    vision: boolean;
    /** Model accepts PDF documents natively (catalog `modalities.input` contains "pdf"). */
    pdf: boolean;
    thinkingMode: "switchable" | "always" | "adaptive";
    supportedReasoningEfforts: string[];
    defaultReasoningEffort: string;
    contextLength: number;
    maxOutputTokens: number;
    apiMode: "openai" | "anthropic" | "openai-responses";
    supportsTemperature: boolean;
    toolCalling: boolean;
    baseUrl: string;
    thinkingBudget?: { min?: number; max?: number };
    status?: string;
    cost: { cache_read: number; input: number; output: number };
}

function getMaxContextLengthOverride(): number | undefined {
    const v = vscode.workspace.getConfiguration("opencodego").get<number>("maxContextLength", 0);
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
    return undefined;
}

function applyMaxContextLengthCap(meta: ModelMeta): ModelMeta {
    const cap = getMaxContextLengthOverride();
    if (cap !== undefined && meta.contextLength > cap) {
        return { ...meta, contextLength: cap };
    }
    return meta;
}

/**
 * Resolve the provider for a model ID. Only OpenCode Go remains; kept as a
 * single-value helper so call sites stay provider-agnostic.
 */
export function resolveProviderForModelId(_modelId: string): ProviderId {
    return "opencode-go";
}

/**
 * Resolve model metadata from the catalog with conservative defaults.
 * Per field: provider-specific entry → global entry → default.
 */
function resolveFromCatalog(providerId: ProviderId, modelId: string): ModelMeta {
    const providerEntry = getCatalogProviderModelEntry(providerId, modelId);
    const globalEntry = lookupModelDevEntry(modelId);
    const entry: ModelsDevEntry | undefined = providerEntry ?? globalEntry;

    const thinkingMode = entry ? inferThinkingMode(entry) : "switchable";
    const rawEfforts = entry ? inferReasoningEfforts(entry) : undefined;
    // Normalize: "none"/"disabled" effort values are represented by the "disabled" picker option
    const supportedReasoningEfforts = (rawEfforts ?? []).filter((e) => e !== "none" && e !== "disabled");

    return {
        displayName: entry?.name ?? modelId,
        vision: entry ? inferVision(entry) : false,
        pdf: entry ? inferPdf(entry) : false,
        thinkingMode,
        supportedReasoningEfforts,
        defaultReasoningEffort: entry ? inferDefaultReasoningEffort(entry) : "enabled",
        contextLength: entry?.limit?.context ?? DEFAULT_CONTEXT_LENGTH,
        maxOutputTokens: entry?.limit?.output ?? DEFAULT_MAX_TOKENS,
        apiMode: entry ? deduceApiModeFromFamily(modelId, entry) : "openai",
        supportsTemperature: entry?.temperature ?? true,
        toolCalling: entry?.tool_call ?? true,
        baseUrl: getCatalogProviderBaseUrl(providerId, FALLBACK_BASE_URLS[providerId]),
        thinkingBudget: entry ? inferThinkingBudget(entry) : undefined,
        status: entry?.status,
        cost: entry?.cost ?? { cache_read: 0, input: 0, output: 0 },
    };
}

/**
 * Apply per-model overrides. Override wins per field when present.
 */
function applyOverride(meta: ModelMeta, override?: ModelMetaOverride): ModelMeta {
    if (!override) return meta;
    return {
        displayName: override.displayName ?? meta.displayName,
        vision: override.vision ?? meta.vision,
        pdf: override.pdf ?? meta.pdf,
        thinkingMode: override.thinkingMode ?? meta.thinkingMode,
        supportedReasoningEfforts: override.supportedReasoningEfforts ?? meta.supportedReasoningEfforts,
        defaultReasoningEffort: override.defaultReasoningEffort ?? meta.defaultReasoningEffort,
        contextLength: override.contextLength ?? meta.contextLength,
        maxOutputTokens: override.maxOutputTokens ?? meta.maxOutputTokens,
        apiMode: override.apiMode ?? meta.apiMode,
        supportsTemperature: override.supportsTemperature ?? meta.supportsTemperature,
        toolCalling: override.toolCalling ?? meta.toolCalling,
        baseUrl: override.baseUrl ?? meta.baseUrl,
        thinkingBudget: override.thinkingBudget ?? meta.thinkingBudget,
        status: override.status ?? meta.status,
        cost: override.cost ?? meta.cost,
    };
}

/**
 * Resolve the final metadata for a model through the merge chain.
 * Applies user-configured maxContextLength cap (only when model > cap).
 */
export function resolveModelMeta(providerId: ProviderId, modelId: string): ModelMeta {
    const merged = applyOverride(resolveFromCatalog(providerId, modelId), MODEL_OVERRIDES[modelId]);
    return applyMaxContextLengthCap(merged);
}

/**
 * Build the reasoning effort enum (values/labels/descriptions/default) for a model.
 */
function buildReasoningEnum(meta: ModelMeta): {
    enumValues: string[];
    enumItemLabels: string[];
    enumDescriptions: string[];
    defaultEffort: string;
} {
    const hasEfforts = meta.supportedReasoningEfforts.length > 0;
    let enumValues: string[];
    if (hasEfforts) {
        if (meta.thinkingMode === "switchable") {
            enumValues = ["disabled", ...meta.supportedReasoningEfforts];
        } else {
            enumValues = [...meta.supportedReasoningEfforts];
        }
    } else {
        if (meta.thinkingMode === "switchable") {
            enumValues = ["disabled", "enabled"];
        } else if (meta.thinkingMode === "adaptive") {
            enumValues = ["disabled", "adaptive"];
        } else {
            enumValues = ["enabled"];
        }
    }

    // Fall back to the last enum value when the requested default is not selectable
    // (e.g. "enabled" for an adaptive model).
    const defaultEffort = enumValues.includes(meta.defaultReasoningEffort)
        ? meta.defaultReasoningEffort
        : enumValues[enumValues.length - 1];

    const getLabel = (e: string): string => {
        switch (e) {
            case 'disabled': return l10n("Disabled");
            case 'adaptive': return l10n("Adaptive");
            case 'enabled': return l10n("Thinking");
            case 'low': return l10n("Low");
            case 'medium': return l10n("Medium");
            case 'high': return l10n("High");
            case 'xhigh': return l10n("Extra High");
            case 'max': return l10n("Maximum");
            default: return e.charAt(0).toUpperCase() + e.slice(1);
        }
    };
    const getDesc = (e: string): string => {
        switch (e) {
            case 'disabled': return l10n("Do not enable thinking");
            case 'adaptive': return l10n("Automatically decide when to think");
            case 'enabled': return l10n("Enable thinking");
            case 'low': return l10n("Reduce thinking, faster response");
            case 'medium': return l10n("Balance thinking and speed");
            case 'high': return l10n("Deeper thinking, slower response");
            case 'xhigh': return l10n("Very deep thinking, slower response");
            case 'max': return l10n("Maximum thinking depth, slowest response");
            default: return e;
        }
    };

    return {
        enumValues,
        enumItemLabels: enumValues.map(getLabel),
        enumDescriptions: enumValues.map(getDesc),
        defaultEffort,
    };
}

/**
 * Prefix applied to model IDs exposed to VS Code (the picker / selectChatModels).
 *
 * Bare catalog IDs (e.g. "glm-5.2") can collide with IDs contributed by other
 * providers, and VS Code cannot tell which provider an ID belongs to. The
 * exposed ID is namespaced ("go-glm-5.2") while requests to the Go API keep
 * using the bare ID — see stripExposedModelId(). The display name is
 * untouched (id and name are separate fields).
 */
export const EXPOSED_MODEL_ID_PREFIX = "go-";

/**
 * Map an exposed picker ID back to the bare catalog ID.
 * IDs without the prefix pass through unchanged, so bare IDs stored in user
 * settings (visionProxyModel / commitModel) keep working.
 */
export function stripExposedModelId(exposedId: string): string {
    return exposedId.startsWith(EXPOSED_MODEL_ID_PREFIX)
        ? exposedId.slice(EXPOSED_MODEL_ID_PREFIX.length)
        : exposedId;
}

/**
 * Map a bare catalog ID to the ID exposed to VS Code.
 * The vision-proxy alias ("qwen-plus-latest") is not a real model ID and is
 * left as-is so resolveVisionProxyModelId() can still recognize it.
 */
export function toExposedModelId(modelId: string): string {
    if (modelId === VISION_PROXY_LATEST_ALIAS) {
        return modelId;
    }
    return modelId.startsWith(EXPOSED_MODEL_ID_PREFIX) ? modelId : `${EXPOSED_MODEL_ID_PREFIX}${modelId}`;
}

/**
 * Special vision proxy model ID that resolves to the newest qwen*-plus model.
 */
export const VISION_PROXY_LATEST_ALIAS = "qwen-plus-latest";

/**
 * Compare two model versions numerically (e.g. "3.10" > "3.9").
 */
function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
    const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const va = pa[i] ?? 0;
        const vb = pb[i] ?? 0;
        if (va !== vb) return va - vb;
    }
    return 0;
}

/**
 * Resolve the vision proxy model ID.
 *
 * The special value "qwen-plus-latest" (the default) resolves to the newest
 * qwen*-plus model served by the opencode-go provider in the catalog
 * (e.g. qwen3.8-plus over qwen3.7-plus). Any other value is returned unchanged.
 * Falls back to the alias itself when the catalog has no qwen*-plus model.
 *
 * The returned ID is the exposed (prefixed) form, since callers pass it to
 * vscode.lm.selectChatModels({ id }) against the picker list.
 */
export async function resolveVisionProxyModelId(configuredId: string): Promise<string> {
    const bareConfigured = stripExposedModelId(configuredId.trim());
    if (bareConfigured !== VISION_PROXY_LATEST_ALIAS) {
        return toExposedModelId(bareConfigured);
    }
    try {
        await ensureModelsDevLoaded();
        const ids = getCatalogProviderModelIds("opencode-go");
        const plusModels = ids
            .filter((id) => /^qwen[\d.]*-plus$/.test(id))
            .filter((id) => !isModelDeprecated("opencode-go", id))
            .sort((a, b) => {
                const va = (a.match(/^qwen([\d.]+)-plus$/) ?? [])[1] ?? "";
                const vb = (b.match(/^qwen([\d.]+)-plus$/) ?? [])[1] ?? "";
                return compareVersions(vb, va);
            });
        return toExposedModelId(plusModels[0] ?? VISION_PROXY_LATEST_ALIAS);
    } catch {
        return VISION_PROXY_LATEST_ALIAS;
    }
}

/**
 * Check whether a model is marked as deprecated in the catalog.
 * Deprecated models are hidden from the model picker unless the user opts in.
 */
export function isModelDeprecated(providerId: ProviderId, modelId: string): boolean {
    return resolveModelMeta(providerId, modelId).status === "deprecated";
}

/**
 * Build a LanguageModelChatInformation entry (model picker) for a model.
 *
 * The exposed `id` carries the "go-" prefix so VS Code can tell our models
 * apart from same-named IDs of other providers; `name` keeps the bare
 * display name. All request-side lookups strip the prefix again.
 */
export function buildCatalogModelInfo(providerId: ProviderId, modelId: string): LanguageModelChatInformation {
    const meta = resolveModelMeta(providerId, modelId);
    const label = PROVIDER_LABELS[providerId];
    // Deprecated models keep a visible marker when shown (opt-in setting)
    const deprecatedPrefix = meta.status === "deprecated" ? l10n("[Depr] ") : "";
    const name = `${deprecatedPrefix}${meta.displayName}`;
    const { enumValues, enumItemLabels, enumDescriptions, defaultEffort } = buildReasoningEnum(meta);

    return {
        id: toExposedModelId(modelId),
        name,
        detail: label.detail,
        tooltip: label.detail,
        family: label.family,
        version: "1.0.0",
        maxInputTokens: meta.contextLength,
        maxOutputTokens: meta.maxOutputTokens,
        isUserSelectable: true,
        capabilities: {
            toolCalling: meta.toolCalling,
            // Always declare imageInput=true so VS Code passes image data through.
            // Non-vision models handle images via the ask_image tool proxy internally.
            imageInput: true,
        },
        configurationSchema: {
            properties: {
                reasoningEffort: {
                    type: "string",
                    title: l10n("Reasoning Effort"),
                    enum: enumValues,
                    enumItemLabels: enumItemLabels,
                    enumDescriptions: enumDescriptions,
                    default: defaultEffort,
                    group: "navigation",
                },
            },
        },
    } satisfies LanguageModelChatInformation;
}

/**
 * Build the OpenCodeGoModelItem request config for a model.
 *
 * Accepts either the exposed ("go-…") or the bare catalog ID; the resolved
 * config (and the `model` field sent to the Go API) always uses the bare ID.
 */
export function getCatalogModelConfig(modelId: string): OpenCodeGoModelItem {
    const bareId = stripExposedModelId(modelId);
    const providerId = resolveProviderForModelId(bareId);
    const meta = resolveModelMeta(providerId, bareId);
    const override = MODEL_OVERRIDES[bareId];

    const config: OpenCodeGoModelItem = {
        id: bareId,
        owned_by: "opencode",
        displayName: meta.displayName,
        baseUrl: meta.baseUrl,
        vision: meta.vision,
        pdf: meta.pdf,
        supportsTemperature: meta.supportsTemperature,
        context_length: meta.contextLength,
        max_completion_tokens: meta.maxOutputTokens,
        apiMode: meta.apiMode,
        enable_thinking: true,
        include_reasoning_in_request: override?.includeReasoningInRequest ?? true,
        thinkingMode: meta.thinkingMode,
        cost: meta.cost,
    };

    // Only send an explicit effort when it is a real effort value
    // ("enabled"/"adaptive" are handled via the thinking flags instead).
    if (meta.defaultReasoningEffort && meta.defaultReasoningEffort !== "enabled" && meta.defaultReasoningEffort !== "adaptive") {
        config.reasoning_effort = meta.defaultReasoningEffort;
    }
    if (meta.thinkingBudget?.max !== undefined) {
        config.thinking_budget = meta.thinkingBudget.max;
    }
    if (override?.extra) {
        config.extra = { ...override.extra };
    }

    return config;
}
