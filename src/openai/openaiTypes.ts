/**
 * OpenAI function-call entry emitted by assistant messages.
 */
export interface OpenAIToolCall {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
}

/**
 * OpenAI function tool definition used to advertise tools.
 */
export interface OpenAIFunctionToolDef {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: object;
    };
}

/**
 * OpenAI-style chat message used for chat completion requests.
 */
export interface OpenAIChatMessage {
    role: OpenAIChatRole;
    content?: string | ChatMessageContent[];
    name?: string;
    tool_calls?: OpenAIToolCall[];
    tool_call_id?: string;
    reasoning_content?: string;
    reasoning_encrypted_content?: string;
}

/**
 * Chat message content interface (supports multimodal).
 *
 * `input_file` is not a Chat Completions part: it is produced for the Responses
 * path only and translated into the wire shape by the remap block in provider.ts.
 */
export interface ChatMessageContent {
    type: "text" | "image_url" | "input_file";
    text?: string;
    image_url?: {
        url: string;
    };
    /** `input_file.filename` — the base name of the attached PDF. */
    filename?: string;
    /** `input_file.file_data` — `data:application/pdf;base64,...`. */
    file_data?: string;
}

/**
 * OpenAI-style chat roles.
 */
export type OpenAIChatRole = "system" | "user" | "assistant" | "tool";

/**
 * Reasoning detail interfaces for streaming reasoning content.
 */
export interface ReasoningDetailCommon {
    id: string | null;
    format: string;
    index?: number;
}

export interface ReasoningSummaryDetail extends ReasoningDetailCommon {
    type: "reasoning.summary";
    summary: string;
}

export interface ReasoningEncryptedDetail extends ReasoningDetailCommon {
    type: "reasoning.encrypted";
    data: string;
}

export interface ReasoningTextDetail extends ReasoningDetailCommon {
    type: "reasoning.text";
    text: string;
    signature?: string | null;
}

export type ReasoningDetail = ReasoningSummaryDetail | ReasoningEncryptedDetail | ReasoningTextDetail;
