/**
 * Recover PDF attachments from Copilot Chat's own session record.
 *
 * VS Code gives a third-party LanguageModelChatProvider no attachment information at all:
 * the Document content part is dropped in `convertToApiChatMessage`
 * (microsoft/vscode#336694), `LanguageModelChatRequestMessage` has no reference or URI
 * field, and `ProvideLanguageModelChatResponseOptions` only carries modelOptions/tools/
 * toolMode. So a dragged-in PDF arrives as nothing — not even its file name.
 *
 * The path does exist locally though: Copilot Chat persists each request (including its
 * file references) as JSONL under
 * `<userData>/User/workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl`, with the
 * attachment recorded as `requests[].variableData.variables[].value.fsPath`.
 *
 * **Local windows only.** In an SSH remote window the workbench writes that record on the
 * *client* while the extension runs on the *server*, so the directory does not exist here —
 * `setChatSessionRoot` notices that once at activation and every lookup returns nothing.
 *
 * Matching is by request text, not by "newest file": the provider knows the exact text of
 * every user message, so a session file that contains a request with this text is by
 * definition the conversation we are serving. That removes both the stale-request and the
 * wrong-window failure modes.
 *
 * The format is undocumented and may change between VS Code versions. Every failure path
 * is soft: nothing is attached, and the request proceeds unchanged.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { logger } from "../logger";

/** `<...>/workspaceStorage/<hash>/chatSessions` for the current window, when known. */
let chatSessionsDir: string | undefined;

/**
 * Whether the session directory was seen on disk. In an SSH remote window the chat
 * sessions live on the *client* (the workbench writes them), so the remote extension
 * host has no such directory — that is expected, and must not warn on every request.
 */
let chatSessionsDirExists = false;

/** How many session files (newest first) to inspect before giving up. */
const MAX_SESSION_FILES = 12;

/** Cap a single session file; transcripts with images can grow large. */
const MAX_SESSION_BYTES = 24 * 1024 * 1024;

/** Parsed session files, keyed by path, invalidated by mtime. */
const parsedFiles = new Map<string, { mtimeMs: number; byText: Map<string, string[]> }>();

/**
 * Record where this window keeps its chat sessions.
 *
 * @param storageUriFsPath `context.storageUri.fsPath` — `<...>/workspaceStorage/<hash>/<extId>`.
 */
export function setChatSessionRoot(storageUriFsPath: string | undefined): void {
    if (!storageUriFsPath) {
        chatSessionsDir = undefined;
        chatSessionsDirExists = false;
        logger.debug("pdf.chatStore.root", { dir: null });
        return;
    }
    chatSessionsDir = path.join(path.dirname(storageUriFsPath), "chatSessions");
    chatSessionsDirExists = fs.existsSync(chatSessionsDir);
    // Logged once per activation: a missing directory means this host does not own the
    // session store (remote windows keep it on the client) — see the module comment.
    logger.info("pdf.chatStore.root", { dir: chatSessionsDir, exists: chatSessionsDirExists });
}

function normalize(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/** `file:///c%3A/...` → `c:\...`; anything else is returned unchanged. */
function toFsPath(value: string): string {
    if (!value.startsWith("file:")) {
        return value;
    }
    try {
        return vscode.Uri.parse(value).fsPath;
    } catch {
        return value;
    }
}

/**
 * PDF paths among a request's own variables — `variableData.variables[].value.fsPath`.
 *
 * This is the attachment list. Deliberately *not* scanned: `result.metadata.toolCallResults`
 * and `response[].resultDetails`, which also carry file anchors — those are file-search
 * results, not attachments, and attaching them would be wrong.
 */
function collectVariablePdfs(variableData: unknown): string[] {
    const out: string[] = [];
    const variables = (variableData as { variables?: unknown } | null)?.variables;
    if (!Array.isArray(variables)) {
        return out;
    }
    for (const variable of variables) {
        const value = (variable as { value?: unknown } | null)?.value;
        if (value === null || typeof value !== "object") {
            continue;
        }
        const { fsPath, external } = value as { fsPath?: unknown; external?: unknown };
        const candidate = typeof fsPath === "string" ? fsPath : typeof external === "string" ? toFsPath(external) : undefined;
        if (candidate && /\.pdf$/i.test(candidate)) {
            out.push(candidate);
        }
    }
    return out;
}

/**
 * Map normalized request text → attached PDF paths, from one session file.
 *
 * The file is an incremental state log: entries carry a key path (`k`) and a value (`v`),
 * so only the last `requests` patch describes the current conversation.
 */
function extractRequestAttachments(jsonl: string): Map<string, string[]> {
    const byText = new Map<string, string[]>();

    let requests: unknown;
    for (const line of jsonl.split("\n")) {
        if (!line.includes('"requests"')) {
            continue;
        }
        try {
            const entry = JSON.parse(line) as { k?: unknown; v?: unknown };
            if (Array.isArray(entry.k) && entry.k.join(".") === "requests") {
                requests = entry.v;
            }
        } catch {
            // A partially written line — skip it.
        }
    }
    if (!Array.isArray(requests)) {
        return byText;
    }

    for (const request of requests) {
        const message = (request as { message?: { text?: unknown } } | null)?.message;
        const text = typeof message?.text === "string" ? normalize(message.text) : undefined;
        if (!text) {
            continue;
        }
        const paths = collectVariablePdfs((request as { variableData?: unknown }).variableData);
        if (paths.length > 0) {
            byText.set(text, [...new Set(paths)]);
        }
    }
    return byText;
}

async function loadSessionFile(file: string, mtimeMs: number): Promise<Map<string, string[]>> {
    const cached = parsedFiles.get(file);
    if (cached && cached.mtimeMs === mtimeMs) {
        return cached.byText;
    }

    const stat = await fs.promises.stat(file);
    if (stat.size > MAX_SESSION_BYTES) {
        logger.debug("pdf.chatStore.skip", { file, reason: "too-large", bytes: stat.size });
        return new Map();
    }

    const byText = extractRequestAttachments(await fs.promises.readFile(file, "utf8"));
    parsedFiles.set(file, { mtimeMs, byText });
    // Keep the cache small; sessions are only useful while they are recent.
    if (parsedFiles.size > 8) {
        const oldest = parsedFiles.keys().next().value as string | undefined;
        if (oldest !== undefined && oldest !== file) {
            parsedFiles.delete(oldest);
        }
    }
    return byText;
}

/**
 * PDF paths attached to the request whose text is `userText`, or an empty array.
 * Never throws.
 */
export async function findAttachedPdfPaths(userText: string): Promise<string[]> {
    if (!chatSessionsDir || !chatSessionsDirExists || !userText.trim()) {
        return [];
    }

    const wanted = normalize(userText);
    try {
        const names = (await fs.promises.readdir(chatSessionsDir)).filter((name) => name.endsWith(".jsonl"));
        const files = await Promise.all(names.map(async (name) => {
            const file = path.join(chatSessionsDir as string, name);
            try {
                return { file, mtimeMs: (await fs.promises.stat(file)).mtimeMs };
            } catch {
                return undefined;
            }
        }));
        const newest = files
            .filter((entry): entry is { file: string; mtimeMs: number } => entry !== undefined)
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
            .slice(0, MAX_SESSION_FILES);

        for (const { file, mtimeMs } of newest) {
            const byText = await loadSessionFile(file, mtimeMs);
            const exact = byText.get(wanted);
            if (exact) {
                logger.info("pdf.chatStore.hit", { file: path.basename(file), mode: "exact", count: exact.length });
                return exact;
            }
            // The provider's text can carry wrappers the transcript does not (or the other
            // way round), so fall back to a containment match on a long-enough needle.
            if (wanted.length >= 16) {
                for (const [requestText, paths] of byText) {
                    if (requestText.includes(wanted) || wanted.includes(requestText)) {
                        logger.info("pdf.chatStore.hit", { file: path.basename(file), mode: "contains", count: paths.length });
                        return paths;
                    }
                }
            }
        }
        logger.debug("pdf.chatStore.miss", { textChars: wanted.length, files: newest.length });
    } catch (err) {
        logger.warn("pdf.chatStore.error", { error: String(err) });
    }
    return [];
}
