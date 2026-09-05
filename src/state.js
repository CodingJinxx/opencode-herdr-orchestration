import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fsDefault from "node:fs";
import pathDefault from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ARTIFACT_TYPES = Object.freeze({
  PLAN: "plan",
  EXECUTION: "execution",
});

const ARTIFACT_TYPE_VALUES = new Set(Object.values(ARTIFACT_TYPES));

const STATE_DIR = "flocky";
// The legacy "herdr" root is a compatibility source only: it is reconciled
// into the canonical Flocky root before every plan/execution operation, but
// it is never auto-deleted and never treated as a second canonical authority.
const LEGACY_STATE_DIR = "herdr";
const ARTIFACT_DIRECTORIES = Object.freeze({
  [ARTIFACT_TYPES.PLAN]: "plans",
  [ARTIFACT_TYPES.EXECUTION]: "executions",
});

const MIGRATION_TEMP_SUFFIX = ".migrating";
const MARKDOWN_SUFFIX = ".md";

// Retired M1 coordination files. Earlier revisions created a shared migration
// lock and a shared write-ahead journal under the canonical root; the
// lock-free protocol below never creates them, and reconciliation removes
// leftovers best-effort. They are service-owned coordination state, never
// user artifacts, so removing them never touches legacy or canonical data.
const RETIRED_MIGRATION_FILES = Object.freeze([".migration-lock", ".migration-journal"]);

// Staging temps left behind by a crashed promotion are inert: promotion only
// ever happens from freshly validated legacy bytes through an exclusive
// create, so a later call safely sweeps another call's stale temp while never
// touching a live contender's fresh temp.
const ORPHAN_TEMP_STALE_MS = 30_000;

const SCHEMA_VERSION = 1;
const FRONTMATTER_DELIMITER = "---";

// Plan IDs become single path segments below the state root. They must never
// contain separators, traversal sequences, or hidden/relative prefixes.
const PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const METADATA_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const MAX_MARKDOWN_BYTES = 1024 * 1024;
const MAX_METADATA_VALUE_CHARS = 512;

const RESERVED_METADATA_KEYS = Object.freeze([
  "schema",
  "artifactType",
  "planId",
  "identity",
  "toplevel",
  "createdAt",
  "updatedAt",
]);

function error(code, message, retryable = false, details) {
  return { ok: false, error: { code, message, retryable, ...(details ?? {}) } };
}

function processErrorDetail(cause) {
  const value = String(cause?.stderr ?? cause?.message ?? cause).replace(/\s+/g, " ").trim();
  return value.length > 1000 ? `${value.slice(0, 1000)}...` : value;
}

async function defaultRunGit(gitBinary, cwd, args) {
  const { stdout } = await execFileAsync(gitBinary, args, { cwd, encoding: "utf8", windowsHide: true });
  return stdout;
}

function resolveNow(now) {
  if (typeof now === "function") return now();
  if (now instanceof Date) return now;
  if (typeof now === "string" || typeof now === "number") return new Date(now);
  return new Date();
}

function validateArtifactType(type) {
  if (typeof type !== "string" || !ARTIFACT_TYPE_VALUES.has(type)) {
    return error(
      "INVALID_ARTIFACT_TYPE",
      `Artifact type must be one of: ${[...ARTIFACT_TYPE_VALUES].join(", ")}.`,
    );
  }
  return null;
}

function validatePlanId(planId) {
  if (typeof planId !== "string" || !PLAN_ID_PATTERN.test(planId)) {
    return error(
      "INVALID_PLAN_ID",
      "Plan ID must be 1-64 characters of letters, digits, dot, underscore, or hyphen, and must not start with a dot.",
    );
  }
  return null;
}

function validateMarkdown(markdown) {
  if (typeof markdown !== "string" || markdown.length === 0) {
    return error("INVALID_MARKDOWN", "Markdown body must be a non-empty string.");
  }
  if (Buffer.byteLength(markdown, "utf8") > MAX_MARKDOWN_BYTES) {
    return error("INVALID_MARKDOWN", `Markdown body must not exceed ${MAX_MARKDOWN_BYTES} UTF-8 bytes.`);
  }
  return null;
}

function validateMetadata(metadata) {
  if (metadata === undefined) return null;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return error("INVALID_METADATA", "Metadata must be an object with string values.");
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (!METADATA_KEY_PATTERN.test(key)) {
      return error("INVALID_METADATA", `Metadata key ${JSON.stringify(key)} is not a valid key.`);
    }
    if (RESERVED_METADATA_KEYS.includes(key)) {
      return error("INVALID_METADATA", `Metadata key ${JSON.stringify(key)} is reserved.`);
    }
    if (typeof value !== "string" || value.length > MAX_METADATA_VALUE_CHARS) {
      return error(
        "INVALID_METADATA",
        `Metadata value for ${JSON.stringify(key)} must be a string of at most ${MAX_METADATA_VALUE_CHARS} characters.`,
      );
    }
  }
  return null;
}

function serializeArtifact(metadata, markdown) {
  const body = markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  return `${FRONTMATTER_DELIMITER}\n${JSON.stringify(metadata, null, 2)}\n${FRONTMATTER_DELIMITER}\n${body}`;
}

function parseArtifact(text) {
  const open = `${FRONTMATTER_DELIMITER}\n`;
  const close = `\n${FRONTMATTER_DELIMITER}\n`;
  if (typeof text !== "string" || !text.startsWith(open)) {
    return error("CORRUPT_ARTIFACT", "Artifact does not start with a frontmatter block.");
  }
  const end = text.indexOf(close, open.length);
  if (end === -1) {
    return error("CORRUPT_ARTIFACT", "Artifact frontmatter block is not terminated.");
  }
  let metadata;
  try {
    metadata = JSON.parse(text.slice(open.length, end));
  } catch (cause) {
    return error("CORRUPT_ARTIFACT", `Artifact frontmatter is not valid JSON: ${processErrorDetail(cause)}`);
  }
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return error("CORRUPT_ARTIFACT", "Artifact frontmatter must be a JSON object.");
  }
  return { metadata, markdown: text.slice(end + close.length) };
}

export function createStateService(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const gitBinary = options.gitBinary ?? "git";
  const runGit = options.runGit ?? ((cwd_, args) => defaultRunGit(gitBinary, cwd_, args));
  const now = options.now ?? (() => new Date());
  const fs = options.fs ?? fsDefault;
  const path = options.path ?? pathDefault;

  let identityCache;
  let toplevelCache;

  async function resolveRepositoryLayout() {
    if (identityCache && toplevelCache) {
      return { identity: identityCache, toplevel: toplevelCache };
    }
    let commonDir;
    try {
      commonDir = (await runGit(cwd, ["rev-parse", "--git-common-dir"])).trim();
    } catch (cause) {
      return error("GIT_UNAVAILABLE", `Unable to resolve the Git common directory: ${processErrorDetail(cause)}`, true);
    }
    if (typeof commonDir !== "string" || commonDir.length === 0) {
      return error("GIT_UNAVAILABLE", "Git returned an empty common directory.", true);
    }
    let toplevel;
    try {
      toplevel = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
    } catch (cause) {
      return error("GIT_UNAVAILABLE", `Unable to resolve the worktree top level: ${processErrorDetail(cause)}`, true);
    }
    identityCache = canonicalizePath(commonDir);
    toplevelCache = canonicalizePath(toplevel);
    return { identity: identityCache, toplevel: toplevelCache };
  }

  function canonicalizePath(value) {
    const absolute = path.isAbsolute(value) ? value : path.resolve(cwd, value);
    try {
      // On Windows, the regular realpath binding can preserve an 8.3 alias
      // while the same directory is reached through its long name elsewhere.
      // The native binding gives one identity across linked worktrees.
      const realpath = fs.realpathSync.native ?? fs.realpathSync;
      return realpath(absolute);
    } catch {
      return path.resolve(absolute);
    }
  }

  function artifactPath(layout, type, planId) {
    const root = path.join(layout.identity, STATE_DIR, ARTIFACT_DIRECTORIES[type]);
    const target = path.join(root, `${planId}.md`);
    const resolvedRoot = path.resolve(root);
    const resolvedTarget = path.resolve(target);
    const relative = path.relative(resolvedRoot, resolvedTarget);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return error("PATH_UNSAFE", `Resolved artifact path escapes the ${type} state directory.`);
    }
    return { root: resolvedRoot, target: resolvedTarget };
  }

  async function writeArtifact(type, { planId, markdown, metadata: extraMetadata }) {
    const typeFailure = validateArtifactType(type);
    if (typeFailure) return typeFailure;
    const planIdFailure = validatePlanId(planId);
    if (planIdFailure) return planIdFailure;
    const markdownFailure = validateMarkdown(markdown);
    if (markdownFailure) return markdownFailure;
    const metadataFailure = validateMetadata(extraMetadata);
    if (metadataFailure) return metadataFailure;

    const layout = await resolveRepositoryLayout();
    if (layout.error) return layout;
    const location = artifactPath(layout, type, planId);
    if (location.error) return location;

    const reconciled = await reconcileLegacyState(layout);
    if (reconciled.error) return reconciled;

    const timestamp = resolveNow(now).toISOString();
    let existingMetadata;
    const existing = readStoredArtifact(location.target);
    if (existing.ok) {
      if (existing.artifact.metadata.identity !== layout.identity) {
        return error(
          "IDENTITY_MISMATCH",
          `Existing artifact belongs to repository ${existing.artifact.metadata.identity}, not ${layout.identity}.`,
        );
      }
      existingMetadata = existing.artifact.metadata;
    } else if (existing.error.code !== "NOT_FOUND" && existing.error.code !== "CORRUPT_ARTIFACT") {
      return existing;
    }

    const metadata = {
      schema: SCHEMA_VERSION,
      artifactType: type,
      planId,
      identity: layout.identity,
      toplevel: layout.toplevel,
      createdAt: existingMetadata?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(extraMetadata ?? {}),
    };

    const tempTarget = `${location.target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.mkdirSync(location.root, { recursive: true });
      fs.writeFileSync(tempTarget, serializeArtifact(metadata, markdown), "utf8");
      fs.renameSync(tempTarget, location.target);
    } catch (cause) {
      try {
        fs.unlinkSync(tempTarget);
      } catch {
        // The temp file may not exist when the write itself failed; the
        // rename target is untouched either way.
      }
      return error("WRITE_FAILED", `Unable to atomically write ${type} artifact: ${processErrorDetail(cause)}`, true);
    }

    return {
      ok: true,
      artifact: { type, planId, path: location.target, metadata },
    };
  }

  async function readArtifact(type, planId) {
    const typeFailure = validateArtifactType(type);
    if (typeFailure) return typeFailure;
    const planIdFailure = validatePlanId(planId);
    if (planIdFailure) return planIdFailure;

    const layout = await resolveRepositoryLayout();
    if (layout.error) return layout;
    const location = artifactPath(layout, type, planId);
    if (location.error) return location;

    const reconciled = await reconcileLegacyState(layout);
    if (reconciled.error) return reconciled;

    const stored = readStoredArtifact(location.target);
    if (stored.error) return stored;
    const { metadata } = stored.artifact;

    if (metadata.schema !== SCHEMA_VERSION) {
      return error("SCHEMA_MISMATCH", `Artifact schema ${JSON.stringify(metadata.schema)} is not ${SCHEMA_VERSION}.`);
    }
    if (metadata.artifactType !== type) {
      return error("ARTIFACT_TYPE_MISMATCH", `Artifact records type ${JSON.stringify(metadata.artifactType)}, expected ${JSON.stringify(type)}.`);
    }
    if (metadata.planId !== planId) {
      return error("PLAN_ID_MISMATCH", `Artifact records plan ID ${JSON.stringify(metadata.planId)}, expected ${JSON.stringify(planId)}.`);
    }
    if (metadata.identity !== layout.identity) {
      return error(
        "IDENTITY_MISMATCH",
        `Artifact belongs to repository ${metadata.identity}, current repository identity is ${layout.identity}.`,
      );
    }

    // The worktree top level is provenance only. Linked worktrees sharing a
    // common directory read the same artifacts with different top levels.
    return {
      ok: true,
      artifact: stored.artifact,
      provenance: {
        recordedToplevel: metadata.toplevel,
        currentToplevel: layout.toplevel,
        toplevelMatches: metadata.toplevel === layout.toplevel,
      },
    };
  }

  function readStoredArtifact(target) {
    let text;
    try {
      text = fs.readFileSync(target, "utf8");
    } catch (cause) {
      if (cause?.code === "ENOENT") {
        return error("NOT_FOUND", `No ${JSON.stringify(target)} artifact exists yet.`, true);
      }
      return error("READ_FAILED", `Unable to read artifact: ${processErrorDetail(cause)}`, true);
    }
    const parsed = parseArtifact(text);
    if (parsed.error) return parsed;
    return {
      ok: true,
      artifact: { metadata: parsed.metadata, markdown: parsed.markdown, path: target },
    };
  }

  // --- Legacy herdr -> canonical Flocky reconciliation -----------------------
  //
  // Before every plan/execution operation the legacy `<git-common-dir>/herdr`
  // root is reconciled into the canonical `<git-common-dir>/flocky` root.
  // Reconciliation is lock-free and idempotent per artifact:
  //
  // - legacy-only artifacts are validated, staged to a unique temp, and
  //   installed through an atomic exclusive create (`wx`); a lost create
  //   race re-reads the winner and byte-compares instead of overwriting, so
  //   concurrent contenders can never produce a divergent promotion;
  // - identical bytes on both sides are accepted without modification;
  // - divergent valid bytes fail closed with a structured MIGRATION_CONFLICT
  //   (no silent selection and no silent replacement);
  // - the legacy root is never auto-deleted and never acts as a second
  //   canonical authority, so an active legacy write is surfaced as a
  //   conflict instead of silently losing to the canonical copy.
  //
  // Recovery needs no journal: an interrupted promotion leaves at most an
  // inert uniquely-named staging temp, and any later call revalidates the
  // legacy source and completes the install idempotently.

  function migrationPaths(layout) {
    const canonicalRoot = path.join(layout.identity, STATE_DIR);
    const legacyRoot = path.join(layout.identity, LEGACY_STATE_DIR);
    return {
      canonicalRoot,
      legacyRoot,
      canonicalDirectory(type) {
        return path.join(canonicalRoot, ARTIFACT_DIRECTORIES[type]);
      },
      legacyDirectory(type) {
        return path.join(legacyRoot, ARTIFACT_DIRECTORIES[type]);
      },
    };
  }

  function readBytesOptional(target) {
    let bytes;
    try {
      bytes = fs.readFileSync(target);
    } catch (cause) {
      if (cause?.code === "ENOENT") return { ok: true, present: false };
      return error("READ_FAILED", `Unable to read ${JSON.stringify(target)}: ${processErrorDetail(cause)}`, true);
    }
    return { ok: true, present: true, bytes };
  }

  function listLegacyArtifactNames(directory) {
    let names;
    try {
      names = fs.readdirSync(directory);
    } catch (cause) {
      if (cause?.code === "ENOENT") return { ok: true, names: [] };
      return error("READ_FAILED", `Unable to list legacy artifacts in ${JSON.stringify(directory)}: ${processErrorDetail(cause)}`, true);
    }
    return { ok: true, names: names.filter((name) => name.endsWith(MARKDOWN_SUFFIX)) };
  }

  function removeRetiredCoordinationFiles(paths) {
    for (const name of RETIRED_MIGRATION_FILES) {
      try {
        fs.unlinkSync(path.join(paths.canonicalRoot, name));
      } catch {
        // Absent or unreadable coordination files need no action.
      }
    }
  }

  function sweepStaleStagingTemps(paths) {
    const cutoff = Date.now() - ORPHAN_TEMP_STALE_MS;
    for (const type of Object.values(ARTIFACT_TYPES)) {
      const directory = paths.canonicalDirectory(type);
      let names;
      try {
        names = fs.readdirSync(directory);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(MIGRATION_TEMP_SUFFIX)) continue;
        const target = path.join(directory, name);
        let mtimeMs;
        try {
          mtimeMs = fs.statSync(target).mtimeMs;
        } catch {
          continue;
        }
        // Only stale temps are swept: a live contender's fresh temp is never
        // touched, and staging temps are inert until promoted from freshly
        // validated legacy bytes through an exclusive create.
        if (!Number.isFinite(mtimeMs) || mtimeMs > cutoff) continue;
        try {
          fs.unlinkSync(target);
        } catch {
          // Best-effort sweep; the temp stays inert either way.
        }
      }
    }
  }

  function installExclusive(target, bytes) {
    try {
      fs.writeFileSync(target, bytes, { flag: "wx" });
      return { ok: true, installed: true };
    } catch (cause) {
      if (cause?.code === "EEXIST") return { ok: true, installed: false };
      return error("MIGRATION_STAGE_FAILED", `Unable to install canonical artifact ${JSON.stringify(target)}: ${processErrorDetail(cause)}`, true);
    }
  }

  // Settles one validated promotion against the canonical target without ever
  // overwriting it: the exclusive create is the single linearization point,
  // and a lost race re-reads the winner and byte-compares instead. Returns
  // `{ ok, migrated }`, a retryable error result, or `{ ok: false, conflict }`
  // for the caller to collect into a fail-closed MIGRATION_CONFLICT.
  function settlePromotionTarget({ type, planId, legacyTarget, target, bytes }) {
    const installed = installExclusive(target, bytes);
    if (installed.error) return installed;
    if (installed.installed) return { ok: true, migrated: true };
    // Another contender installed first: byte-compare, never overwrite.
    const current = readBytesOptional(target);
    if (current.error) return current;
    if (!current.present) {
      return error("MIGRATION_PROMOTE_FAILED", `Canonical artifact ${JSON.stringify(target)} changed during promotion; retry.`, true);
    }
    if (current.bytes.equals(bytes)) {
      return { ok: true, migrated: false }; // Idempotent: the canonical copy already carries these bytes.
    }
    if (parseArtifact(current.bytes.toString("utf8")).error) {
      return repairCorruptTarget({ type, planId, legacyTarget, target });
    }
    return {
      ok: false,
      conflict: {
        artifactType: type,
        planId,
        reason: "DIVERGENT_BYTES",
        detail: "Another contender promoted different valid bytes first; no side was selected or replaced.",
        legacyPath: legacyTarget,
        canonicalPath: target,
      },
    };
  }

  // Repairs a corrupt canonical target from the legacy source without blind
  // overwrites: the legacy source is revalidated immediately before the
  // repair, and the replacement itself goes through unlink plus an exclusive
  // create, so a concurrent winner still forces a byte-compare fail-closed.
  function repairCorruptTarget({ type, planId, layout, legacyTarget, target }) {
    const fresh = readBytesOptional(legacyTarget);
    if (fresh.error) return fresh;
    if (!fresh.present) {
      return error("MIGRATION_PROMOTE_FAILED", `Legacy artifact ${JSON.stringify(legacyTarget)} disappeared during repair; retry.`, true);
    }
    const check = inspectLegacyArtifact(type, layout, planId, fresh.bytes);
    if (!check.ok) {
      return {
        ok: false,
        conflict: {
          artifactType: type,
          planId,
          reason: check.reason,
          detail: check.detail,
          legacyPath: legacyTarget,
          canonicalPath: target,
        },
      };
    }
    try {
      fs.unlinkSync(target);
    } catch (cause) {
      if (cause?.code !== "ENOENT") {
        return error("MIGRATION_PROMOTE_FAILED", `Unable to remove the corrupt canonical artifact ${JSON.stringify(target)}: ${processErrorDetail(cause)}`, true);
      }
    }
    const installed = installExclusive(target, fresh.bytes);
    if (installed.error) return installed;
    if (installed.installed) return { ok: true, migrated: true };
    const current = readBytesOptional(target);
    if (current.error) return current;
    if (!current.present) {
      return error("MIGRATION_PROMOTE_FAILED", `Canonical artifact ${JSON.stringify(target)} changed during repair; retry.`, true);
    }
    if (current.bytes.equals(fresh.bytes)) return { ok: true, migrated: false };
    if (parseArtifact(current.bytes.toString("utf8")).error) {
      return error("MIGRATION_PROMOTE_FAILED", `Canonical artifact ${JSON.stringify(target)} changed during repair; retry.`, true);
    }
    return {
      ok: false,
      conflict: {
        artifactType: type,
        planId,
        reason: "DIVERGENT_BYTES",
        detail: "Another contender promoted different valid bytes during repair; no side was selected or replaced.",
        legacyPath: legacyTarget,
        canonicalPath: target,
      },
    };
  }

  function inspectLegacyArtifact(type, layout, planId, bytes) {
    const parsed = parseArtifact(bytes.toString("utf8"));
    if (parsed.error) {
      return { ok: false, reason: "CORRUPT_LEGACY_ARTIFACT", detail: parsed.error.message };
    }
    const metadata = parsed.metadata;
    if (metadata.schema !== SCHEMA_VERSION) {
      return {
        ok: false,
        reason: "LEGACY_SCHEMA_MISMATCH",
        detail: `Legacy artifact schema ${JSON.stringify(metadata.schema)} is not ${SCHEMA_VERSION}.`,
      };
    }
    if (metadata.artifactType !== type) {
      return {
        ok: false,
        reason: "LEGACY_ARTIFACT_TYPE_MISMATCH",
        detail: `Legacy artifact records type ${JSON.stringify(metadata.artifactType)}, expected ${JSON.stringify(type)}.`,
      };
    }
    if (metadata.planId !== planId) {
      return {
        ok: false,
        reason: "LEGACY_PLAN_ID_MISMATCH",
        detail: `Legacy artifact records plan ID ${JSON.stringify(metadata.planId)}, expected ${JSON.stringify(planId)}.`,
      };
    }
    if (typeof metadata.identity !== "string" || metadata.identity.length === 0 || metadata.identity !== layout.identity) {
      return {
        ok: false,
        reason: "LEGACY_IDENTITY_MISMATCH",
        detail: `Legacy artifact belongs to repository ${JSON.stringify(metadata.identity)}, not ${JSON.stringify(layout.identity)}.`,
      };
    }
    // Full required metadata validity, mirroring the canonical writer's stamp.
    if (typeof metadata.toplevel !== "string" || metadata.toplevel.length === 0) {
      return {
        ok: false,
        reason: "LEGACY_INVALID_METADATA",
        detail: "Legacy artifact is missing a valid toplevel.",
      };
    }
    for (const key of ["createdAt", "updatedAt"]) {
      const value = metadata[key];
      if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
        return {
          ok: false,
          reason: "LEGACY_INVALID_METADATA",
          detail: `Legacy artifact metadata ${JSON.stringify(key)} is not a valid timestamp.`,
        };
      }
    }
    // The legacy body must satisfy the same constraints as a canonical write:
    // a nonempty Markdown body of at most MAX_MARKDOWN_BYTES UTF-8 bytes.
    const markdownFailure = validateMarkdown(parsed.markdown);
    if (markdownFailure) {
      return {
        ok: false,
        reason: "LEGACY_INVALID_MARKDOWN",
        detail: markdownFailure.error.message,
      };
    }
    return { ok: true };
  }

  function promoteLegacyArtifact({ type, planId, legacyTarget, canonicalDirectory, target, bytes }) {
    let temp;
    try {
      fs.mkdirSync(canonicalDirectory, { recursive: true });
      temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}${MIGRATION_TEMP_SUFFIX}`;
      fs.writeFileSync(temp, bytes);
    } catch (cause) {
      if (temp) {
        try {
          fs.unlinkSync(temp);
        } catch {
          // The staging write may never have created the temp file.
        }
      }
      return error("MIGRATION_STAGE_FAILED", `Unable to stage legacy ${type} artifact ${JSON.stringify(planId)}: ${processErrorDetail(cause)}`, true);
    }
    try {
      return settlePromotionTarget({ type, planId, legacyTarget, target, bytes });
    } finally {
      try {
        fs.unlinkSync(temp);
      } catch {
        // Each contender always cleans its own staging temp; a crash leaves
        // an inert orphan that later calls sweep once stale.
      }
    }
  }

  async function reconcileLegacyState(layout) {
    const paths = migrationPaths(layout);
    removeRetiredCoordinationFiles(paths);
    sweepStaleStagingTemps(paths);

    const conflicts = [];
    const migrated = [];
    for (const type of [ARTIFACT_TYPES.PLAN, ARTIFACT_TYPES.EXECUTION]) {
      const legacyDirectory = paths.legacyDirectory(type);
      const canonicalDirectory = paths.canonicalDirectory(type);
      const listed = listLegacyArtifactNames(legacyDirectory);
      if (listed.error) return listed;
      for (const name of listed.names) {
        const planId = name.slice(0, -MARKDOWN_SUFFIX.length);
        const legacyTarget = path.join(legacyDirectory, name);
        const canonicalTarget = path.join(canonicalDirectory, `${planId}${MARKDOWN_SUFFIX}`);
        if (!PLAN_ID_PATTERN.test(planId)) {
          conflicts.push({
            artifactType: type,
            planId,
            reason: "INVALID_PLAN_ID",
            detail: "Legacy artifact file name is not a valid plan ID.",
            legacyPath: legacyTarget,
            canonicalPath: null,
          });
          continue;
        }
        const legacyBytes = readBytesOptional(legacyTarget);
        if (legacyBytes.error) return legacyBytes;
        if (!legacyBytes.present) continue; // Vanished mid-scan; nothing to reconcile.
        const canonicalBytes = readBytesOptional(canonicalTarget);
        if (canonicalBytes.error) return canonicalBytes;

        if (canonicalBytes.present && canonicalBytes.bytes.equals(legacyBytes.bytes)) {
          continue; // Identical bytes: the canonical copy already carries the legacy state.
        }

        if (canonicalBytes.present && parseArtifact(canonicalBytes.bytes.toString("utf8")).error) {
          // The canonical copy carries no parsable state, so the legacy
          // source repairs it through fresh revalidation plus unlink and an
          // exclusive create — never a blind overwrite.
          const repaired = repairCorruptTarget({ type, planId, layout, legacyTarget, target: canonicalTarget });
          if (repaired.error) return repaired;
          if (repaired.conflict) {
            conflicts.push(repaired.conflict);
            continue;
          }
          if (repaired.migrated) migrated.push({ artifactType: type, planId, path: canonicalTarget });
          continue;
        }

        const legacyCheck = inspectLegacyArtifact(type, layout, planId, legacyBytes.bytes);
        if (!legacyCheck.ok) {
          conflicts.push({
            artifactType: type,
            planId,
            reason: legacyCheck.reason,
            detail: legacyCheck.detail,
            legacyPath: legacyTarget,
            canonicalPath: canonicalTarget,
          });
          continue;
        }
        if (canonicalBytes.present) {
          conflicts.push({
            artifactType: type,
            planId,
            reason: "DIVERGENT_BYTES",
            detail: "Legacy and canonical artifacts are both valid but differ; no side was selected or replaced.",
            legacyPath: legacyTarget,
            canonicalPath: canonicalTarget,
          });
          continue;
        }
        const promotion = promoteLegacyArtifact({ type, planId, legacyTarget, canonicalDirectory, target: canonicalTarget, bytes: legacyBytes.bytes });
        if (promotion.error) return promotion;
        if (promotion.conflict) {
          conflicts.push(promotion.conflict);
          continue;
        }
        if (promotion.migrated) migrated.push({ artifactType: type, planId, path: canonicalTarget });
      }
    }

    if (conflicts.length > 0) {
      return error(
        "MIGRATION_CONFLICT",
        `Legacy state reconciliation found ${conflicts.length} unresolvable conflict(s) between ${JSON.stringify(paths.legacyRoot)} and ${JSON.stringify(paths.canonicalRoot)}; no artifact was selected or replaced. Resolve the named files and retry.`,
        false,
        { conflicts },
      );
    }
    return { ok: true, migrated };
  }

  return {
    layout: resolveRepositoryLayout,
    writeArtifact,
    readArtifact,
    writePlan: (input) => writeArtifact(ARTIFACT_TYPES.PLAN, input),
    readPlan: (planId) => readArtifact(ARTIFACT_TYPES.PLAN, planId),
    writeExecution: (input) => writeArtifact(ARTIFACT_TYPES.EXECUTION, input),
    readExecution: (planId) => readArtifact(ARTIFACT_TYPES.EXECUTION, planId),
  };
}
