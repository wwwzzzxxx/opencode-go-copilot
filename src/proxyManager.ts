/*---------------------------------------------------------------------------------------------
 * Local OpenAI-compatible proxy + SSH tunnel detector.
 *
 * Architecture
 * ------------
 * The extension declares BOTH `extensionKind: ["workspace", "ui"]`:
 *   - In a LOCAL window  -> runs as `ExtensionKind.UI` (local). This instance owns the
 *                          auto-started local reverse-proxy on 127.0.0.1:8899.
 *   - In an SSH window   -> runs as `ExtensionKind.Workspace` (remote). That instance
 *                          detects the SSH `RemoteForward 8899 127.0.0.1:8899` tunnel by
 *                          probing 127.0.0.1:8899. When reachable it rewrites the API base
 *                          URL to point at the tunnel, so requests flow:
 *
 *     remote provider -> 127.0.0.1:8899 (SSH tunnel) -> local proxy -> opencode.ai
 *                                                        ^ source IP is LOCAL
 *
 * When the tunnel is NOT reachable the remote instance falls back to a direct connection
 * (unchanged behavior), so local windows and machines without the tunnel keep working.
 *
 * The proxy binds ONLY to 127.0.0.1 for safety and forwards to the real upstream.
 *--------------------------------------------------------------------------------------------*/
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as vscode from "vscode";
import { logger } from "./logger";
import { hasVpnRules, shouldUseVpnProxy } from "./vpnProxy";

/** Port used for the local proxy + SSH RemoteForward tunnel. */
export const PROXY_PORT = 8900;

/** The two upstream providers used by OpenCode Go models. */
const UPSTREAMS: Record<string, { host: string; pathPrefix: string; https: boolean }> = {
    // Free / zen models (opencode provider)
    opencode: { host: "opencode.ai", pathPrefix: "/zen/v1", https: true },
    // Paid / go models (opencode-go provider)
    "opencode-go": { host: "opencode.ai", pathPrefix: "/zen/go/v1", https: true },
};

/** A single active upstream server we might be proxying to. */
let upstreamServer: http.Server | undefined;
// Keep reference on globalThis so single SSH window's UI host proxy survives
const g: any = globalThis as any;
if (!g.__opencodeProxy) g.__opencodeProxy = { server: undefined as http.Server | undefined };

/** Cache of the last probe result to avoid hammering 127.0.0.1 on every request. */
let probeResult: { reachable: boolean; at: number } | undefined;
const PROBE_TTL_MS = 5000;

/**
 * Whether this extension instance is running in the remote (workspace) extension host.
 *
 * Uses `vscode.env.remoteName` (most reliable): the REMOTE host has a remoteName
 * (e.g. "ssh-remote"), while the LOCAL host (even in an SSH window) has `undefined`.
 */
export function isRemote(): boolean {
    if (vscode.env.remoteName === undefined) {
        return false;
    }
    const ipcHook = (process.env.VSCODE_IPC_HOOK || process.env.VSCODE_IPC_HOOK_CLI || '') as string;
    if (ipcHook.includes('.vscode-server') || ipcHook.includes('vscode-remote')) {
        return true;
    }
    return false;
}

/**
 * The base URL to use for a given model id.
 * In the remote host it points at the SSH tunnel when reachable, otherwise directly upstream.
 */
export type LocalProxyMode = "zen" | "zen+go" | "go" | "none";

/** Read the user-configured local proxy mode. */
export function getLocalProxyMode(): LocalProxyMode {
    const cfg = vscode.workspace.getConfiguration("opencodego");
    const mode = cfg.get<LocalProxyMode>("localProxyMode", "zen+go");
    return mode === "zen" || mode === "zen+go" || mode === "go" || mode === "none" ? mode : "zen+go";
}

/** Whether the given provider group is routed through the local proxy per the current mode. */
function shouldProxyProvider(providerId: "opencode" | "opencode-go"): boolean {
    const mode = getLocalProxyMode();
    if (mode === "none") {
        return false;
    }
    if (mode === "zen") {
        return providerId === "opencode";
    }
    if (mode === "go") {
        return providerId === "opencode-go";
    }
    return true; // zen+go
}

export async function resolveBaseUrl(
    providerId: "opencode" | "opencode-go",
    directUrl: string,
    modelId?: string
): Promise<string> {
    const upstream = UPSTREAMS[providerId];
    if (!upstream) {
        return directUrl;
    }

    // Only the remote (SSH) host rewrites to the tunnel. Local host talks upstream directly.
    if (!isRemote()) {
        return directUrl;
    }

    // VPN models ALWAYS go through the tunnel (higher priority than localProxyMode):
    // the local proxy then routes them via Clash. localProxyMode only gates non-VPN models.
    const isVpnModel = modelId ? shouldUseVpnProxy(modelId) : false;
    if (!isVpnModel && !shouldProxyProvider(providerId)) {
        return directUrl;
    }

    const reachable = await isTunnelReachable();
    if (!reachable) {
        if (isVerboseEnabled()) logger.info("tunnel.probe", { providerId, modelId, reachable, action: "direct" }); else logger.debug("tunnel.probe", { providerId, modelId, reachable, action: "direct" });
        return directUrl;
    }

    const tunnelBase = `http://127.0.0.1:${PROXY_PORT}${upstream.pathPrefix}/`;
    if (isVerboseEnabled()) logger.info("tunnel.probe", { providerId, modelId, reachable, action: "tunnel", tunnelBase }); else logger.debug("tunnel.probe", { providerId, modelId, reachable, action: "tunnel", tunnelBase });
    return tunnelBase;
}

/**
 * Probe 127.0.0.1:PROXY_PORT to see if the SSH RemoteForward tunnel is up.
 * Results are cached for a short window.
 */
/**
 * Probe 127.0.0.1:PROXY_PORT to see if the SSH RemoteForward tunnel is up
 * AND the local proxy is actually serving (not just sshd listening).
 * Results are cached for a short window. We do a TCP connect first, then
 * an HTTP health check to ensure the local proxy responds.
 */
export async function isTunnelReachable(): Promise<boolean> {
    const now = Date.now();
    if (probeResult && now - probeResult.at < PROBE_TTL_MS) {
        return probeResult.reachable;
    }

    const tcpReachable = await new Promise<boolean>((resolve) => {
        const socket = net.connect({ host: "127.0.0.1", port: PROXY_PORT }, () => {
            socket.destroy();
            resolve(true);
        });
        socket.setTimeout(800);
        socket.on("timeout", () => {
            socket.destroy();
            resolve(false);
        });
        socket.on("error", () => resolve(false));
    });

    if (!tcpReachable) {
        probeResult = { reachable: false, at: Date.now() };
        return false;
    }

    // TCP is up — verify it's our proxy (not just sshd's listener) via health endpoint
    try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 900);
        const res = await fetch("http://127.0.0.1:" + PROXY_PORT + "/health", { signal: controller.signal } as any);
        clearTimeout(t);
        const reachable = (res as any).ok === true;
        probeResult = { reachable, at: Date.now() };
        if (!reachable) {
            logger.debug("tunnel.probe.healthFailed", { status: (res as any).status });
        }
        return reachable;
    } catch (e) {
        probeResult = { reachable: false, at: Date.now() };
        logger.debug("tunnel.probe.healthError", { error: String(e) });
        return false;
    }
}

/** Clear the tunnel probe cache — call after proxy start to force re-check. */
export function clearTunnelProbeCache(): void {
    probeResult = undefined;
}

/**
 * Start the local OpenAI-compatible reverse proxy on 127.0.0.1:PROXY_PORT.
 * This is only started in the LOCAL (ui) extension host. Safe to call multiple times;
 * if a server is already listening it is reused.
 *
 * The proxy:
 *   - accepts OpenAI chat-completions / responses style requests
 *   - forwards them (with auth headers) to the correct upstream based on path prefix
 *   - streams the response back
 */
function isVerboseEnabled(): boolean { try { return vscode.workspace.getConfiguration("opencodego").get<boolean>("verboseLogging", false) === true; } catch { return false; } }

export async function maybeStartLocalProxy(secrets: vscode.SecretStorage): Promise<void> {
    const remote = isRemote();
    const ipcHook = (process.env.VSCODE_IPC_HOOK || process.env.VSCODE_IPC_HOOK_CLI || "") as string;
    console.log("[proxy] maybeStart", { isRemote: remote, remoteName: vscode.env.remoteName ?? null, ipcHook: ipcHook.slice(0, 100), hasVpn: hasVpnRules(), mode: getLocalProxyMode(), platform: process.platform });
    logger.info("proxy.maybeStart", { isRemote: remote, remoteName: vscode.env.remoteName ?? null, ipcHook: ipcHook.slice(0, 100), hasVpn: hasVpnRules(), mode: getLocalProxyMode(), platform: process.platform });
    // Only the REMOTE host should skip — the local UI host (even in an SSH window) must own the proxy.
    if (remote) {
        logger.info("proxy.skip", { reason: "remote-host" });
        return;
    }
    // VPN models always need the proxy (they must flow through the tunnel to the
    // local proxy, which routes them via Clash). So start the proxy whenever VPN
    // rules exist, even if localProxyMode is "none".
    const hasVpn = hasVpnRules();
    if (!hasVpn && getLocalProxyMode() === "none") {
        logger.info("proxy.skip", { reason: "mode-none" });
        return;
    }

    // If we already have a listening server in this host, reuse it
    if (g.__opencodeProxy.server?.listening) {
        logger.info("proxy.skip", { reason: "already-listening-global", port: PROXY_PORT, pid: process.pid });
        upstreamServer = g.__opencodeProxy.server;
        return;
    }
    // Clear stale reference if global holds a non-listening server
    if (g.__opencodeProxy.server && !g.__opencodeProxy.server.listening) {
        g.__opencodeProxy.server = undefined;
        upstreamServer = undefined;
    }

    const apiKey = await secrets.get("opencodego.apiKey");
    if (apiKey) {
        void apiKey;
    }

    // Create server (don't assign to global yet — only on successful listen)
    const server = http.createServer((req, res) => {
        handleProxyRequest(req, res).catch((err) => {
            logger.error("proxy.request.failed", { error: String(err) });
            if (!res.headersSent) {
                res.writeHead(502, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: String(err) } }));
            } else {
                res.end();
            }
        });
    });

    server.on("error", (err: any) => {
        // Global error handler for runtime errors after listen
        logger.error("proxy.server.error", { error: String(err) });
    });

    await new Promise<void>((resolve, reject) => {
        const onError = (err: any) => {
            if (err?.code === "EADDRINUSE") {
                // Something else already binds 8900 — could be another VS Code window's proxy
                logger.info("proxy.skip", { reason: "already-listening", port: PROXY_PORT, pid: process.pid });
                resolve();
                return;
            }
            logger.error("proxy.server.error", { error: String(err), code: err?.code, port: PROXY_PORT });
            reject(err);
        };
        server.once("error", onError);
        server.listen(PROXY_PORT, "127.0.0.1", () => {
            server.off("error", onError);
            upstreamServer = server;
            g.__opencodeProxy.server = server;
            try { (server as any).unref?.(); } catch {}
            logger.info("proxy.started", { port: PROXY_PORT, host: "127.0.0.1", pid: process.pid });
            clearTunnelProbeCache();
            resolve();
        });
    });
}

async function handleProxyRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // Health endpoint for tunnel probe — must respond quickly without body buffering
    if (url.pathname === "/health" || url.pathname === "/__health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, port: PROXY_PORT }));
        return;
    }
    // Determine upstream from the path prefix: /zen/v1/... or /zen/go/v1/...
    let upstream: (typeof UPSTREAMS)[keyof typeof UPSTREAMS] | undefined;
    if (url.pathname.startsWith("/zen/go/v1")) {
        upstream = UPSTREAMS["opencode-go"];
    } else if (url.pathname.startsWith("/zen/v1")) {
        upstream = UPSTREAMS.opencode;
    } else {
        // Default: treat as go upstream.
        upstream = UPSTREAMS["opencode-go"];
    }

    const targetPath = url.pathname + url.search;

    // Buffer the request body so we can inspect the `model` field and decide
    // whether this request must go through the VPN proxy (overseas models).
    const body = await readRequestBody(req);

    let modelId = "";
    try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed.model === "string") {
            modelId = parsed.model;
        }
    } catch {
        // Not JSON (e.g. GET) — no model to inspect.
    }

    const useVpn = shouldUseVpnProxy(modelId);
    const vpnUrl = getVpnProxyUrl();
    if (isVerboseEnabled()) logger.info("proxy.route", { modelId, useVpn, vpnUrl }); else logger.debug("proxy.route", { modelId, useVpn });

    if (useVpn && vpnUrl) {
        // Route through the local VPN proxy (HTTP proxy). For HTTPS upstreams the
        // proxy establishes a CONNECT tunnel; we send the full URL as the path.
        const proxy = new URL(vpnUrl);
        const fullUrl = `${upstream.https ? "https" : "http"}://${upstream.host}${targetPath}`;
        const forwardReq = http.request(
            {
                host: proxy.hostname,
                port: Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)),
                method: req.method,
                path: fullUrl,
                headers: {
                    ...req.headers,
                    host: upstream.host,
                },
            },
            (forwardRes) => {
                res.writeHead(forwardRes.statusCode ?? 502, forwardRes.headers);
                forwardRes.pipe(res);
            }
        );
        forwardReq.on("error", (err) => {
            logger.error("proxy.vpn.error", { error: String(err) });
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: `vpn proxy error: ${String(err)}` } }));
        });
        forwardReq.end(body);
        return;
    }

    const requester = upstream.https ? https.request : http.request;
    const forwardReq = requester(
        {
            host: upstream.host,
            port: upstream.https ? 443 : 80,
            method: req.method,
            path: targetPath,
            headers: {
                ...req.headers,
                host: upstream.host,
            },
        },
        (forwardRes) => {
            res.writeHead(forwardRes.statusCode ?? 502, forwardRes.headers);
            forwardRes.pipe(res);
        }
    );

    forwardReq.on("error", (err) => {
        logger.error("proxy.upstream.error", { error: String(err) });
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `upstream error: ${String(err)}` } }));
    });

    forwardReq.end(body);
}

/** Read the full request body as a string (bounded to avoid memory abuse). */
function readRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const MAX = 64 * 1024 * 1024; // 64 MB safety bound
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX) {
                reject(new Error("request body too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

/** Read the configured VPN proxy URL (empty string disables). */
function getVpnProxyUrl(): string {
    const cfg = vscode.workspace.getConfiguration("opencodego");
    const url = cfg.get<string>("vpnProxyUrl", "http://127.0.0.1:7890");
    return url && url.trim() ? url.trim() : "";
}

/** Dispose the local proxy (called on extension deactivate). */
export function disposeLocalProxy(): void {
    if (upstreamServer) {
        logger.info("proxy.stopped", {});
        upstreamServer.close();
        upstreamServer = undefined;
    }
    probeResult = undefined;
}
