/**
 * Native PDF attachments for models whose catalog entry declares `pdf` input.
 *
 * Two acquisition paths, both driven by something the user actually chose:
 *  1. **Local drag-and-drop** — VS Code hands a third-party provider nothing about a dragged
 *     PDF, but Copilot Chat records the attachment's path in its own session store, which
 *     lives on this host in a local window (see `chatStore.ts`). Remote/SSH windows keep that
 *     store on the client, so this path is local-only.
 *  2. **`OpenCodeGo: Attach PDF`** — the user picks a file; works anywhere, including SSH.
 *
 * The plugin never scans message text for paths, and never reads a PDF the model happened to
 * mention: a PDF is attached only because the user attached it.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { logger } from "../logger";

/** Cap the in-process cache so a few large PDFs cannot pin unbounded memory. */
const CACHE_MAX_BYTES = 64 * 1024 * 1024;

export interface PdfAttachment {
    /** File name sent on the wire (`input_file.filename`). */
    filename: string;
    /** `data:application/pdf;base64,...` payload for `input_file.file_data`. */
    file_data: string;
    /** Source path — used for logging and deduplication, never sent. */
    path: string;
    bytes: number;
    /** True when served from the in-process cache. */
    cached: boolean;
}

interface CacheEntry {
    /** `mtimeMs:size` of the file when it was read; a change invalidates the entry. */
    freshness: string;
    attachment: PdfAttachment;
}

const cache = new Map<string, CacheEntry>();
let cacheBytes = 0;

function isPdfBytes(data: Uint8Array): boolean {
    // %PDF
    return data.length >= 5 && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46;
}

function remember(resolved: string, freshness: string, attachment: PdfAttachment): void {
    const previous = cache.get(resolved);
    if (previous) {
        cacheBytes -= previous.attachment.file_data.length;
        cache.delete(resolved);
    }
    cache.set(resolved, { freshness, attachment });
    cacheBytes += attachment.file_data.length;

    // Map iteration follows insertion order, so the first key is the oldest.
    while (cacheBytes > CACHE_MAX_BYTES && cache.size > 1) {
        const oldest = cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        const entry = cache.get(oldest);
        if (entry) cacheBytes -= entry.attachment.file_data.length;
        cache.delete(oldest);
    }
}

/**
 * Read one PDF, or `undefined` when it cannot be used (missing, too large, not a PDF).
 * Never throws: a bad file must not fail the whole request.
 */
export async function readPdfAttachment(resolved: string, maxBytes: number): Promise<PdfAttachment | undefined> {
    try {
        const stat = await fs.promises.stat(resolved);
        const freshness = `${stat.mtimeMs}:${stat.size}`;

        // Size checks come before the cache lookup so that lowering the limit takes
        // effect immediately instead of being masked by an entry read under the old one.
        if (stat.size === 0) {
            logger.debug("pdf.skip", { path: resolved, reason: "empty" });
            return undefined;
        }
        if (stat.size > maxBytes) {
            logger.info("pdf.skip", { path: resolved, reason: "too-large", bytes: stat.size, maxBytes });
            return undefined;
        }

        const hit = cache.get(resolved);
        if (hit && hit.freshness === freshness) {
            logger.debug("pdf.cache-hit", { path: resolved, bytes: hit.attachment.bytes });
            return { ...hit.attachment, cached: true };
        }

        const data = await fs.promises.readFile(resolved);
        if (!isPdfBytes(data)) {
            logger.info("pdf.skip", { path: resolved, reason: "not-a-pdf" });
            return undefined;
        }

        const attachment: PdfAttachment = {
            filename: path.basename(resolved),
            file_data: `data:application/pdf;base64,${data.toString("base64")}`,
            path: resolved,
            bytes: data.length,
            cached: false,
        };
        remember(resolved, freshness, attachment);
        return attachment;
    } catch (err) {
        logger.warn("pdf.skip", { path: resolved, reason: "read-failed", error: String(err) });
        return undefined;
    }
}

/**
 * Build an attachment from a `LanguageModelDataPart` carrying PDF bytes.
 *
 * VS Code does not forward PDF bytes to a third-party provider today (the Document part is
 * dropped on the way out), but a future VS Code version may, and honouring it costs nothing.
 */
export function pdfAttachmentFromDataPart(
    data: Uint8Array,
    mimeType: string,
    filename: string | undefined,
    maxBytes: number,
): PdfAttachment | undefined {
    const mime = mimeType.toLowerCase();
    if (mime !== "application/pdf" && mime !== "application/x-pdf") {
        return undefined;
    }
    if (data.length === 0 || data.length > maxBytes || !isPdfBytes(data)) {
        logger.info("pdf.skip", { reason: "invalid-data-part", mime, bytes: data.length });
        return undefined;
    }
    logger.info("pdf.attach", { source: "data-part", bytes: data.length, filename });
    return {
        filename: filename ?? "document.pdf",
        file_data: `data:application/pdf;base64,${Buffer.from(data).toString("base64")}`,
        path: `<data part: ${filename ?? "document.pdf"}>`,
        bytes: data.length,
        cached: false,
    };
}

/**
 * Resolve a path token (absolute, `~`, workspace-relative, bare name) and read it.
 *
 * Only reached with a path that came from an explicit attachment record — see
 * `chatStore.ts`. The plugin never scans message text for paths.
 */
export async function readPdfAttachmentByPath(token: string, maxBytes: number): Promise<PdfAttachment | undefined> {
    const resolved = await resolveCandidate(token.trim());
    if (!resolved) {
        logger.debug("pdf.skip", { token, reason: "not-found" });
        return undefined;
    }
    return readPdfAttachment(resolved, maxBytes);
}

/** Resolve a candidate token to an existing file, expanding `~` and workspace-relative names. */
async function resolveCandidate(token: string): Promise<string | undefined> {
    const candidates: string[] = [];

    if (token.startsWith("~")) {
        candidates.push(path.join(os.homedir(), token.slice(1)));
    }
    candidates.push(token);

    if (!path.isAbsolute(token)) {
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            candidates.push(path.join(folder.uri.fsPath, token));
        }
    }

    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                return candidate;
            }
        } catch {
            // unreadable candidate — try the next one
        }
    }

    // Last resort for a bare name: search the workspace by file name.
    if (!/[\\/]/.test(token)) {
        try {
            const found = await vscode.workspace.findFiles(`**/${token}`, null, 1);
            const uri = found[0];
            if (uri) {
                return uri.fsPath;
            }
        } catch {
            // ignore search failures
        }
    }

    return undefined;
}

/**
 * PDFs attached by hand via the `OpenCodeGo: Attach PDF` command, waiting to ride on the
 * next request.
 */
let pendingAttachments: PdfAttachment[] = [];

/** Queue an attachment for the next request. */
export function queuePdfAttachment(attachment: PdfAttachment): void {
    if (!pendingAttachments.some((existing) => existing.path === attachment.path)) {
        pendingAttachments.push(attachment);
    }
}

/** Take the queued attachments, clearing the queue. */
export function takePendingPdfAttachments(): PdfAttachment[] {
    const taken = pendingAttachments;
    pendingAttachments = [];
    return taken;
}

/**
 * Ask the user for a PDF and queue it. In a remote window the dialog browses the remote
 * file system, which is where the extension (and therefore the model) can read it.
 */
export async function pickPdfFileToAttach(maxBytes: number): Promise<PdfAttachment | undefined> {
    const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: "Attach PDF",
        filters: { PDF: ["pdf"] },
    });
    const uri = picked?.[0];
    if (!uri) {
        return undefined;
    }

    const attachment = await readPdfAttachment(uri.fsPath, maxBytes);
    if (!attachment) {
        void vscode.window.showWarningMessage(
            `Not attached: ${uri.fsPath} is not a readable PDF (or exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB limit).`,
        );
        return undefined;
    }

    queuePdfAttachment(attachment);
    void vscode.window.showInformationMessage(`OpenCode Go: ${attachment.filename} will be attached to your next message.`);
    return attachment;
}
