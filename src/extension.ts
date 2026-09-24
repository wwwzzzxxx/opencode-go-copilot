import * as vscode from "vscode";
import { OpenCodeGoChatModelProvider } from "./provider";
import { initStatusBar, refreshGoUsageNow } from "./statusBar";
import { formatUsageSummary, getUsageFetchStatus } from "./goUsage";
import { logger } from "./logger";
import { l10n, l10nFormat } from "./localize";
import type { ModelPreset } from "./types";
import { VersionManager } from "./versionManager";
import { abortCommitGeneration, generateCommitMsg } from "./gitCommit/commitMessageGenerator";
import { TokenizerManager } from "./tokenizer/tokenizerManager";
import { prepareLanguageModelChatInformation, invalidateAutoDiscovery, getLastDiscoveryReport, getDiscoveredModelIds } from "./provideModel";
import { HARDCODED_SNAPSHOT_DATE } from "./hardcodedModelList";
import { maybeStartLocalProxy } from "./proxyManager";
import { pickPdfFileToAttach } from "./pdf/attach";
import { setChatSessionRoot } from "./pdf/chatStore";

// ---- Walkthrough / Welcome constants ----

/** memento key tracking whether the welcome walkthrough has been shown. */
const WELCOME_SHOWN_KEY = "opencodego.welcomeShown";

/** Walkthrough contribution ID (publisher.extension#walkthroughId). */
const WALKTHROUGH_ID = "OnesoftQwQ.opencode-go-copilot-provider#opencodeGoGettingStarted";

export function activate(context: vscode.ExtensionContext) {
    // Initialize logger
    logger.init();
    logger.info("extension.activate", { version: VersionManager.getVersion(), remoteName: vscode.env.remoteName ?? null, uiKind: (vscode.env as any).uiKind ?? null });

    // Point dragged-PDF recovery at this window's chat session store
    // (`<userData>/User/workspaceStorage/<hash>/chatSessions`). In a remote window that
    // directory does not exist here — the store lives on the client — and the lookup
    // degrades to a no-op.
    setChatSessionRoot(context.storageUri?.fsPath);

    // Start local proxy for SSH remote forwarding (only runs on UI host, no-op on remote)
    void maybeStartLocalProxy(context.secrets);

    // Initialize TokenizerManager with extension path
    TokenizerManager.initialize(context.extensionPath);

    const tokenCountStatusBarItem: vscode.StatusBarItem = initStatusBar(context, context.secrets);
    const provider = new OpenCodeGoChatModelProvider(context.secrets, tokenCountStatusBarItem);

    // Register the OpenCode Go provider under the vendor id used in package.json
    context.subscriptions.push(
        vscode.lm.registerLanguageModelChatProvider("opencodego", provider),
        provider
    );

    // Management command to configure API key
    context.subscriptions.push(
        vscode.commands.registerCommand("opencodego.setApiKey", async () => {
            const existing = await context.secrets.get("opencodego.apiKey");
            const apiKey = await vscode.window.showInputBox({
                title: l10n("OpenCode Go Provider API Key"),
                prompt: existing ? l10n("Update your OpenCode Go API key") : l10n("Enter your OpenCode Go API key"),
                ignoreFocusOut: true,
                password: true,
                value: existing ?? "",
            });
            if (apiKey === undefined) {
                return; // user canceled
            }
            if (!apiKey.trim()) {
                await context.secrets.delete("opencodego.apiKey");
                vscode.window.showInformationMessage(l10n("OpenCode Go API key cleared."));
                return;
            }
            await context.secrets.store("opencodego.apiKey", apiKey.trim());
            vscode.window.showInformationMessage(l10n("OpenCode Go API key saved."));
        })
    );

    // Manually trigger model list update command.
    // The result is reported from the real outcome: a refresh that fell back to
    // the built-in snapshot, or that could not confirm the server's model list,
    // is not a success. Previously this always claimed success, so a refresh
    // performed while the live catalog was unreachable silently served an old
    // model list (missing recently added models) with a green toast.
    context.subscriptions.push(
        vscode.commands.registerCommand("opencodego.updateModelList", async () => {
            try {
                const before = getDiscoveredModelIds();
                invalidateAutoDiscovery();
                await prepareLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token, context.secrets);

                const report = getLastDiscoveryReport();
                if (!report || report.ids.length === 0) {
                    logger.error("models.update.failed", { reason: "no_catalog", report });
                    vscode.window.showErrorMessage(l10n("Failed to update OpenCode Go model list: no model catalog available. See output for details."));
                    return;
                }

                const live = report.catalogSource === "official" || report.catalogSource === "mirror";
                const reason = report.catalogErrors[0] ?? "unknown error";

                // Diff against the previously exposed list; an empty "before" means
                // VS Code had not asked for models yet, so nothing is "new".
                const haveBefore = before.length > 0;
                const added = haveBefore ? report.ids.filter((id) => !before.includes(id)) : [];
                const removed = haveBefore ? before.filter((id) => !report.ids.includes(id)) : [];
                const summarized = added.slice(0, 6).join(", ") + (added.length > 6 ? l10nFormat(" and {0} more", added.length - 6) : "");

                logger.info("models.update.result", {
                    source: report.catalogSource,
                    keptPreviousCatalog: report.keptPreviousCatalog,
                    catalogCount: report.catalogModelCount,
                    shownCount: report.ids.length,
                    apiListOk: report.apiListOk,
                    apiFilterApplied: report.apiFilterApplied,
                    added,
                    removed,
                    errors: report.catalogErrors,
                });

                if (!live) {
                    // Live catalog unreachable: say so, and name the fallback data.
                    const message = report.keptPreviousCatalog
                        ? l10nFormat("Could not fetch the online model catalog ({0}). Kept the previously fetched catalog ({1} models).", reason, report.ids.length)
                        : l10nFormat("Could not fetch the online model catalog ({0}). Using the built-in snapshot ({1} models, dated {2}) — recently added models may be missing.", reason, report.ids.length, HARDCODED_SNAPSHOT_DATE);
                    const choice = await vscode.window.showWarningMessage(message, l10n("Show Log"));
                    if (choice) {
                        logger.show();
                    }
                    return;
                }

                // Live catalog, but the server's own model list is not confirmed.
                if (!report.apiListOk && report.apiFilterApplied && report.apiListStale) {
                    // An older server list is filtering the catalog: that can hide
                    // models the server started serving since it was fetched.
                    const choice = await vscode.window.showWarningMessage(
                        l10nFormat("The server model list could not be refreshed ({0}); the list is filtered by an earlier fetch ({1} models shown), so newly added models may be missing.", report.apiListError ?? l10n("request failed"), report.ids.length),
                        l10n("Show Log")
                    );
                    if (choice) {
                        logger.show();
                    }
                } else if (!report.apiListOk && !report.apiFilterApplied) {
                    if (report.apiListFailure === "no_api_key") {
                        vscode.window.showInformationMessage(
                            l10nFormat("Catalog updated ({0} models). The server model list was not checked: no API key configured.", report.ids.length)
                        );
                    } else {
                        const choice = await vscode.window.showWarningMessage(
                            l10nFormat("Catalog updated ({0} models), but the server's model list could not be fetched ({1}). The list may include models the server does not serve.", report.ids.length, report.apiListError ?? l10n("request failed")),
                            l10n("Show Log")
                        );
                        if (choice) {
                            logger.show();
                        }
                    }
                } else if (added.length > 0) {
                    vscode.window.showInformationMessage(
                        l10nFormat("Model list updated: {0} models available. New: {1}", report.ids.length, summarized)
                    );
                } else if (haveBefore) {
                    vscode.window.showInformationMessage(
                        l10nFormat("Model list updated: {0} models available, no new models.", report.ids.length)
                    );
                } else {
                    // Nothing to diff against: VS Code had not asked for models yet.
                    vscode.window.showInformationMessage(
                        l10nFormat("Model list updated: {0} models available.", report.ids.length)
                    );
                }

                // A new list is only useful if VS Code re-reads it; the picker
                // otherwise keeps the copy it fetched earlier.
                if (added.length > 0 || removed.length > 0 || live) {
                    provider.notifyModelsChanged();
                }
            } catch (error) {
                logger.error("models.update.failed", { error: String(error) });
                vscode.window.showErrorMessage(l10n("Failed to update OpenCode Go model list. See output for details."));
            }
        })
    );

    // Command to check / refresh the OpenCode Go plan usage.
    // Also bound to clicking the status bar item (see statusBar.ts).
    context.subscriptions.push(
        vscode.commands.registerCommand("opencodego.checkUsage", async () => {
            const apiKey = await context.secrets.get("opencodego.apiKey");
            if (!apiKey) {
                vscode.window.showWarningMessage(l10n("No API key configured. Please run the 'OpenCode Go: Set API Key' command first."));
                return;
            }
            const usage = await refreshGoUsageNow();
            if (!usage) {
                if (getUsageFetchStatus() === "unauthorized") {
                    vscode.window.showErrorMessage(l10n("OpenCode Go usage is unavailable (no active Go plan)."));
                } else {
                    vscode.window.showErrorMessage(l10n("Failed to fetch OpenCode Go usage. See output for details."));
                }
                return;
            }
            vscode.window.showInformationMessage(`OpenCode Go: ${formatUsageSummary(usage)}`);
        })
    );

    // Command to attach a PDF by hand. VS Code never tells a third-party model provider
    // which PDF was dragged into the chat (no path, no bytes — see src/pdf/), so this is
    // the reliable way to hand a document to a PDF-capable model natively.
    context.subscriptions.push(
        vscode.commands.registerCommand("opencodego.attachPdf", async () => {
            const configured = vscode.workspace.getConfiguration("opencodego").get<number>("pdfMaxMB", 20);
            const maxBytes = (typeof configured === "number" && configured > 0 ? configured : 20) * 1024 * 1024;
            await pickPdfFileToAttach(maxBytes);
        })
    );

    // Command to open the OpenCode Go website to get an API key
    context.subscriptions.push(
        vscode.commands.registerCommand("opencodego.getApiKey", () => {
            vscode.env.openExternal(vscode.Uri.parse("https://opencode.ai/auth"));
        })
    );

    // Command to open extension settings
    context.subscriptions.push(
        vscode.commands.registerCommand("opencodego.openSettings", () => {
            vscode.commands.executeCommand("workbench.action.openSettings", "@ext:OnesoftQwQ.opencode-go-copilot-provider");
        })
    );

    // Register the generateGitCommitMessage command handler
    context.subscriptions.push(
        vscode.commands.registerCommand("opencodego.generateGitCommitMessage", async (scm) => {
            generateCommitMsg(context.secrets, scm);
        }),
        vscode.commands.registerCommand("opencodego.abortGitCommitMessage", () => {
            abortCommitGeneration();
        }),
    );

    // Register the setModelPreset command: user can select a preset via QuickPick
    context.subscriptions.push(
        vscode.commands.registerCommand("opencodego.setModelPreset", async () => {
            const config = vscode.workspace.getConfiguration();
            const presets = config.get<ModelPreset[]>("opencodego.modelPresets", []);
            const currentPresetId = config.get<string>("opencodego.modelPreset", "custom");
            const currentTemp = config.get<number | null>("opencodego.temperature", null);
            const currentTopP = config.get<number | null>("opencodego.top_p", null);

            interface PresetQuickPickItem extends vscode.QuickPickItem {
                presetId?: string;
            }

            // Mark the currently active preset with " (当前)"
            const presetItems: PresetQuickPickItem[] = presets.map((p) => ({
                label: `${l10n(p.label)} (${p.temperature})${p.id === currentPresetId ? l10n(" (current)") : ""}`,
                presetId: p.id,
            }));

            // Mark custom option with current values if active
            const isCustomActive = currentPresetId === "custom";
            const customLabel = "$(pencil) " + l10n("Custom (manual input)")
                + (isCustomActive
                    ? ` ${l10nFormat("(current, temperature: {0}, top_p: {1})", String(currentTemp ?? "—"), String(currentTopP ?? "—"))}`
                    : "");

            const customItem: PresetQuickPickItem = {
                label: customLabel,
            };

            const items: PresetQuickPickItem[] = [
                ...presetItems,
                { label: "", kind: vscode.QuickPickItemKind.Separator },
                customItem,
            ];

            const title = l10n("Set Model Preset");

            const picked = await vscode.window.showQuickPick(items, {
                title,
                placeHolder: l10n("Select a preset"),
                ignoreFocusOut: true,
            });

            if (!picked) {
                return;
            }

            const presetId = picked.presetId;

            if (presetId) {
                // User selected a named preset
                const matchedPreset = presets.find((p) => p.id === presetId);
                if (matchedPreset) {
                    await config.update("opencodego.modelPreset", matchedPreset.id, vscode.ConfigurationTarget.Global);
                    await config.update("opencodego.temperature", matchedPreset.temperature, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(
                        l10nFormat("Set to temperature: {0} ({1})", String(matchedPreset.temperature), l10n(matchedPreset.label))
                    );
                }
            } else {
                // User chose "Custom (manual input)"
                const currentVal = currentTemp !== null && currentTopP !== null
                    ? `${currentTemp},${currentTopP}`
                    : "";
                const inputValue = await vscode.window.showInputBox({
                    title: l10n("Enter custom temperature"),
                    prompt: l10n("Enter a single number for temperature only (<=2), or two comma-separated numbers for temperature and top_p (temp<=2, top_p<=1), e.g.: 0.7 or 0.7,0.95"),
                    value: currentVal,
                    validateInput: (val: string) => {
                        const trimmed = val.trim();
                        if (!trimmed) {
                            return l10n("Please enter at least temperature value");
                        }
                        const parts = trimmed.split(",");
                        if (parts.length > 2) {
                            return l10n("Please enter at most two numbers separated by a comma");
                        }
                        const temp = parseFloat(parts[0].trim());
                        if (isNaN(temp) || temp < 0 || temp > 2) {
                            return l10n("Temperature must be between 0.0 and 2.0");
                        }
                        if (parts.length === 2) {
                            const topP = parseFloat(parts[1].trim());
                            if (isNaN(topP) || topP < 0 || topP > 1) {
                                return l10n("top_p must be between 0.0 and 1.0");
                            }
                        }
                        return null;
                    },
                    ignoreFocusOut: true,
                });
                if (inputValue !== undefined) {
                    const trimmed = inputValue.trim();
                    const parts = trimmed.split(",");
                    const tempNum = parseFloat(parts[0].trim());
                    await config.update("opencodego.modelPreset", "custom", vscode.ConfigurationTarget.Global);
                    await config.update("opencodego.temperature", tempNum, vscode.ConfigurationTarget.Global);
                    if (parts.length === 2) {
                        const topPNum = parseFloat(parts[1].trim());
                        await config.update("opencodego.top_p", topPNum, vscode.ConfigurationTarget.Global);
                        vscode.window.showInformationMessage(
                            l10nFormat("Set to temp: {0}, top_p: {1} (custom)", String(tempNum), String(topPNum))
                        );
                    } else {
                        vscode.window.showInformationMessage(
                            l10nFormat("Set to temperature: {0} (custom)", String(tempNum))
                        );
                    }
                }
            }
        })
    );

    // Register the setMaxContextLength command: user can pick a preset or enter custom value
    context.subscriptions.push(
        vscode.commands.registerCommand("opencodego.setMaxContextLength", async () => {
            const config = vscode.workspace.getConfiguration();
            const current = config.get<number>("opencodego.maxContextLength", 0);
            const presets: Array<{ label: string; value: number; description?: string }> = [
                { label: l10n("Unlimited (follow model)"), value: 0, description: l10n("0 - no cap") },
                { label: "128K", value: 128000 },
                { label: "200K", value: 200000 },
                { label: "300K", value: 300000 },
                { label: "500K", value: 500000 },
                { label: "1M", value: 1000000 },
            ];
            interface PickItem extends vscode.QuickPickItem {
                value?: number;
                isCustom?: boolean;
            }
            const items: PickItem[] = presets.map((p) => ({
                label: `${p.label}${p.value === current ? l10n(" (current)") : ""}`,
                description: p.description ?? (p.value === 0 ? "" : `${p.value}`),
                value: p.value,
            }));
            items.push({ label: "", kind: vscode.QuickPickItemKind.Separator } as PickItem);
            items.push({ label: "$(pencil) " + l10n("Custom value..."), isCustom: true, description: l10n("Enter number of tokens, 0 for unlimited") });

            const picked = await vscode.window.showQuickPick(items, {
                title: l10n("Set Maximum Context Length"),
                placeHolder: l10n("Select a limit (only caps models larger than this)"),
                ignoreFocusOut: true,
            });
            if (!picked) return;
            let newVal: number | undefined;
            if (picked.isCustom) {
                const input = await vscode.window.showInputBox({
                    title: l10n("Enter maximum context length"),
                    prompt: l10n("Enter tokens (e.g. 200000) or 0 for unlimited"),
                    value: String(current ?? 0),
                    validateInput: (val) => {
                        const n = Number(val.trim());
                        if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return l10n("Please enter a non-negative integer (0 = unlimited)");
                        return null;
                    },
                    ignoreFocusOut: true,
                });
                if (input === undefined) return;
                newVal = Math.floor(Number(input.trim()));
            } else {
                newVal = picked.value ?? 0;
            }
            await config.update("opencodego.maxContextLength", newVal, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(newVal === 0 ? l10n("Maximum context length cleared (unlimited)") : l10nFormat("Maximum context length set to {0}", String(newVal)));
        })
    );

    // Warm up model discovery on every activation (non-blocking, fire-and-forget).
    // VS Code may fire several activation events at startup; the short refresh
    // interval in prepareLanguageModelChatInformation (default 1 minute) dedupes
    // concurrent calls so the API is not spammed. The models.dev catalog is
    // fetched before the model list. On failure it degrades silently to the
    // built-in model list.
    void prepareLanguageModelChatInformation(
        { silent: true },
        new vscode.CancellationTokenSource().token,
        context.secrets
    ).catch((error) => {
        logger.error("models.warmup.failed", {
            error: error instanceof Error ? error.message : String(error),
        });
    });

    // Show welcome walkthrough on first install (when no API key is configured)
    showWelcomeIfNeeded(context);

    // Dispose logger on deactivate
    context.subscriptions.push({
        dispose: () => logger.dispose(),
    });
}

/**
 * Show the welcome walkthrough on first activation if no API key is configured.
 * Once shown (or if a key already exists) the flag is persisted so it won't
 * reappear after subsequent reloads.
 */
async function showWelcomeIfNeeded(context: vscode.ExtensionContext): Promise<void> {
    try {
        if (context.globalState.get<boolean>(WELCOME_SHOWN_KEY)) {
            return;
        }
        const apiKey = await context.secrets.get("opencodego.apiKey");
        if (apiKey) {
            // API key already set — no need to show welcome
            await context.globalState.update(WELCOME_SHOWN_KEY, true);
            return;
        }
        await vscode.commands.executeCommand("workbench.action.openWalkthrough", WALKTHROUGH_ID, false);
        await context.globalState.update(WELCOME_SHOWN_KEY, true);
    } catch (error) {
        logger.warn("Failed to show welcome walkthrough", { error: String(error) });
    }
}

export function deactivate() { }
