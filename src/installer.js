import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";

export const PACKAGE_NAME = "opencode-herdr-orchestration";
const NPM_COMMAND = process.platform === "win32" ? process.execPath : "npm";
const NPM_PREFIX = process.platform === "win32" ? [resolveNpmCli()] : [];
const OPENCODE_COMMAND = process.platform === "win32" ? "opencode.exe" : "opencode";
export const AGENT_NAMES = [
  "shepherd-plan",
  "shepherd-build",
  "sheep-plan",
  "sheep-build",
  "shearer-review-low",
  "shearer-review-medium",
];

function resolveWindowsCommand(name) {
  try {
    return execFileSync("where.exe", [name], { encoding: "utf8", windowsHide: true })
      .split(/\r?\n/)
      .find(Boolean)
      .trim();
  } catch {
    return name;
  }
}

function resolveNpmCli() {
  const npmShim = resolveWindowsCommand("npm.cmd");
  return join(dirname(npmShim), "node_modules", "npm", "bin", "npm-cli.js");
}

export function configDirectory(env = process.env) {
  if (env.OPENCODE_CONFIG_DIR) return resolve(env.OPENCODE_CONFIG_DIR);
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(home, ".config", "opencode");
}

export function packageEntry(configDir) {
  return pathToFileURL(join(configDir, "node_modules", PACKAGE_NAME, "src", "plugin.js")).href;
}

export function isOrchestrationPlugin(entry) {
  const spec = Array.isArray(entry) ? entry[0] : entry;
  return (
    typeof spec === "string" &&
    (spec === PACKAGE_NAME || spec.startsWith(`${PACKAGE_NAME}@`) || spec.includes(`/node_modules/${PACKAGE_NAME}/`))
  );
}

export function updatePluginConfig(text, entry, remove = false) {
  const errors = [];
  const config = parse(text || "{}", errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    const first = errors[0];
    throw new Error(`Invalid OpenCode JSONC at offset ${first.offset}: ${printParseErrorCode(first.error)}.`);
  }
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" };
  const plugins = Array.isArray(config?.plugin) ? config.plugin : [];
  const matches = plugins.map((candidate, index) => isOrchestrationPlugin(candidate) ? index : -1).filter((index) => index >= 0);
  const existing = matches.length ? plugins[matches[0]] : undefined;
  const source = text || "{}";

  if (matches.length === 1 && !remove) {
    const replacement = Array.isArray(existing) ? [entry, existing[1] ?? {}] : entry;
    return applyEdits(source, modify(source, ["plugin", matches[0]], replacement, { formattingOptions }));
  }
  if (matches.length && (remove || matches.length > 1)) {
    const remaining = plugins.filter((candidate) => !isOrchestrationPlugin(candidate));
    if (!remove) remaining.push(Array.isArray(existing) ? [entry, existing[1] ?? {}] : entry);
    return applyEdits(source, modify(source, ["plugin"], remaining, { formattingOptions }));
  }
  if (!remove) {
    const path = Array.isArray(config?.plugin) ? ["plugin", -1] : ["plugin"];
    const value = Array.isArray(config?.plugin) ? entry : [entry];
    return applyEdits(source, modify(source, path, value, { formattingOptions }));
  }
  return source;
}

export function findConfigFile(configDir) {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const candidate = join(configDir, name);
    if (existsSync(candidate)) return candidate;
  }
  return join(configDir, "opencode.jsonc");
}

export function backupFile(file, now = new Date()) {
  if (!existsSync(file)) return null;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backup = `${file}.backup-${stamp}`;
  copyFileSync(file, backup);
  return backup;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

export function installedVersion(configDir) {
  const manifest = join(configDir, "node_modules", PACKAGE_NAME, "package.json");
  if (!existsSync(manifest)) return null;
  return JSON.parse(readFileSync(manifest, "utf8")).version;
}

export function packageVersion(packageRoot) {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
}

export function latestVersion() {
  return JSON.parse(run(NPM_COMMAND, [...NPM_PREFIX, "view", PACKAGE_NAME, "version", "--json", "--prefer-online"]));
}

export function installPackage(configDir, version) {
  mkdirSync(configDir, { recursive: true });
  const backups = ["package.json", "package-lock.json"]
    .map((name) => backupFile(join(configDir, name)))
    .filter(Boolean);
  run(NPM_COMMAND, [...NPM_PREFIX, "install", "--save-exact", `${PACKAGE_NAME}@${version}`], { cwd: configDir });
  return backups;
}

export function uninstallPackage(configDir) {
  const backups = ["package.json", "package-lock.json"]
    .map((name) => backupFile(join(configDir, name)))
    .filter(Boolean);
  try {
    run(NPM_COMMAND, [...NPM_PREFIX, "uninstall", PACKAGE_NAME], { cwd: configDir });
  } catch {}
  return backups;
}

export function writePluginConfig(configDir, remove = false) {
  mkdirSync(configDir, { recursive: true });
  const file = findConfigFile(configDir);
  const existed = existsSync(file);
  const previous = existed ? readFileSync(file, "utf8") : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  const next = updatePluginConfig(previous, packageEntry(configDir), remove);
  if (next === previous) return { file, backup: null, changed: false, existed };
  const backup = backupFile(file);
  writeFileSync(file, next, "utf8");
  return { file, backup, changed: true, existed };
}

export function restoreBackup(file, backup, existed = true) {
  if (backup && existsSync(backup)) copyFileSync(backup, file);
  else if (!existed) rmSync(file, { force: true });
}

export function validateOpenCode(configDir) {
  const output = run(OPENCODE_COMMAND, ["debug", "agent", "shepherd-build"], {
    cwd: configDir,
    env: { ...process.env, OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = JSON.parse(output);
  if (parsed.name !== "shepherd-build") throw new Error("OpenCode did not resolve shepherd-build after installation.");
  return true;
}

export function status(configDir, packageRoot) {
  const file = findConfigFile(configDir);
  let configured = false;
  if (existsSync(file)) {
    const config = parse(readFileSync(file, "utf8"), [], { allowTrailingComma: true, disallowComments: false });
    configured = Array.isArray(config?.plugin) && config.plugin.some(isOrchestrationPlugin);
  }
  const installed = installedVersion(configDir);
  let detectedAgents = [];
  try {
    const output = run(OPENCODE_COMMAND, ["agent", "list"], {
      cwd: configDir,
      env: { ...process.env, OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
      maxBuffer: 32 * 1024 * 1024,
    });
    detectedAgents = AGENT_NAMES.filter((name) => output.includes(`${name} (primary)`));
  } catch {}
  let latest = null;
  let latestVersionError = null;
  try {
    latest = latestVersion();
  } catch (error) {
    latestVersionError = String(error?.stderr ?? error?.message ?? error).replace(/\s+/g, " ").trim().slice(0, 500);
  }
  return {
    package: PACKAGE_NAME,
    cliVersion: packageVersion(packageRoot),
    installedVersion: installed,
    latestVersion: latest,
    latestVersionError,
    updateAvailable: Boolean(installed && latest && installed !== latest),
    configFile: file,
    pluginConfigured: configured,
    detectedAgents,
    agentsReady: detectedAgents.length === AGENT_NAMES.length,
  };
}
