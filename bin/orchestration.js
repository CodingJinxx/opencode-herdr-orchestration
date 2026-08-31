#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  configDirectory,
  installPackage,
  latestVersion,
  PACKAGE_NAME,
  packageVersion,
  restoreBackup,
  status as installationStatus,
  uninstallPackage,
  validateOpenCode,
  writePluginConfig,
} from "../src/installer.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hooksPath = join(homedir(), ".config", "opencode-herdr-orchestration", "hooks");
const sourceHook = join(packageRoot, "hooks", "pre-push");
const installedHook = join(hooksPath, "pre-push");
const [command, ...flags] = process.argv.slice(2);

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

function installOrUpdate(useLatest) {
  const configDir = configDirectory();
  const version = useLatest ? latestVersion() : packageVersion(packageRoot);
  const packageBackups = installPackage(configDir, version);
  const result = writePluginConfig(configDir);
  try {
    validateOpenCode(configDir);
  } catch (error) {
    restoreBackup(result.file, result.backup, result.existed);
    throw new Error(`OpenCode validation failed; restored the previous config. ${error.message}`);
  }
  if (flags.includes("--with-hooks")) installHooks();
  process.stdout.write(`Configured ${PACKAGE_NAME}@${version} in ${result.file}\n`);
  if (result.backup) process.stdout.write(`Backup: ${result.backup}\n`);
  for (const backup of packageBackups) process.stdout.write(`Backup: ${backup}\n`);
  process.stdout.write("Restart OpenCode intentionally to load the new configuration.\n");
}

function uninstallOrchestration() {
  const configDir = configDirectory();
  const result = writePluginConfig(configDir, true);
  const packageBackups = uninstallPackage(configDir);
  if (flags.includes("--with-hooks")) uninstallHooks();
  process.stdout.write(`Removed orchestration plugin configuration from ${result.file}\n`);
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
  if (command === "install") installOrUpdate(false);
  else if (command === "update") installOrUpdate(true);
  else if (command === "uninstall") uninstallOrchestration();
  else if (command === "install-hooks") installHooks();
  else if (command === "uninstall-hooks") uninstallHooks();
  else if (command === "status") fullStatus();
  else {
    process.stderr.write("Usage: opencode-herdr-orchestration <install|update|status|uninstall|install-hooks|uninstall-hooks> [--with-hooks] [--force]\n");
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
