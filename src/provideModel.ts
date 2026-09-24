import * as vscode from "vscode";
import { CancellationToken, LanguageModelChatInformation, PrepareLanguageModelChatModelOptions } from "vscode";

import { logger } from "./logger";
import { getApiModelIds, clearApiModelCache, getLastApiListInfo, invalidateApiModelCache, type ApiListFailure } from "./apiModelList";
import {
    ensureModelsDevLoaded,
    clearModelsDevCache,
    getCatalogProviderModelIds,
    getLastCatalogLoadInfo,
    invalidateModelsDevCache,
    type CatalogSource,
} from "./modelsDev";
import { buildCatalogModelInfo, isModelDeprecated } from "./catalogModels";
import { delay } from "./utils";

const GO_PROVIDER_ID = "opencode-go";

let isUpdatingModelsDev = false;
let lastModelsDevUpdate = 0;
let cachedDiscoveredInfos: LanguageModelChatInformation[] | null = null;

/**
 * How the last catalog pass went. The manual refresh command reports this to
 * the user: a refresh that fell back to the built-in snapshot, or that could
 * not confirm the server's model list, is not a plain success.
 */
export interface DiscoveryReport {
    /** Where the catalog data came from, or "failed" when nothing is available. */
    catalogSource: CatalogSource | "failed";
    /** True when the live fetch failed and the previously fetched catalog was kept. */
    keptPreviousCatalog: boolean;
    /** Errors from the official → mirror fallback chain, in attempt order. */
    catalogErrors: string[];
    /** Model count the Go catalog holds (before API filtering). */
    catalogModelCount: number;
    /** Whether the server model list was fetched successfully. */
    apiListOk: boolean;
    /** Why the server model list is unusable, when it is. */
    apiListFailure: ApiListFailure;
    apiListError?: string;
    /** True when the server list came from an earlier fetch. */
    apiListStale: boolean;
    /** True when the server list was applied as a filter. */
    apiFilterApplied: boolean;
    /** Model IDs exposed to VS Code by this pass. */
    ids: string[];
    timestamp: number;
}

let lastDiscoveryReport: DiscoveryReport | null = null;

/** The most recent catalog pass outcome, or null if no pass has finished yet. */
export function getLastDiscoveryReport(): DiscoveryReport | null {
    return lastDiscoveryReport;
}

/** IDs of the models currently exposed to VS Code (for diffing across refreshes). */
export function getDiscoveredModelIds(): string[] {
    return (cachedDiscoveredInfos ?? []).map((info) => info.id);
}

/**
 * Build the full OpenCode Go model list from the catalog.
 * When the API model list is available, models the server does not serve are
 * filtered out (this also drops stale/dirty IDs the API may return, e.g. ones
 * absent from the catalog). When the API is unreachable, the full catalog list
 * is returned.
 */
async function runCatalogPass(secrets: vscode.SecretStorage): Promise<LanguageModelChatInformation[] | null> {
    // The catalog governs model behaviour (apiMode, thinking, vision, context
    // limits) and the API base URL — it must be loaded first.
    await ensureModelsDevLoaded();

    const load = getLastCatalogLoadInfo();
    const catalogIds = getCatalogProviderModelIds(GO_PROVIDER_ID);
    if (catalogIds.length === 0) {
        logger.info("models.discovery", {
            action: "fallback",
            reason: "catalog_empty_or_failed",
        });
        lastDiscoveryReport = {
            catalogSource: load?.source ?? "failed",
            keptPreviousCatalog: load?.keptPrevious ?? false,
            catalogErrors: load?.errors ?? [],
            catalogModelCount: 0,
            apiListOk: false,
            apiListFailure: null,
            apiListStale: false,
            apiFilterApplied: false,
            ids: [],
            timestamp: Date.now(),
        };
        return null;
    }

    // Optionally filter against the actual API model list
    let availableIds = catalogIds;
    let apiFilterApplied = false;
    const config = vscode.workspace.getConfiguration();
    const enableAutoDiscovery = config.get<boolean>("opencodego.enableAutoModelDiscovery", true);
    if (enableAutoDiscovery) {
        const apiKey = await secrets.get("opencodego.apiKey");
        const apiModelIds = await getApiModelIds(apiKey);
        if (apiModelIds.size > 0) {
            availableIds = catalogIds.filter((id) => apiModelIds.has(id));
            apiFilterApplied = true;
        }
    }

    // Drop deprecated models from the picker unless the user opts in to see them
    const showDeprecated = vscode.workspace.getConfiguration().get<boolean>("opencodego.showDeprecatedModels", false);
    const infos = availableIds
        .filter((id) => showDeprecated || !isModelDeprecated(GO_PROVIDER_ID, id))
        .map((id) => buildCatalogModelInfo(GO_PROVIDER_ID, id));

    logger.info("models.discovery", {
        action: "catalog_loaded",
        catalogCount: catalogIds.length,
        availableCount: infos.length,
        ids: infos.map((i) => i.id).join(", "),
    });

    const api = getLastApiListInfo();
    lastDiscoveryReport = {
        catalogSource: load?.source ?? "failed",
        keptPreviousCatalog: load?.keptPrevious ?? false,
        catalogErrors: load?.errors ?? [],
        catalogModelCount: catalogIds.length,
        apiListOk: api?.success ?? false,
        apiListFailure: api?.failure ?? null,
        apiListError: api?.error,
        apiListStale: api?.usedStale ?? false,
        apiFilterApplied,
        ids: infos.map((i) => i.id),
        timestamp: Date.now(),
    };

    return infos;
}

async function waitForPendingUpdate(token: CancellationToken): Promise<void> {
    while (isUpdatingModelsDev && !token.isCancellationRequested) {
        await delay(200, token);
    }
}

export function resetAutoDiscoveryState(): void {
    isUpdatingModelsDev = false;
    lastModelsDevUpdate = 0;
    cachedDiscoveredInfos = null;
    clearApiModelCache();
    clearModelsDevCache();
    logger.info("models.discovery", {
        action: "reset",
    });
}

/**
 * Force the next pass to refetch while keeping the data already in memory.
 *
 * Used by the manual refresh command: a refresh must not make the list worse.
 * Dropping the in-memory catalog first would leave the built-in snapshot as the
 * only fallback, so a refresh performed while the live catalog is unreachable
 * would replace a recent model list with a stale one.
 */
export function invalidateAutoDiscovery(): void {
    isUpdatingModelsDev = false;
    lastModelsDevUpdate = 0;
    invalidateModelsDevCache();
    invalidateApiModelCache();
    logger.info("models.discovery", {
        action: "invalidate",
    });
}

export async function prepareLanguageModelChatInformation(
    options: PrepareLanguageModelChatModelOptions,
    _token: CancellationToken,
    _secrets: vscode.SecretStorage
): Promise<LanguageModelChatInformation[]> {
    if (_token.isCancellationRequested) {
        return cachedDiscoveredInfos ?? [];
    }

    const config = vscode.workspace.getConfiguration();
    const updateInterval = config.get<number>("opencodego.modelsDevUpdateInterval", 60 * 1000);
    const now = Date.now();

    // ── Catalog Pass ──
    if (isUpdatingModelsDev) {
        await waitForPendingUpdate(_token);
    } else if (now - lastModelsDevUpdate >= updateInterval) {
        isUpdatingModelsDev = true;
        try {
            if (!_token.isCancellationRequested) {
                const discovered = await runCatalogPass(_secrets);
                if (discovered) {
                    cachedDiscoveredInfos = discovered;
                    lastModelsDevUpdate = Date.now();
                }
            }
        } catch (error) {
            logger.error("models.discovery", {
                action: "error",
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            isUpdatingModelsDev = false;
        }
    }

    // ── Assemble Model List ──
    return cachedDiscoveredInfos ? [...cachedDiscoveredInfos] : [];
}