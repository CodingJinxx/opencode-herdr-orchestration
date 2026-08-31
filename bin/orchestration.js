#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

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

function install() {
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

function uninstall() {
  if (currentHooksPath() === hooksPath) {
    git(["config", "--global", "--unset", "core.hooksPath"]);
    rmSync(hooksPath, { recursive: true, force: true });
    process.stdout.write("Removed the orchestration global core.hooksPath setting and installed hook.\n");
  } else {
    process.stdout.write("Global core.hooksPath does not point at this package; nothing changed.\n");
  }
}

function status() {
  process.stdout.write(`${JSON.stringify({
    configuredHooksPath: currentHooksPath() || null,
    expectedHooksPath: hooksPath,
    hookInstalled: existsSync(installedHook),
    active: currentHooksPath() === hooksPath && existsSync(installedHook),
  }, null, 2)}\n`);
}

try {
  if (command === "install-hooks") install();
  else if (command === "uninstall-hooks") uninstall();
  else if (command === "status") status();
  else {
    process.stderr.write("Usage: opencode-herdr-orchestration <install-hooks [--force]|uninstall-hooks|status>\n");
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
