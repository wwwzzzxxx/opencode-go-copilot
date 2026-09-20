#!/usr/bin/env node
/**
 * Package the extension into a VSIX at the workspace root.
 *
 *   node scripts/build-vsix.mjs        # == npm run build
 *
 * Output: <workspace root>/opencode-go-copilot-provider-<version>.vsix
 * (the workspace root is the parent of this extension, per AGENTS.md §4.1).
 * Older VSIXs of this extension in that directory are deleted, so the root always
 * holds exactly the newest artifact.
 *
 * Never pass `--no-dependencies`: @microsoft/tiktokenizer must be bundled or the
 * installed extension fails to activate with "Cannot find module".
 */

import { execSync } from "node:child_process";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Artifact base name — the package name carries the fork prefix (`magai-`), the file does not. */
const ARTIFACT_BASE = "opencode-go-copilot-provider";

const extRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(extRoot, "..");
const { version } = JSON.parse(readFileSync(join(extRoot, "package.json"), "utf8"));
const outFile = join(workspaceRoot, `${ARTIFACT_BASE}-${version}.vsix`);
const keep = `${ARTIFACT_BASE}-${version}.vsix`;

for (const entry of readdirSync(workspaceRoot)) {
    if (entry.startsWith(`${ARTIFACT_BASE}-`) && entry.endsWith(".vsix") && entry !== keep) {
        unlinkSync(join(workspaceRoot, entry));
        console.log(`removed old artifact: ${entry}`);
    }
}

console.log(`packaging ${ARTIFACT_BASE}@${version} -> ${outFile}`);
// `execSync` (not execFileSync): Node 20+ refuses to spawn `npx.cmd` directly on Windows.
// The out path is quoted for the shell, so spaces in the workspace path are fine.
// (`--allow-all-proposed-apis` is a publish-only flag; package does not accept it.)
execSync(`npx --yes @vscode/vsce package --out "${outFile}"`, {
    cwd: extRoot,
    stdio: "inherit",
});
