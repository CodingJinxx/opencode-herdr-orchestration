import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import spawn from "cross-spawn";
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";
import {
  STEER_COMMAND_AGENT as STEER_AGENT,
  STEER_COMMAND_DESCRIPTION as STEER_DESCRIPTION,
  STEER_COMMAND_NAME as STEER_NAME,
  STEER_COMMAND_TEMPLATE as STEER_TEMPLATE,
  steerCommandEntry as steerEntry,
} from "./steer.js";

export const PACKAGE_NAME = "@ia-forge/flocky";
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
  "developer",
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

// 15-M1 project config semantics (live-evidenced on opencode 1.18.29 via
// `opencode debug config` plus `opencode debug skill` in OS temp probes).
// Project filename: `opencode.json` in the project root per docs Per project
// ("Add `opencode.json` in your project root ... traverses up to the nearest
// Git directory"); live probes show both `opencode.json` and `opencode.jsonc`
// in cwd load as scope "local" (plugin_origins source project file, scope
// local) while empty cwd shows global-only (2 globals); when both exist both
// load as separate local layers, so helpers edit only the found file and
// preserve the other. Default for a new project file is `opencode.json` per
// docs; an existing `opencode.jsonc` is preferred when present for JSONC
// comment coherence with the global helper.
// Per-key merge: docs Locations ("merged together, not replaced ... later
// overrides earlier only for conflicting keys") plus Permissions Agents
// ("merged with the global config, and agent rules take precedence"); live
// per-key probe shows project `agent.shepherd.permission.bash` probe key
// merges with plugin keys (`herdr --help` preserved, `*` deny preserved) and
// a conflicting project `deny` overrides a plugin `allow`; a project custom
// agent preserves plugin agents (shepherd plus governor plus sheepdog plus
// grazer plus sheep plus shearers); top-level `permission` does not leak into
// agent blocks, so helpers target `["agent", name, "permission", ...]` only.
// Reload: config loads at startup; existing processes keep old config, so quit
// and restart intentionally, then verify the merged view with
// `opencode debug config` in the project; invalid project JSON fails that
// command with "not valid JSON(C)" and no automatic fallback, while
// `OPENCODE_DISABLE_PROJECT_CONFIG=1 opencode debug config` shows the
// global-only fallback (live-evidenced OK pluginLen 2 vs FAIL). Helpers below
// reuse parse plus modify plus applyEdits and backup discipline, stay fail
// closed inside the project root, and never touch global config.
// Skill decision: `opencode debug skill` shows 4 skills with 3 file-based
// globals (`graphify` in ~/.claude/skills plus `herdr` plus `find-skills` in
// ~/.agents/skills) and zero project `.opencode/skills` files, so M1 stays
// prompt-embedded with no native SKILL.md; see src/prompts.js plus README.
export const PROJECT_CONFIG_FILE = "opencode.json";
export const PROJECT_CONFIG_FILENAMES = Object.freeze(["opencode.jsonc", "opencode.json"]);

export function findProjectConfigFile(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new Error("Project root must be a non-empty path.");
  }
  const root = resolve(projectRoot);
  for (const name of PROJECT_CONFIG_FILENAMES) {
    const candidate = join(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return join(root, PROJECT_CONFIG_FILE);
}

function isInsideDir(parent, child) {
  const sep = join("a", "b").slice(1, -1) || (process.platform === "win32" ? "\\" : "/");
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  if (process.platform === "win32") {
    const lowerParent = resolvedParent.toLowerCase();
    const lowerChild = resolvedChild.toLowerCase();
    if (lowerChild === lowerParent) return true;
    return lowerChild.startsWith(lowerParent + sep.toLowerCase());
  }
  if (resolvedChild === resolvedParent) return true;
  return resolvedChild.startsWith(resolvedParent + sep);
}

function projectConfigConfinement(projectRoot, targetFile) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new Error("Project root must be a non-empty path.");
  }
  if (typeof targetFile !== "string" || targetFile.length === 0) {
    throw new Error("Project config file must be a non-empty path.");
  }
  const root = resolve(projectRoot);
  const target = resolve(targetFile);
  const globalDir = resolve(configDirectory());
  const globalFile = resolve(findConfigFile(globalDir));
  if (target === globalFile) {
    throw new Error(`Refusing global config file ${target}; project helpers never touch global config.`);
  }
  if (isInsideDir(globalDir, target)) {
    throw new Error(`Refusing path inside global config directory ${globalDir}; project helpers stay inside the project root.`);
  }
  if (root === globalDir || isInsideDir(globalDir, root)) {
    throw new Error(`Refusing global config directory as project root ${root}; use a project checkout.`);
  }
  if (target !== root && !isInsideDir(root, target)) {
    throw new Error(`Refusing outside path ${target}; project helpers stay inside ${root}.`);
  }
  const base = target.split(/[\\/]/).pop();
  if (!PROJECT_CONFIG_FILENAMES.includes(base)) {
    throw new Error(`Refusing non-project filename ${base}; project helpers edit only opencode.jsonc or opencode.json.`);
  }
  const directParent = resolve(join(target, ".."));
  if (directParent !== root) {
    throw new Error(`Refusing nested path ${target}; project helpers edit only the project root file.`);
  }
  return { root, target };
}

export function resolveProjectConfigFile(projectRoot, explicitFile) {
  if (explicitFile !== undefined) {
    const candidate = resolve(projectRoot, explicitFile);
    projectConfigConfinement(projectRoot, candidate);
    return candidate;
  }
  const found = findProjectConfigFile(projectRoot);
  projectConfigConfinement(projectRoot, found);
  return found;
}

const PROJECT_AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROJECT_PERMISSION_ACTIONS = new Set(["allow", "ask", "deny"]);

function assertProjectAgentName(agentName) {
  if (typeof agentName !== "string" || !PROJECT_AGENT_NAME_PATTERN.test(agentName)) {
    throw new Error(`Invalid agent name ${JSON.stringify(agentName)}; use 1-64 letters, digits, dot, underscore, or hyphen starting alphanumeric.`);
  }
}

function assertProjectPermissionUpdates(permissionUpdates) {
  if (!permissionUpdates || typeof permissionUpdates !== "object" || Array.isArray(permissionUpdates)) {
    throw new Error("Permission updates must be a non-array object mapping tool to action or pattern map.");
  }
  for (const [tool, value] of Object.entries(permissionUpdates)) {
    if (typeof tool !== "string" || tool.length === 0 || tool.includes("/") || tool.includes("\\")) {
      throw new Error(`Invalid permission tool ${JSON.stringify(tool)}.`);
    }
    if (value === undefined) continue;
    if (typeof value === "string") {
      if (!PROJECT_PERMISSION_ACTIONS.has(value)) {
        throw new Error(`Invalid action ${JSON.stringify(value)} for ${tool}; use allow, ask, deny, or undefined to delete.`);
      }
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invalid permission value for ${tool}; use allow, ask, deny, undefined, or a pattern map.`);
    }
    for (const [pattern, action] of Object.entries(value)) {
      if (typeof pattern !== "string" || pattern.length === 0) {
        throw new Error(`Invalid permission pattern ${JSON.stringify(pattern)} for ${tool}.`);
      }
      if (action !== undefined && !PROJECT_PERMISSION_ACTIONS.has(action)) {
        throw new Error(`Invalid action ${JSON.stringify(action)} for ${tool} pattern ${JSON.stringify(pattern)}.`);
      }
    }
  }
}

function parseProjectConfigText(text) {
  const errors = [];
  parse(text || "{}", errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    const first = errors[0];
    throw new Error(`Invalid OpenCode JSONC at offset ${first.offset}: ${printParseErrorCode(first.error)}.`);
  }
}

// Per-key merge for one agent permission block. String values set the tool
// shorthand; undefined deletes the tool; object values set per-pattern rules
// with undefined deleting that pattern. Unrelated keys, plugins, tuples, and
// sibling agents are preserved via modify plus applyEdits. Reapplying the
// same updates is idempotent (no edits when values already match).
export function updateProjectAgentPermissions(text, agentName, permissionUpdates) {
  assertProjectAgentName(agentName);
  assertProjectPermissionUpdates(permissionUpdates);
  parseProjectConfigText(text);
  const source = text || "{}";
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: source.includes("\r\n") ? "\r\n" : "\n" };
  let updated = source;
  for (const [tool, value] of Object.entries(permissionUpdates)) {
    if (value === undefined) {
      updated = applyEdits(updated, modify(updated, ["agent", agentName, "permission", tool], undefined, { formattingOptions }));
    } else if (typeof value === "string") {
      updated = applyEdits(updated, modify(updated, ["agent", agentName, "permission", tool], value, { formattingOptions }));
    } else {
      for (const [pattern, action] of Object.entries(value)) {
        updated = applyEdits(updated, modify(updated, ["agent", agentName, "permission", tool, pattern], action, { formattingOptions }));
      }
    }
  }
  return updated;
}

export function writeProjectAgentPermissions(projectRoot, agentName, permissionUpdates, explicitFile) {
  assertProjectAgentName(agentName);
  assertProjectPermissionUpdates(permissionUpdates);
  const file = resolveProjectConfigFile(projectRoot, explicitFile);
  mkdirSync(resolve(projectRoot), { recursive: true });
  const existed = existsSync(file);
  const previous = existed ? readFileSync(file, "utf8") : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  const next = updateProjectAgentPermissions(previous, agentName, permissionUpdates);
  if (next === previous) return { file, backup: null, changed: false, existed };
  const backup = backupFile(file);
  writeFileSync(file, next, "utf8");
  return { file, backup, changed: true, existed };
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

// Native /steer command owned by the installer. Single source for the shape
// lives in src/steer.js; these helpers persist it with the same JSONC
// preserve-comments plus backup discipline as the plugin config. The entry
// pins agent developer, carries an $ARGUMENTS template, and describes the
// Developer-only direct-write hook.
export {
  STEER_COMMAND_AGENT,
  STEER_COMMAND_DESCRIPTION,
  STEER_COMMAND_NAME,
  STEER_COMMAND_TEMPLATE,
  steerCommandEntry,
} from "./steer.js";

export function updateCommandConfig(text, commandName, entry, remove = false) {
  const errors = [];
  const parsed = parse(text || "{}", errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    const first = errors[0];
    throw new Error(`Invalid OpenCode JSONC at offset ${first.offset}: ${printParseErrorCode(first.error)}.`);
  }
  if (typeof commandName !== "string" || commandName.length === 0) {
    throw new Error("Command name must be a non-empty string.");
  }
  const source = text || "{}";
  if (remove && parsed?.command?.[commandName] === undefined) return source;
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: source.includes("\r\n") ? "\r\n" : "\n" };
  const value = remove ? undefined : entry;
  return applyEdits(source, modify(source, ["command", commandName], value, { formattingOptions }));
}

export function updateSteerCommand(text, entry = steerEntry(), remove = false) {
  return updateCommandConfig(text, STEER_NAME, entry, remove);
}

export function isSteerCommandConfigured(text) {
  const config = parse(text || "{}", [], { allowTrailingComma: true, disallowComments: false });
  const entry = config?.command?.[STEER_NAME];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  return (
    entry.agent === STEER_AGENT &&
    typeof entry.template === "string" &&
    entry.template.includes("$ARGUMENTS") &&
    entry.description === STEER_DESCRIPTION
  );
}

export function writeSteerCommand(configDir, remove = false) {
  mkdirSync(configDir, { recursive: true });
  const file = findConfigFile(configDir);
  const existed = existsSync(file);
  const previous = existed ? readFileSync(file, "utf8") : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  const next = updateSteerCommand(previous, steerEntry(), remove);
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
  let steerCommandConfigured = false;
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    const config = parse(text, [], { allowTrailingComma: true, disallowComments: false });
    configured = Array.isArray(config?.plugin) && config.plugin.some(isOrchestrationPlugin);
    try {
      steerCommandConfigured = isSteerCommandConfigured(text);
    } catch {
      steerCommandConfigured = false;
    }
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
    steerCommandConfigured,
    detectedAgents,
    agentsReady: detectedAgents.length === AGENT_NAMES.length,
    obsoleteAgentFiles,
  };
}
