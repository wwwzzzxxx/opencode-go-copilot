/*---------------------------------------------------------------------------------------------
 * VPN proxy routing for "foreign" models.
 *
 * Some models (e.g. muse-spark, gpt*) are hosted by overseas providers and may need to go
 * through a local VPN/proxy (e.g. Clash on 127.0.0.1:7890) to be reachable from mainland
 * China networks. This module decides, per model id, whether the request should be routed
 * through the VPN proxy, and builds the matching undici dispatcher.
 *
 * Configuration:
 *   - opencodego.vpnProxyUrl   (default "http://127.0.0.1:7890")  proxy endpoint
 *   - opencodego.vpnProxyModels (default overseas provider prefixes)  model id patterns
 *
 * The feature is active only when the effective model list is non-empty (set
 * opencodego.vpnProxyModels to [] to disable).
 *--------------------------------------------------------------------------------------------*/
import * as path from "path";
import * as vscode from "vscode";
import { logger } from "./logger";

/** Default proxy endpoint (Clash / v2rayN style local HTTP proxy). */
const DEFAULT_PROXY_URL = "http://127.0.0.1:7890";

/** Cache of the undici ProxyAgent per proxy URL. */
const proxyAgentCache = new Map<string, unknown>();

function getProxyUrl(): string {
    const cfg = vscode.workspace.getConfiguration("opencodego");
    const url = cfg.get<string>("vpnProxyUrl", DEFAULT_PROXY_URL);
    return url && url.trim() ? url.trim() : DEFAULT_PROXY_URL;
}

/**
 * Effective list of foreign-model patterns.
 * All patterns live in the opencodego.vpnProxyModels setting (default includes
 * built-in overseas provider prefixes). Users can add or remove entries directly
 * from VS Code Settings UI — no code-level hardcoding needed.
 */
function getForeignPatterns(): string[] {
    const cfg = vscode.workspace.getConfiguration("opencodego");
    const userPatterns = cfg.get<string[]>("vpnProxyModels", []);
    return [...(userPatterns ?? [])];
}

/**
 * Whether any VPN routing rules are configured (patterns non-empty).
 * Used to decide if the local proxy must run even when localProxyMode is "none"
 * (VPN models always need the tunnel → local proxy → Clash path).
 */
export function hasVpnRules(): boolean {
    return getForeignPatterns().length > 0;
}

/**
 * Whether the given model id should be routed through the VPN proxy.
 * The feature is active only when the effective pattern list is non-empty.
 */
export function shouldUseVpnProxy(modelId: string): boolean {
    const patterns = getForeignPatterns();
    if (patterns.length === 0) {
        return false;
    }
    const id = modelId.toLowerCase();
    return patterns.some((p) => p && id.includes(p.toLowerCase()));
}

/**
 * Create a fetch function that routes through the VPN proxy for the given model id.
 * Falls back to a plain fetch (no proxy) when the model does not need the proxy or
 * undici is unavailable.
 */
export function createVpnAwareFetch(
    modelId: string,
    requestTimeoutMs: number
): typeof fetch {
    // On the remote (SSH) side, VPN routing is NOT applied here.
    // Requests already flow through the SSH tunnel → local proxy → upstream,
    // and the local proxy decides whether to route via VPN.
    // Applying VPN proxy on the remote side would try to reach 127.0.0.1:7890
    // on the REMOTE machine, which doesn't have Clash running.
    const isRemote = vscode.env.remoteName !== undefined;
    if (isRemote) {
        logger.info("vpn.route", { modelId, action: "tunnel-plain" });
        // Return a plain undici fetch with body timeout (no VPN agent)
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            let undici: any;
            try {
                undici = require(path.join(vscode.env.appRoot, "node_modules", "undici"));
            } catch {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                undici = require("undici");
            }
            const agent = new undici.Agent({ bodyTimeout: requestTimeoutMs });
            return (url: RequestInfo | URL, init?: RequestInit) => {
                return undici.fetch(url, { ...init, dispatcher: agent });
            };
        } catch {
            return fetch;
        }
    }

    const useProxy = shouldUseVpnProxy(modelId);
    const proxyUrl = getProxyUrl();

    try {
        // Load undici: prefer the one bundled with the VS Code installation, fall back to
        // a plain require (extension host resolves it) when that path is unavailable.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        let undici: any;
        try {
            undici = require(path.join(vscode.env.appRoot, "node_modules", "undici"));
        } catch {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            undici = require("undici");
        }
        if (useProxy) {
            let agent = proxyAgentCache.get(proxyUrl);
            if (!agent) {
                agent = new undici.ProxyAgent({
                    uri: proxyUrl,
                    requestTls: { rejectUnauthorized: false },
                });
                proxyAgentCache.set(proxyUrl, agent);
            }
            logger.info("vpn.route", { modelId, proxyUrl, action: "proxy" });
            return (url: RequestInfo | URL, init?: RequestInit) => {
                return undici.fetch(url, { ...init, dispatcher: agent });
            };
        }
        const agent = new undici.Agent({ bodyTimeout: requestTimeoutMs });
        logger.info("vpn.route", { modelId, action: "direct" });
        return (url: RequestInfo | URL, init?: RequestInit) => {
            return undici.fetch(url, { ...init, dispatcher: agent });
        };
    } catch {
        return fetch;
    }
}