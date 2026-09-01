import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import spawn from "cross-spawn";
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";

export const PACKAGE_NAME = "opencode-herdr-orchestration";
const NPM_COMMAND = "npm";
const OPENCODE_COMMAND = "opencode";
export const AGENT_NAMES = [
  "shepherd",
  "shepherd-governor",
  "sheepdog",
  "grazer",
  "sheep",
  "shearer-low",
  "shearer-medium",
];

// Agents register dynamically through the plugin, so the package owns no agent
// definition files today. Earlier package versions may have written some; those
// are cleaned up strictly through the manifest below.
export const OWNED_AGENT_FILES = [];
export const AGENT_MANIFEST_SCHEMA = 1;
export const AGENT_MANIFEST_FILE = "opencode-herdr-orchestration-manifest.json";
export const MANAGED_AGENT_DIR = "agent";
export const KNOWN_OBSOLETE_AGENTS = [
  "shepherd-plan",
  "shepherd-build",
  "sheep-plan",
  "sheep-build",
  "shearer-review-low",
  "shearer-review-medium",
  "sheperd-plan",
  "sheperd-build",
];

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

export function orchestrationOptions(text) {
  const config = parse(text || "{}", [], { allowTrailingComma: true, disallowComments: false });
  const entry = Array.isArray(config?.plugin)
    ? config.plugin.find((candidate) => isOrchestrationPlugin(candidate))
    : undefined;
  return Array.isArray(entry) && entry[1] && typeof entry[1] === "object" ? entry[1] : {};
}

export function updateAgentModels(text, entry, models) {
  const original = parse(text || "{}", [], { allowTrailingComma: true, disallowComments: false });
  const matches = Array.isArray(original?.plugin)
    ? original.plugin.map((candidate, index) => isOrchestrationPlugin(candidate) ? index : -1).filter((index) => index >= 0)
    : [];
  let updated = text || "{}";
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: updated.includes("\r\n") ? "\r\n" : "\n" };
  if (matches.length === 1 && Array.isArray(original.plugin[matches[0]])) {
    updated = applyEdits(updated, modify(updated, ["plugin", matches[0], 0], entry, { formattingOptions }));
  } else {
    updated = updatePluginConfig(updated, entry);
  }
  const config = parse(updated, [], { allowTrailingComma: true, disallowComments: false });
  const index = config.plugin.findIndex((candidate) => isOrchestrationPlugin(candidate));
  if (!Array.isArray(config.plugin[index])) {
    const options = Object.fromEntries(Object.entries(models).filter(([, value]) => value));
    return applyEdits(updated, modify(updated, ["plugin", index], [entry, options], { formattingOptions }));
  }
  for (const [key, value] of Object.entries(models)) {
    updated = applyEdits(updated, modify(updated, ["plugin", index, 1, key], value || undefined, { formattingOptions }));
  }
  return updated;
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
  const result = spawn.sync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`${command} exited with status ${result.status}.`);
    error.status = result.status;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result.stdout.trim();
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
  return JSON.parse(run(NPM_COMMAND, ["view", PACKAGE_NAME, "version", "--json", "--prefer-online"]));
}

export function installPackage(configDir, version) {
  mkdirSync(configDir, { recursive: true });
  const backups = ["package.json", "package-lock.json"]
    .map((name) => backupFile(join(configDir, name)))
    .filter(Boolean);
  run(NPM_COMMAND, ["install", "--save-exact", `${PACKAGE_NAME}@${version}`], { cwd: configDir });
  return backups;
}

export function uninstallPackage(configDir) {
  const backups = ["package.json", "package-lock.json"]
    .map((name) => backupFile(join(configDir, name)))
    .filter(Boolean);
  try {
    run(NPM_COMMAND, ["uninstall", PACKAGE_NAME], { cwd: configDir });
  } catch {}
  return backups;
}

export function writePluginConfig(configDir, remove = false, models) {
  mkdirSync(configDir, { recursive: true });
  const file = findConfigFile(configDir);
  const existed = existsSync(file);
  const previous = existed ? readFileSync(file, "utf8") : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  const next = models && !remove
    ? updateAgentModels(previous, packageEntry(configDir), models)
    : updatePluginConfig(previous, packageEntry(configDir), remove);
  if (next === previous) return { file, backup: null, changed: false, existed };
  const backup = backupFile(file);
  writeFileSync(file, next, "utf8");
  return { file, backup, changed: true, existed };
}

export function restoreBackup(file, backup, existed = true) {
  if (backup && existsSync(backup)) copyFileSync(backup, file);
  else if (!existed) rmSync(file, { force: true });
}

export function agentFilesManifestPath(configDir) {
  return join(configDir, AGENT_MANIFEST_FILE);
}

export function managedAgentRoot(configDir) {
  return join(configDir, MANAGED_AGENT_DIR);
}

function fileDigest(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// Manifest paths are relative to the config root, use POSIX separators, and
// must stay strictly inside the managed agent directory. Anything else is
// unsafe and is never deleted.
function safeManagedPath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) return null;
  if (relPath.includes("\\") || relPath.startsWith("/") || /^[A-Za-z]:/.test(relPath)) return null;
  const segments = relPath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
  if (segments[0] !== MANAGED_AGENT_DIR || segments.length < 2) return null;
  return segments.join("/");
}

export function readAgentFilesManifest(configDir) {
  const file = agentFilesManifestPath(configDir);
  if (!existsSync(file)) return { manifest: null, error: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { manifest: null, error: String(error?.message ?? error) };
  }
  if (parsed?.schema !== AGENT_MANIFEST_SCHEMA || parsed?.package !== PACKAGE_NAME || !Array.isArray(parsed.files)) {
    return { manifest: null, error: `unsupported manifest at ${file}` };
  }
  return { manifest: parsed, error: null };
}

export function writeAgentFilesManifest(configDir, entries, version) {
  const file = agentFilesManifestPath(configDir);
  const contents = `${JSON.stringify(
    { schema: AGENT_MANIFEST_SCHEMA, package: PACKAGE_NAME, version, digestAlgorithm: "sha256", files: entries ?? [] },
    null,
    2,
  )}\n`;
  if (existsSync(file) && readFileSync(file, "utf8") === contents) return { file, changed: false };
  writeFileSync(file, contents, "utf8");
  return { file, changed: true };
}

export function removeAgentFilesManifest(configDir) {
  rmSync(agentFilesManifestPath(configDir), { force: true });
}

export function unownedObsoleteAgentFiles(configDir) {
  const managedRoot = managedAgentRoot(configDir);
  if (!existsSync(managedRoot)) return [];
  return readdirSync(managedRoot)
    .filter((name) => name.endsWith(".md") && KNOWN_OBSOLETE_AGENTS.includes(name.slice(0, -".md".length)))
    .map((name) => `${MANAGED_AGENT_DIR}/${name}`);
}

// Deletes only files proven package-owned by the manifest (path inside the
// managed root and digest still matching the recorded one). Modified, unowned,
// and unsafe files are never deleted; exact remediation is reported instead.
export function reconcileAgentFiles(configDir, { remove = false } = {}) {
  const managedRoot = managedAgentRoot(configDir);
  const report = { deleted: [], missing: [], remediation: [], manifestEntries: [] };
  const { manifest, error } = readAgentFilesManifest(configDir);
  if (error) {
    report.remediation.push({
      path: agentFilesManifestPath(configDir),
      reason: "unreadable",
      remediation: `Review and fix or remove ${agentFilesManifestPath(configDir)} manually; no package-owned files were touched.`,
    });
  } else {
    const owned = new Set();
    for (const entry of Array.isArray(manifest?.files) ? manifest.files : []) {
      const relPath = safeManagedPath(entry?.path);
      if (!relPath) {
        const shown = JSON.stringify(entry?.path ?? null);
        report.remediation.push({
          path: shown,
          reason: "unsafe",
          remediation: `Manifest entry ${shown} does not stay inside ${MANAGED_AGENT_DIR}/; delete that file manually after review. Nothing was deleted.`,
        });
        report.manifestEntries.push(entry);
        continue;
      }
      owned.add(relPath);
      const file = join(configDir, ...relPath.split("/"));
      if (!existsSync(file)) {
        report.missing.push(relPath);
        continue;
      }
      const obsolete = remove || !OWNED_AGENT_FILES.includes(relPath);
      if (!obsolete) {
        report.manifestEntries.push(entry);
        continue;
      }
      if (entry.digest === fileDigest(file)) {
        rmSync(file, { force: true });
        report.deleted.push(relPath);
        owned.delete(relPath);
      } else {
        report.manifestEntries.push(entry);
        report.remediation.push({
          path: relPath,
          reason: "modified",
          remediation: `${file} was modified after ${entry.version ?? "an earlier version"} installed it; review and delete it manually.`,
        });
      }
    }
    for (const relPath of unownedObsoleteAgentFiles(configDir)) {
      if (owned.has(relPath)) continue;
      report.remediation.push({
        path: relPath,
        reason: "unowned",
        remediation: `${join(configDir, ...relPath.split("/"))} defines the retired agent ${relPath.split("/").pop().slice(0, -".md".length)} but is not package-owned; archive or delete it manually.`,
      });
    }
  }
  if (report.deleted.length && existsSync(managedRoot) && readdirSync(managedRoot).length === 0) {
    rmSync(managedRoot, { recursive: true, force: true });
  }
  return report;
}

export function validateOpenCode(configDir) {
  const env = { ...process.env, OPENCODE_DISABLE_PROJECT_CONFIG: "1" };
  for (const name of AGENT_NAMES) {
    const output = run(OPENCODE_COMMAND, ["debug", "agent", name], {
      cwd: configDir,
      env,
      maxBuffer: 32 * 1024 * 1024,
    });
    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch {}
    if (parsed?.name !== name) throw new Error(`OpenCode did not resolve ${name} during validation.`);
  }
  const list = run(OPENCODE_COMMAND, ["agent", "list"], {
    cwd: configDir,
    env,
    maxBuffer: 32 * 1024 * 1024,
  });
  const missing = AGENT_NAMES.filter((name) => !list.includes(`${name} (primary)`));
  if (missing.length) throw new Error(`OpenCode agent list did not report: ${missing.join(", ")}.`);
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
  let obsoleteAgentFiles = [];
  try {
    obsoleteAgentFiles = unownedObsoleteAgentFiles(configDir);
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
    obsoleteAgentFiles,
  };
}
