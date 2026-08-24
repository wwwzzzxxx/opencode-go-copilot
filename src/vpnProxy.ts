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
 *
 * IMPORTANT — direct-connect guarantee:
 *   undici is bundled with THIS extension (not resolved from the VS Code install).
 *   Every request is sent with an EXPLICIT dispatcher:
 *     - models matched by vpnProxyModels  -> ProxyAgent(127.0.0.1:7890)
 *     - all other models                 -> plain Agent (NO proxy)
 *   An explicit dispatcher means undici never consults HTTP_PROXY / HTTPS_PROXY
 *   environment variables or the VS Code http.proxy setting, so requests for
 *   non-VPN models are FORCED direct even when the machine has a system/global
 *   proxy configured (e.g. Clash system proxy). This prevents unstable proxy
 *   connections from silently truncating long streaming responses.
 *--------------------------------------------------------------------------------------------*/
import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";
import * as vscode from "vscode";
import { isRemote } from "./proxyManager";
import { logger } from "./logger";

/** Default proxy endpoint (Clash / v2rayN style local HTTP proxy). */
const DEFAULT_PROXY_URL = "http://127.0.0.1:7890";

/** Cache of the undici ProxyAgent per proxy URL. */
const proxyAgentCache = new Map<string, ProxyAgent>();

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
 * Non-VPN models get an explicit plain undici Agent (direct only — never the
 * global dispatcher, so HTTP_PROXY / HTTPS_PROXY env vars and the VS Code
 * http.proxy setting are all ignored for them).
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
    const remote = isRemote();
    if (remote) {
        const agent = new Agent({ bodyTimeout: requestTimeoutMs });
        logger.info("vpn.route", { modelId, action: "tunnel-plain", isRemote: true });
        return (url: RequestInfo | URL, init?: RequestInit) => {
            // undici 8 typings differ from the DOM lib; runtime behavior is identical.
            return undiciFetch(url as any, { ...init, dispatcher: agent } as any) as any;
        };
    }

    const useProxy = shouldUseVpnProxy(modelId);
    const proxyUrl = getProxyUrl();

    if (useProxy) {
        let agent = proxyAgentCache.get(proxyUrl);
        if (!agent) {
            agent = new ProxyAgent({
                uri: proxyUrl,
                requestTls: { rejectUnauthorized: false },
            });
            proxyAgentCache.set(proxyUrl, agent);
        }
        logger.info("vpn.route", { modelId, proxyUrl, action: "proxy", isRemote: false });
        return (url: RequestInfo | URL, init?: RequestInit) => {
            return undiciFetch(url as any, { ...init, dispatcher: agent } as any) as any;
        };
    }

    // Forced direct: explicit plain Agent dispatcher (no env proxy, no system proxy).
    const agent = new Agent({ bodyTimeout: requestTimeoutMs });
    logger.info("vpn.route", { modelId, action: "direct", isRemote: false });
    return (url: RequestInfo | URL, init?: RequestInit) => {
        return undiciFetch(url as any, { ...init, dispatcher: agent } as any) as any;
    };
}