#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  configDirectory,
  findConfigFile,
  installPackage,
  latestVersion,
  PACKAGE_NAME,
  packageVersion,
  orchestrationOptions,
  reconcileAgentFiles,
  removeAgentFilesManifest,
  restoreBackup,
  status as installationStatus,
  uninstallPackage,
  validateOpenCode,
  writeAgentFilesManifest,
  writePluginConfig,
} from "../src/installer.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hooksPath = join(homedir(), ".config", "opencode-herdr-orchestration", "hooks");
const sourceHook = join(packageRoot, "hooks", "pre-push");
const installedHook = join(hooksPath, "pre-push");
const [command, ...flags] = process.argv.slice(2);

const MODEL_ROLES = [
  ["shepherdModel", "Shepherd agents", "OpenCode active model", "model"],
  ["sheepdogModel", "Sheepdog agents", "litellm/glm-5.3-flash", "model"],
  ["sheepdogVariant", "Sheepdog reasoning effort", "model default", "variant"],
  ["grazerVariant", "Grazer reasoning effort", "model default", "variant"],
  ["workerModel", "Sheep worker agents", "litellm/glm-5.3-flash", "model"],
  ["workerVariant", "Sheep worker reasoning effort", "model default", "variant"],
  ["reviewerModel", "Shearer review agents", "litellm-responses/gpt-5.6-terra", "model"],
];

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", windowsHide: true, ...options }).trim();
}

function currentHooksPath() {
  try {
    return git(["config", "--global", "--get", "core.hooksPath"]);
  } catch {
    return "";
  }
}

function installHooks() {
  const existing = currentHooksPath();
  const force = flags.includes("--force");
  if (existing && existing !== hooksPath && !force) {
    throw new Error(`Global core.hooksPath is already ${existing}. Re-run with --force only after reviewing that hook setup.`);
  }
  mkdirSync(hooksPath, { recursive: true });
  copyFileSync(sourceHook, installedHook);
  try { chmodSync(installedHook, 0o755); } catch {}
  git(["config", "--global", "core.hooksPath", hooksPath]);
  process.stdout.write(`Installed pre-push hook and set global core.hooksPath=${hooksPath}\n`);
}

function uninstallHooks() {
  if (currentHooksPath() === hooksPath) {
    git(["config", "--global", "--unset", "core.hooksPath"]);
    rmSync(hooksPath, { recursive: true, force: true });
    process.stdout.write("Removed the orchestration global core.hooksPath setting and installed hook.\n");
  } else {
    process.stdout.write("Global core.hooksPath does not point at this package; nothing changed.\n");
  }
}

function currentOptions(configDir) {
  const file = findConfigFile(configDir);
  return existsSync(file) ? orchestrationOptions(readFileSync(file, "utf8")) : {};
}

async function promptForModels(configDir) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Agent model configuration requires an interactive terminal.");
  }
  const existing = currentOptions(configDir);
  const answers = {};
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write("Configure agent models. Press Enter to keep the shown value; enter - to restore the package default.\n");
  try {
    for (const [key, label, packageDefault, kind] of MODEL_ROLES) {
      const shown = existing[key] || packageDefault;
      const answer = (await prompt.question(`${label} [${shown}]: `)).trim();
      const value = answer === "-" ? "" : (answer || existing[key] || "");
      if (value && kind === "model" && !value.includes("/")) {
        throw new Error(`${label} model must include a provider prefix, for example provider/model.`);
      }
      answers[key] = value;
    }
  } finally {
    prompt.close();
  }
  return answers;
}

function reportReconciliation(reconciliation) {
  for (const relPath of reconciliation.deleted) {
    process.stdout.write(`Removed obsolete package-owned agent file: ${relPath}\n`);
  }
  for (const item of reconciliation.remediation) {
    process.stdout.write(`Action required (${item.reason}): ${item.remediation}\n`);
  }
}

async function installOrUpdate(useLatest) {
  const configDir = configDirectory();
  const models = command === "install" && process.stdin.isTTY && process.stdout.isTTY
    ? await promptForModels(configDir)
    : undefined;
  const version = useLatest ? latestVersion() : packageVersion(packageRoot);
  const packageBackups = installPackage(configDir, version);
  const result = writePluginConfig(configDir, false, models);
  try {
    validateOpenCode(configDir);
  } catch (error) {
    restoreBackup(result.file, result.backup, result.existed);
    throw new Error(`OpenCode validation failed; restored the previous config. ${error.message}`);
  }
  const reconciliation = reconcileAgentFiles(configDir, { remove: false });
  writeAgentFilesManifest(configDir, reconciliation.manifestEntries, version);
  if (flags.includes("--with-hooks")) installHooks();
  process.stdout.write(`Configured ${PACKAGE_NAME}@${version} in ${result.file}\n`);
  reportReconciliation(reconciliation);
  if (result.backup) process.stdout.write(`Backup: ${result.backup}\n`);
  for (const backup of packageBackups) process.stdout.write(`Backup: ${backup}\n`);
  process.stdout.write("Restart OpenCode intentionally to load the new configuration.\n");
}

async function configureAgents() {
  const configDir = configDirectory();
  if (!existsSync(join(configDir, "node_modules", PACKAGE_NAME, "package.json"))) {
    throw new Error(`${PACKAGE_NAME} is not installed. Run the install command first.`);
  }
  const models = await promptForModels(configDir);
  const result = writePluginConfig(configDir, false, models);
  try {
    validateOpenCode(configDir);
  } catch (error) {
    restoreBackup(result.file, result.backup, result.existed);
    throw new Error(`OpenCode validation failed; restored the previous config. ${error.message}`);
  }
  process.stdout.write(`Configured agent models in ${result.file}\n`);
  if (result.backup) process.stdout.write(`Backup: ${result.backup}\n`);
  process.stdout.write("Restart OpenCode intentionally to load the new configuration.\n");
}

function uninstallOrchestration() {
  const configDir = configDirectory();
  const result = writePluginConfig(configDir, true);
  const packageBackups = uninstallPackage(configDir);
  const reconciliation = reconcileAgentFiles(configDir, { remove: true });
  removeAgentFilesManifest(configDir);
  if (flags.includes("--with-hooks")) uninstallHooks();
  process.stdout.write(`Removed orchestration plugin configuration from ${result.file}\n`);
  for (const relPath of reconciliation.deleted) {
    process.stdout.write(`Removed package-owned agent file: ${relPath}\n`);
  }
  reportReconciliation(reconciliation);
  if (result.backup) process.stdout.write(`Backup: ${result.backup}\n`);
  for (const backup of packageBackups) process.stdout.write(`Backup: ${backup}\n`);
}

function fullStatus() {
  const result = { ...installationStatus(configDirectory(), packageRoot), hooks: JSON.parse(captureHookStatus()) };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function captureHookStatus() {
  return JSON.stringify({
    configuredHooksPath: currentHooksPath() || null,
    expectedHooksPath: hooksPath,
    hookInstalled: existsSync(installedHook),
    active: currentHooksPath() === hooksPath && existsSync(installedHook),
  });
}

try {
  if (command === "install") await installOrUpdate(false);
  else if (command === "update") await installOrUpdate(true);
  else if (command === "configure-agents") await configureAgents();
  else if (command === "uninstall") uninstallOrchestration();
  else if (command === "install-hooks") installHooks();
  else if (command === "uninstall-hooks") uninstallHooks();
  else if (command === "status") fullStatus();
  else {
    process.stderr.write("Usage: opencode-herdr-orchestration <install|update|configure-agents|status|uninstall|install-hooks|uninstall-hooks> [--with-hooks] [--force]\n");
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
