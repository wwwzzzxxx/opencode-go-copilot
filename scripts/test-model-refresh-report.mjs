/**
 * Headless test for the manual model-list refresh path.
 *
 * Covers the two behaviors that made a refresh lie about its result:
 *
 *   1. a refresh must not degrade the model list — when the live catalog is
 *      unreachable it keeps the catalog already in memory instead of replacing
 *      it with the built-in snapshot;
 *   2. the outcome must be inspectable — the catalog/API layers and the
 *      discovery pass report which source actually produced the list, so the
 *      command can warn instead of claiming success.
 *
 * Runs the compiled output against a minimal VS Code shim.
 * Run: node scripts/test-model-refresh-report.mjs (after npm run compile)
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;

// ── VS Code shim ──
const logged = [];
const outputChannel = {
    debug: (...a) => logged.push(["debug", ...a]),
    info: (...a) => logged.push(["info", ...a]),
    warn: (...a) => logged.push(["warn", ...a]),
    error: (...a) => logged.push(["error", ...a]),
    show: () => { },
    dispose: () => { },
};
const vscodeShim = {
    env: { language: "en" },
    window: { createOutputChannel: () => outputChannel },
    workspace: {
        // Only the mirror URL is "configured" (empty), everything else takes the
        // caller's default — which is what the extension does when unset.
        getConfiguration: () => ({ get: (key, fallback) => (key === "opencodego.modelsDevMirrorUrl" ? "" : fallback) }),
    },
};
Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
        return vscodeShim;
    }
    return originalLoad.call(this, request, parent, isMain);
};

const { logger } = require("../out/logger.js");
const modelsDev = require("../out/modelsDev.js");
const apiModelList = require("../out/apiModelList.js");
const provideModel = require("../out/provideModel.js");

logger.init();

const realFetch = globalThis.fetch;
/** Make every fetch fail the way an unreachable network does. */
function fetchUnreachable() {
    globalThis.fetch = async () => {
        throw new TypeError("fetch failed");
    };
}
/** Serve a catalog payload that is clearly distinguishable from the snapshot. */
function fetchLiveCatalog() {
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () =>
            JSON.stringify({
                models: {},
                providers: {
                    "opencode-go": {
                        id: "opencode-go",
                        api: "https://live.example.invalid/v1/",
                        name: "OpenCode Go",
                        models: {
                            "test-model-alpha": { id: "test-model-alpha", name: "Test Alpha" },
                            "test-model-beta": { id: "test-model-beta", name: "Test Beta" },
                        },
                    },
                },
            }),
    });
}

const secretsWithKey = { get: async () => "sk-test" };
const secretsWithoutKey = { get: async () => undefined };
const token = { isCancellationRequested: false };

const LIVE_IDS = ["test-model-alpha", "test-model-beta"];
// Picker IDs carry the "go-" prefix; the catalog and API keep bare IDs.
const EXPOSED_LIVE_IDS = LIVE_IDS.map((id) => `go-${id}`);

// ── 1. Live catalog loads, and the outcome says so ──
fetchLiveCatalog();
await modelsDev.ensureModelsDevLoaded();
let load = modelsDev.getLastCatalogLoadInfo();
assert.equal(load.source, "official", "live catalog should be reported as official");
assert.equal(load.keptPrevious, false);
assert.deepEqual(modelsDev.getCatalogProviderModelIds("opencode-go").sort(), LIVE_IDS);

// ── 2. Unreachable catalog keeps the previous data instead of degrading ──
modelsDev.invalidateModelsDevCache();
fetchUnreachable();
await modelsDev.ensureModelsDevLoaded();
load = modelsDev.getLastCatalogLoadInfo();
assert.equal(load.source, "hardcoded", "fallback must be reported as hardcoded, not as success");
assert.equal(load.keptPrevious, true, "the previously fetched catalog must be kept");
assert.ok(load.errors.length > 0, "the failure reason must be recorded");
assert.deepEqual(
    modelsDev.getCatalogProviderModelIds("opencode-go").sort(),
    LIVE_IDS,
    "a failed refresh must not replace the live catalog with the built-in snapshot"
);

// ── 3. The API model list reports its own failure ──
fetchUnreachable();
await apiModelList.getApiModelIds("sk-test");
let apiInfo = apiModelList.getLastApiListInfo();
assert.equal(apiInfo.success, false);
assert.equal(apiInfo.failure, "fetch_failed");
assert.equal(apiInfo.usedStale, false);

await apiModelList.getApiModelIds(undefined);
apiInfo = apiModelList.getLastApiListInfo();
assert.equal(apiInfo.failure, "no_api_key", "a missing key is a distinct reason");

// ── 4. Discovery report: fallback catalog, unconfirmed server list ──
provideModel.invalidateAutoDiscovery();
fetchUnreachable();
const fallbackInfos = await provideModel.prepareLanguageModelChatInformation({}, token, secretsWithKey);
let report = provideModel.getLastDiscoveryReport();
assert.equal(report.catalogSource, "hardcoded", "report must carry the fallback source");
assert.equal(report.keptPreviousCatalog, true);
assert.equal(report.apiListOk, false);
assert.equal(report.apiListFailure, "fetch_failed");
assert.equal(report.apiFilterApplied, false, "an unfetched server list must not be applied as a filter");
assert.deepEqual(report.ids.slice().sort(), EXPOSED_LIVE_IDS);
assert.deepEqual(provideModel.getDiscoveredModelIds().slice().sort(), EXPOSED_LIVE_IDS);
assert.equal(fallbackInfos.length, LIVE_IDS.length);

// ── 5. Refreshing onto a live catalog reports success and the new models ──
const beforeIds = provideModel.getDiscoveredModelIds();
fetchLiveCatalog();
globalThis.fetch = async (url) =>
    String(url).endsWith("/models")
        ? {
              ok: true,
              status: 200,
              statusText: "OK",
              json: async () => ({ data: [{ id: "test-model-alpha" }, { id: "test-model-beta" }, { id: "test-model-gamma" }] }),
          }
        : {
              ok: true,
              status: 200,
              statusText: "OK",
              text: async () =>
                  JSON.stringify({
                      models: {},
                      providers: {
                          "opencode-go": {
                              id: "opencode-go",
                              api: "https://live.example.invalid/v1/",
                              name: "OpenCode Go",
                              models: {
                                  "test-model-alpha": { id: "test-model-alpha", name: "Test Alpha" },
                                  "test-model-beta": { id: "test-model-beta", name: "Test Beta" },
                                  "test-model-gamma": { id: "test-model-gamma", name: "Test Gamma" },
                              },
                          },
                      },
                  }),
          };
provideModel.invalidateAutoDiscovery();
await provideModel.prepareLanguageModelChatInformation({}, token, secretsWithKey);
report = provideModel.getLastDiscoveryReport();
assert.equal(report.catalogSource, "official");
assert.equal(report.keptPreviousCatalog, false);
assert.equal(report.apiListOk, true);
assert.equal(report.apiFilterApplied, true);
assert.deepEqual(report.ids.slice().sort(), [...EXPOSED_LIVE_IDS, "go-test-model-gamma"]);
const added = report.ids.filter((id) => !beforeIds.includes(id));
assert.deepEqual(added, ["go-test-model-gamma"], "newly served models must be derivable for the notification");

// ── 6. Without an API key the unfiltered catalog is shown and reported ──
// A stale server list is still on hand here, so the catalog keeps being
// filtered by it — the report has to say so, because that can hide models.
provideModel.invalidateAutoDiscovery();
fetchUnreachable();
await provideModel.prepareLanguageModelChatInformation({}, token, secretsWithoutKey);
report = provideModel.getLastDiscoveryReport();
assert.equal(report.apiListFailure, "no_api_key");
assert.equal(report.apiListStale, true, "the applied server list came from an earlier fetch");
assert.equal(report.apiFilterApplied, true, "a stale server list is still applied as a filter");
assert.equal(report.apiListOk, false);

// With no server list at all, nothing is filtered.
apiModelList.clearApiModelCache();
provideModel.invalidateAutoDiscovery();
await provideModel.prepareLanguageModelChatInformation({}, token, secretsWithoutKey);
report = provideModel.getLastDiscoveryReport();
assert.equal(report.apiListFailure, "no_api_key");
assert.equal(report.apiListStale, false);
assert.equal(report.apiFilterApplied, false, "without a server list the catalog must not be filtered");
assert.equal(report.ids.length, 3, "the catalog is shown in full when no server list is available");

// ── 7. The old hard reset is what used to lose the live catalog ──
provideModel.resetAutoDiscoveryState();
fetchUnreachable();
await provideModel.prepareLanguageModelChatInformation({}, token, secretsWithKey);
report = provideModel.getLastDiscoveryReport();
assert.equal(report.keptPreviousCatalog, false, "a full reset drops the in-memory catalog");
assert.ok(
    report.catalogModelCount > LIVE_IDS.length,
    "after a full reset the built-in snapshot is the only fallback (the old, degrading behavior)"
);
assert.ok(
    !report.ids.includes(EXPOSED_LIVE_IDS[0]),
    "the live catalog is gone after a full reset — which is why the refresh command no longer resets it"
);

globalThis.fetch = realFetch;

console.log("model refresh report: all assertions passed");
