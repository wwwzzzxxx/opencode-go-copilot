/**
 * Per-model override table.
 *
 * The models.dev catalog is the single source of truth for model metadata.
 * These overrides only carry fields the catalog cannot express (or gets wrong):
 * - apiMode (Anthropic vs OpenAI format) — the catalog only hints via npm field
 * - thinkingMode="adaptive" semantics
 * - extra request-body parameters (e.g. `reasoning_split`)
 * - default reasoning effort tuning (e.g. GLM-5.2 defaults to "high", not "max")
 *
 * Merge semantics: for each field, the override value wins when present;
 * otherwise the value resolved from the catalog is used.
 */

/**
 * Override for a single model. Every field is optional — only the fields
 * written here take effect; everything else falls through to the catalog.
 */
export interface ModelMetaOverride {
    displayName?: string;
    vision?: boolean;
    /**
     * Force native PDF input on/off for this model, overriding the catalog's
     * `modalities.input` signal. Only meaningful for `openai-responses` models.
     */
    pdf?: boolean;
    thinkingMode?: "switchable" | "always" | "adaptive";
    supportedReasoningEfforts?: string[];
    defaultReasoningEffort?: string;
    contextLength?: number;
    maxOutputTokens?: number;
    apiMode?: "openai" | "anthropic" | "openai-responses";
    supportsTemperature?: boolean;
    toolCalling?: boolean;
    baseUrl?: string;
    /** Fields the catalog cannot express: request-body extras (e.g. reasoning_split) */
    extra?: Record<string, unknown>;
    /** Thinking budget in tokens (from catalog `budget_tokens`, may need manual tuning) */
    thinkingBudget?: { min?: number; max?: number };
    /** Whether to include reasoning_content in assistant messages sent to the API */
    includeReasoningInRequest?: boolean;
    status?: string;
    cost?: { cache_read: number; input: number; output: number };
}

/**
 * Per-model overrides, keyed by model ID.
 */
export const MODEL_OVERRIDES: Record<string, ModelMetaOverride> = {
    // ── MiniMax series ── served via Anthropic-compatible API; M3 is adaptive-only
    "minimax-m3": {
        thinkingMode: "adaptive",
        apiMode: "anthropic",
        extra: { reasoning_split: true },
    },
    "minimax-m2.7": {
        apiMode: "anthropic",
        extra: { reasoning_split: true },
    },
    "minimax-m2.5": {
        apiMode: "anthropic",
    },

    // ── Qwen series ── served via Anthropic-compatible API
    "qwen3.7-max": { apiMode: "anthropic" },
    "qwen3.7-plus": { apiMode: "anthropic" },
    "qwen3.6-plus": { apiMode: "anthropic" },
    "qwen3.5-plus": { apiMode: "anthropic" },

    // ── GLM ── keep default effort at "high" (matches historical built-in config)
    "glm-5.2": { defaultReasoningEffort: "high" },

    // ── Muse Spark ── Free / Go 均为 OpenAI Responses (input_image)；chat/completions image_url 在 go 上 400
    "muse-spark-1.2-contributor": { apiMode: "openai-responses" as const },
    "muse-spark-1.2-contributor-free": { apiMode: "openai-responses" as const },
    "muse-spark-1.3-contributor": { apiMode: "openai-responses" as const },
    "muse-spark-1.3-contributor-free": { apiMode: "openai-responses" as const },

    // ── Ox Alpha Free ── Go 侧：ox-alpha-free（opencode-go provider）
    "ox-alpha-free": {
        displayName: "Ox Alpha Free (Unlimited) (Go)",
    },
};
