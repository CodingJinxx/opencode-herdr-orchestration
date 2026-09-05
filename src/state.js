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

// Per-artifact repair guards serialize corrupt-canonical repair: only the
// contender holding the guard may remove the corrupt target, so a repair can
// never unlink a concurrent winner. A stale guard (holder crashed) is taken
// over by modification time; a live guard makes contenders fail closed.
const REPAIR_GUARD_SUFFIX = ".repairing";
const REPAIR_GUARD_STALE_MS = 30_000;

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

export const STEERING_SCHEMA_VERSION = 1;
export const MAX_STEERING_BYTES = 8192;
const STEERING_DIR = "steering";
const STEERING_ENTRIES_DIR = "entries";
const STEERING_CHECKPOINT_FILE = "checkpoint.json";
const STEERING_LOCK_FILE = "queue.lock";
const STEERING_JOURNAL_FILE = "queue.journal";
const STEERING_LOCK_STALE_MS = 30_000;
const STEERING_LOCK_RETRIES = 200;
const STEERING_LOCK_RETRY_MS = 10;
const STEERING_ID_PREFIX = "st_";

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
  //   installed through an atomic exclusive create (`wx`), which stays the
  //   single linearization point: a lost create race re-reads the winner
  //   and byte-compares instead of overwriting, so concurrent contenders
  //   can never produce a divergent promotion;
  // - corrupt canonical repair is serialized by a per-artifact repair guard:
  //   only the guard holder may remove the corrupt target, and any contender
  //   that cannot claim the guard — or observes an unexpected state inside
  //   it — fails closed with a structured conflict instead of overwriting;
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

  // Claims the per-artifact repair guard through an atomic exclusive create.
  // Returns `{ ok: true }` for the single holder, a retryable error result
  // when coordination itself fails, or `{ ok: false, conflict }` when another
  // contender holds a live guard — which fails closed instead of risking a
  // divergent promotion. A stale guard (holder crashed) is removed and the
  // claim retried once.
  function acquireRepairGuard(guard) {
    const claim = `${process.pid}.${randomBytes(6).toString("hex")}\n`;
    const concurrentConflict = () => ({
      ok: false,
      conflict: {
        reason: "CONCURRENT_REPAIR",
        detail: "Another contender is repairing this artifact; failing closed instead of risking a divergent promotion. Retry once it settles.",
      },
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.writeFileSync(guard, claim, { flag: "wx" });
        return { ok: true };
      } catch (cause) {
        if (cause?.code !== "EEXIST") {
          return error("MIGRATION_PROMOTE_FAILED", `Unable to coordinate corrupt repair for ${JSON.stringify(guard)}: ${processErrorDetail(cause)}`, true);
        }
      }
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(guard).mtimeMs;
      } catch {
        continue; // The guard vanished; retry the exclusive claim once.
      }
      if (Number.isFinite(mtimeMs) && Date.now() - mtimeMs > REPAIR_GUARD_STALE_MS) {
        try {
          fs.unlinkSync(guard);
        } catch {
          // Another contender removed or replaced it; retry the claim once.
        }
        continue;
      }
      return concurrentConflict();
    }
    return concurrentConflict();
  }

  // Repairs a corrupt canonical target from the legacy source without ever
  // unlinking a concurrent winner: a per-artifact repair guard serializes the
  // unlink window, both sides are re-read under the guard, and anything other
  // than the expected corrupt state settles by byte-compare instead of
  // overwriting. The exclusive install stays the single linearization point,
  // so two contenders can never both report migrated with divergent bytes:
  // at most one guard holder repairs, and every other path byte-compares.
  function repairCorruptTarget({ type, planId, layout, legacyTarget, target }) {
    const guard = `${target}${REPAIR_GUARD_SUFFIX}`;
    const claim = acquireRepairGuard(guard);
    if (claim.error) return claim;
    if (claim.conflict) {
      return {
        ok: false,
        conflict: {
          artifactType: type,
          planId,
          reason: claim.conflict.reason,
          detail: claim.conflict.detail,
          legacyPath: legacyTarget,
          canonicalPath: target,
        },
      };
    }
    try {
      const current = readBytesOptional(target);
      if (current.error) return current;
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
      if (current.present && !parseArtifact(current.bytes.toString("utf8")).error) {
        // Settled while the guard was claimed: byte-compare, never overwrite.
        if (current.bytes.equals(fresh.bytes)) return { ok: true, migrated: false };
        return {
          ok: false,
          conflict: {
            artifactType: type,
            planId,
            reason: "DIVERGENT_BYTES",
            detail: "The canonical artifact settled while repair was coordinated; no side was selected or replaced.",
            legacyPath: legacyTarget,
            canonicalPath: target,
          },
        };
      }
      if (current.present) {
        try {
          fs.unlinkSync(target);
        } catch (cause) {
          if (cause?.code !== "ENOENT") {
            return error("MIGRATION_PROMOTE_FAILED", `Unable to remove the corrupt canonical artifact ${JSON.stringify(target)}: ${processErrorDetail(cause)}`, true);
          }
          return error("MIGRATION_PROMOTE_FAILED", `Canonical artifact ${JSON.stringify(target)} changed during repair; retry.`, true);
        }
      }
      const installed = installExclusive(target, fresh.bytes);
      if (installed.error) return installed;
      if (!installed.installed) {
        const raced = readBytesOptional(target);
        if (raced.error) return raced;
        if (!raced.present) {
          return error("MIGRATION_PROMOTE_FAILED", `Canonical artifact ${JSON.stringify(target)} changed during repair; retry.`, true);
        }
        if (raced.bytes.equals(fresh.bytes)) return { ok: true, migrated: false };
        if (parseArtifact(raced.bytes.toString("utf8")).error) {
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
      const landed = readBytesOptional(target);
      if (landed.error) return landed;
      if (!landed.present || !landed.bytes.equals(fresh.bytes)) {
        return error("MIGRATION_PROMOTE_FAILED", `Canonical artifact ${JSON.stringify(target)} changed during repair; retry.`, true);
      }
      return { ok: true, migrated: true };
    } finally {
      try {
        fs.unlinkSync(guard);
      } catch {
        // The guard is always released; a crash leaves a stale guard that a
        // later contender takes over by modification time.
      }
    }
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

  // --- Developer steering primitives (M2, Option A) ---------------------------
  //
  // Trusted Developer steering only. The sole submitter is the explicit
  // non-flock `developer` context enforced in src/index.js; this service
  // never infers Developer from session mode, directory, environment text,
  // or prompt content. Provenance recorded here is integration-asserted,
  // never an authenticated human (see README).
  //
  // Storage is per Plan ID target scoped under
  // `<git-common-dir>/flocky/steering/<planId>/`:
  // - `entries/<seq10>-<id>.json` immutable publications, service-assigned
  //   sequence (1, 2, ...) plus opaque steering id plus timestamp plus
  //   trusted provenance plus target identity plus bounded content plus
  //   schema version;
  // - `checkpoint.json` holding highest contiguous consumed sequence plus
  //   consumed ids;
  // - `queue.lock` scoped per-target lock via exclusive create with stale
  //   takeover;
  // - `queue.journal` write-ahead journal via atomic rename for recoverable
  //   interruption.
  //
  // Target resolution uses the explicit planId or infers only when exactly
  // one active steering target exists, else fails closed AMBIGUOUS_TARGET
  // with no repository-wide steering. Check shows unread without loading
  // bodies; read returns ordered exact unread with no mutation; consume
  // advances only after durable checkpoint disposition and is idempotent.

  function validateSteeringContent(content) {
    if (typeof content !== "string" || content.length === 0) {
      return error("INVALID_STEERING_CONTENT", "Steering content must be a non-empty string.");
    }
    if (Buffer.byteLength(content, "utf8") > MAX_STEERING_BYTES) {
      return error(
        "INVALID_STEERING_CONTENT",
        `Steering content must not exceed ${MAX_STEERING_BYTES} UTF-8 bytes.`,
      );
    }
    return null;
  }

  function validateSteeringIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      return error("INVALID_STEERING_IDS", "Steering consume requires a non-empty array of steering ids.");
    }
    if (ids.length > 1000) {
      return error("INVALID_STEERING_IDS", "Steering consume accepts at most 1000 ids per call.");
    }
    for (const id of ids) {
      if (typeof id !== "string" || id.length === 0 || id.length > 128) {
        return error("INVALID_STEERING_IDS", "Each steering id must be a non-empty string of at most 128 characters.");
      }
    }
    return null;
  }

  function steeringRoot(layout) {
    return path.join(layout.identity, STATE_DIR, STEERING_DIR);
  }

  function steeringTargetDir(layout, planId) {
    return path.join(steeringRoot(layout), planId);
  }

  function steeringEntriesDir(layout, planId) {
    return path.join(steeringTargetDir(layout, planId), STEERING_ENTRIES_DIR);
  }

  function steeringCheckpointPath(layout, planId) {
    return path.join(steeringTargetDir(layout, planId), STEERING_CHECKPOINT_FILE);
  }

  function steeringLockPath(layout, planId) {
    return path.join(steeringTargetDir(layout, planId), STEERING_LOCK_FILE);
  }

  function steeringJournalPath(layout, planId) {
    return path.join(steeringTargetDir(layout, planId), STEERING_JOURNAL_FILE);
  }

  function parseSteeringFileName(name) {
    const match = /^(\d{10})-(st_[0-9a-f]{16})\.json$/.exec(name);
    if (!match) return null;
    return { sequence: Number.parseInt(match[1], 10), id: match[2] };
  }

  function steeringEntryFileName(sequence, id) {
    return `${String(sequence).padStart(10, "0")}-${id}.json`;
  }

  function createSteeringId() {
    return `${STEERING_ID_PREFIX}${randomBytes(8).toString("hex")}`;
  }

  function normalizeSteeringTargetInput(input) {
    if (typeof input === "string") return { planId: input };
    if (input === undefined) return { planId: undefined };
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return { invalid: true };
    }
    const keys = Object.keys(input);
    if (keys.length === 1 && keys[0] === "planId") return { planId: input.planId };
    if (keys.length === 0) return { planId: undefined };
    return { invalid: true };
  }

  function listSteeringTargets(layout) {
    const root = steeringRoot(layout);
    let names;
    try {
      names = fs.readdirSync(root);
    } catch (cause) {
      if (cause?.code === "ENOENT") return { ok: true, targets: [] };
      return error("READ_FAILED", `Unable to list steering targets: ${processErrorDetail(cause)}`, true);
    }
    const targets = [];
    for (const name of names) {
      if (!PLAN_ID_PATTERN.test(name)) continue;
      const candidate = path.join(root, name);
      let stat;
      try {
        stat = fs.statSync(candidate);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      targets.push(name);
    }
    targets.sort();
    return { ok: true, targets };
  }

  async function resolveSteeringTarget(layout, planId) {
    if (planId === undefined) {
      const listed = listSteeringTargets(layout);
      if (listed.error) return listed;
      if (listed.targets.length !== 1) {
        return error(
          "AMBIGUOUS_TARGET",
          listed.targets.length === 0
            ? "No steering target was given and no active steering target exists; provide an explicit planId. Repository-wide steering is not permitted."
            : `No steering target was given and ${listed.targets.length} active steering targets exist; provide an explicit planId. Repository-wide steering is not permitted.`,
        );
      }
      return { ok: true, planId: listed.targets[0] };
    }
    const failure = validatePlanId(planId);
    if (failure) return failure;
    return { ok: true, planId };
  }

  function readSteeringCheckpointFile(checkpointPath, layout, planId) {
    let text;
    try {
      text = fs.readFileSync(checkpointPath, "utf8");
    } catch (cause) {
      if (cause?.code === "ENOENT") {
        return {
          ok: true,
          checkpoint: { schema: STEERING_SCHEMA_VERSION, planId, identity: layout.identity, highestContiguous: 0, consumedIds: [] },
          present: false,
        };
      }
      return error("READ_FAILED", `Unable to read steering checkpoint: ${processErrorDetail(cause)}`, true);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      return error("CORRUPT_CHECKPOINT", `Steering checkpoint is not valid JSON: ${processErrorDetail(cause)}`);
    }
    if (parsed?.schema !== STEERING_SCHEMA_VERSION) {
      return error("CORRUPT_CHECKPOINT", `Steering checkpoint schema ${JSON.stringify(parsed?.schema)} is not ${STEERING_SCHEMA_VERSION}.`);
    }
    if (parsed?.planId !== planId) {
      return error("CORRUPT_CHECKPOINT", "Steering checkpoint records a different plan ID.");
    }
    if (parsed?.identity !== layout.identity) {
      return error(
        "IDENTITY_MISMATCH",
        `Steering checkpoint belongs to repository ${parsed?.identity}, current repository identity is ${layout.identity}.`,
      );
    }
    if (!Number.isSafeInteger(parsed?.highestContiguous) || parsed.highestContiguous < 0) {
      return error("CORRUPT_CHECKPOINT", "Steering checkpoint highestContiguous is not a valid sequence.");
    }
    if (!Array.isArray(parsed?.consumedIds) || parsed.consumedIds.some((id) => typeof id !== "string")) {
      return error("CORRUPT_CHECKPOINT", "Steering checkpoint consumedIds must be an array of strings.");
    }
    return {
      ok: true,
      checkpoint: {
        schema: STEERING_SCHEMA_VERSION,
        planId,
        identity: layout.identity,
        highestContiguous: parsed.highestContiguous,
        consumedIds: [...parsed.consumedIds],
      },
      present: true,
    };
  }

  function listSteeringEntryNames(entriesDir) {
    let names;
    try {
      names = fs.readdirSync(entriesDir);
    } catch (cause) {
      if (cause?.code === "ENOENT") return { ok: true, names: [] };
      return error("READ_FAILED", `Unable to list steering entries: ${processErrorDetail(cause)}`, true);
    }
    return { ok: true, names: names.filter((name) => name.endsWith(".json")).sort() };
  }

  function computeHighestContiguous(sequenceToId, consumedSet) {
    let next = 1;
    for (;;) {
      const id = sequenceToId.get(next);
      if (!id) break;
      if (!consumedSet.has(id)) break;
      next += 1;
    }
    return next - 1;
  }

  function writeAtomicFile(target, data) {
    const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(temp, data);
      fs.renameSync(temp, target);
    } catch (cause) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // Temp may not exist when the write itself failed.
      }
      return error("WRITE_FAILED", `Unable to atomically write ${JSON.stringify(target)}: ${processErrorDetail(cause)}`, true);
    }
    return { ok: true };
  }

  async function acquireSteeringLock(lockPath) {
    const claim = `${process.pid}.${randomBytes(6).toString("hex")}\n`;
    for (let attempt = 0; attempt < STEERING_LOCK_RETRIES; attempt += 1) {
      try {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, claim, { flag: "wx" });
        return { ok: true, claim };
      } catch (cause) {
        if (cause?.code !== "EEXIST") {
          return error("WRITE_FAILED", `Unable to acquire steering lock: ${processErrorDetail(cause)}`, true);
        }
      }
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(lockPath).mtimeMs;
      } catch {
        continue;
      }
      if (Number.isFinite(mtimeMs) && Date.now() - mtimeMs > STEERING_LOCK_STALE_MS) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Another contender removed or replaced it; retry.
        }
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, STEERING_LOCK_RETRY_MS));
    }
    return error("STEERING_BUSY", "Another steering mutation holds the per-target lock; retry.", true);
  }

  function releaseSteeringLock(lockPath, claim) {
    try {
      const current = fs.readFileSync(lockPath, "utf8");
      if (current !== claim) return;
    } catch {
      return;
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Best-effort release; a stale lock is taken over by mtime.
    }
  }

  function readSteeringJournal(journalPath) {
    let text;
    try {
      text = fs.readFileSync(journalPath, "utf8");
    } catch (cause) {
      if (cause?.code === "ENOENT") return { ok: true, present: false };
      return error("READ_FAILED", `Unable to read steering journal: ${processErrorDetail(cause)}`, true);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A torn journal write is recoverable: discard the torn bytes and let
      // the caller retry; committed state was never touched.
      try {
        fs.unlinkSync(journalPath);
      } catch {}
      return { ok: true, present: false, recovered: "torn-journal-discarded" };
    }
    return { ok: true, present: true, journal: parsed };
  }

  function recoverSteeringJournal(layout, planId) {
    const journalPath = steeringJournalPath(layout, planId);
    const checkpointPath = steeringCheckpointPath(layout, planId);
    const entriesDir = steeringEntriesDir(layout, planId);
    const read = readSteeringJournal(journalPath);
    if (read.error) return read;
    if (!read.present) return { ok: true, recovered: false };
    const journal = read.journal;
    if (!journal || typeof journal !== "object" || journal.planId !== planId) {
      try {
        fs.unlinkSync(journalPath);
      } catch {}
      return { ok: true, recovered: "invalid-journal-discarded" };
    }
    if (journal.op === "submit" && typeof journal.sequence === "number" && typeof journal.id === "string") {
      const fileName = steeringEntryFileName(journal.sequence, journal.id);
      const target = path.join(entriesDir, fileName);
      let exists = false;
      try {
        fs.statSync(target);
        exists = true;
      } catch (cause) {
        if (cause?.code !== "ENOENT") return error("READ_FAILED", `Unable to inspect journaled steering entry: ${processErrorDetail(cause)}`, true);
      }
      if (exists) {
        try {
          fs.unlinkSync(journalPath);
        } catch {}
        return { ok: true, recovered: "submit-already-durable" };
      }
      // Replay the journaled submit idempotently when the full entry is
      // present; otherwise discard (the submitter retries with a new id).
      if (typeof journal.content === "string" && typeof journal.createdAt === "string" && journal.entry && typeof journal.entry === "object") {
        try {
          fs.mkdirSync(entriesDir, { recursive: true });
          fs.writeFileSync(target, JSON.stringify(journal.entry, null, 2), { flag: "wx" });
        } catch (cause) {
          if (cause?.code !== "EEXIST") {
            return error("WRITE_FAILED", `Unable to replay journaled steering submit: ${processErrorDetail(cause)}`, true);
          }
        }
      }
      try {
        fs.unlinkSync(journalPath);
      } catch {}
      return { ok: true, recovered: "submit-replayed" };
    }
    if (journal.op === "consume" && Array.isArray(journal.consumedIds)) {
      const checkpoint = readSteeringCheckpointFile(checkpointPath, layout, planId);
      if (checkpoint.error) return checkpoint;
      const current = new Set(checkpoint.checkpoint.consumedIds);
      const wanted = new Set(journal.consumedIds.filter((id) => typeof id === "string"));
      let covered = true;
      for (const id of wanted) {
        if (!current.has(id)) {
          covered = false;
          break;
        }
      }
      if (covered) {
        try {
          fs.unlinkSync(journalPath);
        } catch {}
        return { ok: true, recovered: "consume-already-durable" };
      }
      // The journaled consume was not durably recorded: merge it with the
      // current checkpoint and install atomically, then clear the journal.
      const merged = new Set([...current, ...wanted]);
      const listed = listSteeringEntryNames(entriesDir);
      if (listed.error) return listed;
      const sequenceToId = new Map();
      for (const name of listed.names) {
        const parsed = parseSteeringFileName(name);
        if (parsed) sequenceToId.set(parsed.sequence, parsed.id);
      }
      // Also include journaled submit entries that may not yet be listed?
      // Consume only references existing entries, so the map is complete.
      const highest = computeHighestContiguous(sequenceToId, merged);
      const nextCheckpoint = {
        schema: STEERING_SCHEMA_VERSION,
        planId,
        identity: layout.identity,
        highestContiguous: highest,
        consumedIds: [...merged].sort(),
      };
      const written = writeAtomicFile(checkpointPath, JSON.stringify(nextCheckpoint, null, 2));
      if (written.error) return written;
      try {
        fs.unlinkSync(journalPath);
      } catch {}
      return { ok: true, recovered: "consume-replayed" };
    }
    try {
      fs.unlinkSync(journalPath);
    } catch {}
    return { ok: true, recovered: "unknown-journal-discarded" };
  }

  async function submitSteering(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return error("INVALID_REQUEST", "Steering submit requires an object with content and optional planId.");
    }
    const keys = Object.keys(input);
    if (!keys.includes("content") || keys.some((key) => key !== "content" && key !== "planId")) {
      return error("INVALID_REQUEST", "Steering submit accepts only content plus optional explicit planId.");
    }
    const contentFailure = validateSteeringContent(input.content);
    if (contentFailure) return contentFailure;
    if (input.planId !== undefined) {
      const planIdFailure = validatePlanId(input.planId);
      if (planIdFailure) return planIdFailure;
    }

    const layout = await resolveRepositoryLayout();
    if (layout.error) return layout;

    const resolved = await resolveSteeringTarget(layout, input.planId);
    if (resolved.error) return resolved;
    const planId = resolved.planId;

    const entriesDir = steeringEntriesDir(layout, planId);
    const checkpointPath = steeringCheckpointPath(layout, planId);
    const lockPath = steeringLockPath(layout, planId);
    const journalPath = steeringJournalPath(layout, planId);

    const acquired = await acquireSteeringLock(lockPath);
    if (acquired.error) return acquired;
    try {
      const recovered = recoverSteeringJournal(layout, planId);
      if (recovered.error) return recovered;

      const listed = listSteeringEntryNames(entriesDir);
      if (listed.error) return listed;
      let maxSequence = 0;
      for (const name of listed.names) {
        const parsed = parseSteeringFileName(name);
        if (parsed && parsed.sequence > maxSequence) maxSequence = parsed.sequence;
      }
      const sequence = maxSequence + 1;
      const id = createSteeringId();
      const createdAt = resolveNow(now).toISOString();
      const entry = {
        schema: STEERING_SCHEMA_VERSION,
        id,
        sequence,
        planId,
        identity: layout.identity,
        toplevel: layout.toplevel,
        createdAt,
        provenance: {
          submitter: "developer",
          integration: "integration-asserted Developer context; not an authenticated human",
        },
        content: input.content,
      };
      const fileName = steeringEntryFileName(sequence, id);
      const target = path.join(entriesDir, fileName);

      // Write-ahead journal via atomic rename, then immutable install via
      // exclusive create, then clear the journal. A crash leaves either an
      // inert temp, a journal that replays idempotently, or a durable entry.
      const journalPayload = { op: "submit", planId, sequence, id, content: input.content, createdAt, entry };
      const journaled = writeAtomicFile(journalPath, JSON.stringify(journalPayload, null, 2));
      if (journaled.error) return journaled;
      try {
        fs.mkdirSync(entriesDir, { recursive: true });
        fs.writeFileSync(target, JSON.stringify(entry, null, 2), { flag: "wx" });
      } catch (cause) {
        if (cause?.code === "EEXIST") {
          return error("WRITE_FAILED", "Steering sequence raced; retry the submission.", true);
        }
        return error("WRITE_FAILED", `Unable to publish immutable steering entry: ${processErrorDetail(cause)}`, true);
      }
      try {
        fs.unlinkSync(journalPath);
      } catch {
        // The entry is already durable via exclusive create; journal cleanup
        // is best-effort and recovered on the next mutation.
      }
      return { ok: true, entry };
    } finally {
      releaseSteeringLock(lockPath, acquired.claim);
    }
  }

  async function checkSteering(input) {
    const normalized = normalizeSteeringTargetInput(input);
    if (normalized.invalid) {
      return error("INVALID_REQUEST", "Steering check accepts only an explicit planId string or an object with optional planId.");
    }
    const layout = await resolveRepositoryLayout();
    if (layout.error) return layout;
    const resolved = await resolveSteeringTarget(layout, normalized.planId);
    if (resolved.error) return resolved;
    const planId = resolved.planId;

    // Lightweight: list entry names plus checkpoint only; never load bodies.
    const entriesDir = steeringEntriesDir(layout, planId);
    const checkpointPath = steeringCheckpointPath(layout, planId);
    const listed = listSteeringEntryNames(entriesDir);
    if (listed.error) return listed;
    const checkpoint = readSteeringCheckpointFile(checkpointPath, layout, planId);
    if (checkpoint.error) return checkpoint;

    const parsedEntries = [];
    for (const name of listed.names) {
      const parsed = parseSteeringFileName(name);
      if (parsed) parsedEntries.push(parsed);
    }
    parsedEntries.sort((a, b) => a.sequence - b.sequence);
    const consumed = new Set(checkpoint.checkpoint.consumedIds);
    let unread = 0;
    let maxSequence = 0;
    for (const entry of parsedEntries) {
      if (entry.sequence > maxSequence) maxSequence = entry.sequence;
      if (!consumed.has(entry.id)) unread += 1;
    }
    return {
      ok: true,
      planId,
      total: parsedEntries.length,
      unread,
      nextSequence: maxSequence + 1,
      highestContiguous: checkpoint.checkpoint.highestContiguous,
    };
  }

  async function readSteering(input) {
    const normalized = normalizeSteeringTargetInput(input);
    if (normalized.invalid) {
      return error("INVALID_REQUEST", "Steering read accepts only an explicit planId string or an object with optional planId.");
    }
    const layout = await resolveRepositoryLayout();
    if (layout.error) return layout;
    const resolved = await resolveSteeringTarget(layout, normalized.planId);
    if (resolved.error) return resolved;
    const planId = resolved.planId;

    // Ordered exact unread with no mutation: no lock, no journal, no
    // checkpoint write; only reads.
    const entriesDir = steeringEntriesDir(layout, planId);
    const checkpointPath = steeringCheckpointPath(layout, planId);
    const checkpoint = readSteeringCheckpointFile(checkpointPath, layout, planId);
    if (checkpoint.error) return checkpoint;
    const listed = listSteeringEntryNames(entriesDir);
    if (listed.error) return listed;

    const consumed = new Set(checkpoint.checkpoint.consumedIds);
    const unread = [];
    for (const name of listed.names) {
      const parsed = parseSteeringFileName(name);
      if (!parsed) continue;
      if (consumed.has(parsed.id)) continue;
      let text;
      try {
        text = fs.readFileSync(path.join(entriesDir, name), "utf8");
      } catch (cause) {
        if (cause?.code === "ENOENT") continue;
        return error("READ_FAILED", `Unable to read steering entry: ${processErrorDetail(cause)}`, true);
      }
      let entry;
      try {
        entry = JSON.parse(text);
      } catch (cause) {
        return error("CORRUPT_CHECKPOINT", `Steering entry ${name} is not valid JSON: ${processErrorDetail(cause)}`);
      }
      if (
        entry?.schema !== STEERING_SCHEMA_VERSION ||
        entry?.id !== parsed.id ||
        entry?.sequence !== parsed.sequence ||
        entry?.planId !== planId ||
        entry?.identity !== layout.identity ||
        typeof entry?.content !== "string" ||
        typeof entry?.createdAt !== "string"
      ) {
        return error("CORRUPT_CHECKPOINT", `Steering entry ${name} failed validation.`);
      }
      unread.push(entry);
    }
    unread.sort((a, b) => a.sequence - b.sequence);
    return {
      ok: true,
      planId,
      entries: unread,
      checkpoint: {
        highestContiguous: checkpoint.checkpoint.highestContiguous,
        consumedIds: [...checkpoint.checkpoint.consumedIds].sort(),
      },
    };
  }

  async function consumeSteering(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return error("INVALID_REQUEST", "Steering consume requires an object with planId and ids.");
    }
    const keys = Object.keys(input);
    if (keys.some((key) => key !== "planId" && key !== "ids")) {
      return error("INVALID_REQUEST", "Steering consume accepts only planId plus ids.");
    }
    const idsFailure = validateSteeringIds(input.ids);
    if (idsFailure) return idsFailure;
    if (input.planId !== undefined) {
      const planIdFailure = validatePlanId(input.planId);
      if (planIdFailure) return planIdFailure;
    }

    const layout = await resolveRepositoryLayout();
    if (layout.error) return layout;
    const resolved = await resolveSteeringTarget(layout, input.planId);
    if (resolved.error) return resolved;
    const planId = resolved.planId;

    const entriesDir = steeringEntriesDir(layout, planId);
    const checkpointPath = steeringCheckpointPath(layout, planId);
    const lockPath = steeringLockPath(layout, planId);
    const journalPath = steeringJournalPath(layout, planId);

    const acquired = await acquireSteeringLock(lockPath);
    if (acquired.error) return acquired;
    try {
      const recovered = recoverSteeringJournal(layout, planId);
      if (recovered.error) return recovered;

      const listed = listSteeringEntryNames(entriesDir);
      if (listed.error) return listed;
      const sequenceToId = new Map();
      const idToSequence = new Map();
      for (const name of listed.names) {
        const parsed = parseSteeringFileName(name);
        if (parsed) {
          sequenceToId.set(parsed.sequence, parsed.id);
          idToSequence.set(parsed.id, parsed.sequence);
        }
      }
      for (const id of input.ids) {
        if (!idToSequence.has(id)) {
          return error("STEERING_NOT_FOUND", `Steering entry ${JSON.stringify(id)} does not exist for plan ${JSON.stringify(planId)}.`);
        }
      }

      const checkpoint = readSteeringCheckpointFile(checkpointPath, layout, planId);
      if (checkpoint.error) return checkpoint;
      const merged = new Set(checkpoint.checkpoint.consumedIds);
      for (const id of input.ids) merged.add(id);
      const highest = computeHighestContiguous(sequenceToId, merged);
      const nextCheckpoint = {
        schema: STEERING_SCHEMA_VERSION,
        planId,
        identity: layout.identity,
        highestContiguous: highest,
        consumedIds: [...merged].sort(),
      };

      // Durable disposition first: journal via atomic rename, checkpoint via
      // atomic rename, then clear journal. Advancement is idempotent.
      const journaled = writeAtomicFile(journalPath, JSON.stringify({ op: "consume", planId, consumedIds: [...merged].sort() }, null, 2));
      if (journaled.error) return journaled;
      const written = writeAtomicFile(checkpointPath, JSON.stringify(nextCheckpoint, null, 2));
      if (written.error) return written;
      try {
        fs.unlinkSync(journalPath);
      } catch {
        // Checkpoint is already durable; journal cleanup is recovered next time.
      }
      const unread = sequenceToId.size - merged.size;
      return { ok: true, planId, checkpoint: { highestContiguous: highest, consumedIds: [...merged].sort() }, unread };
    } finally {
      releaseSteeringLock(lockPath, acquired.claim);
    }
  }

  return {
    layout: resolveRepositoryLayout,
    writeArtifact,
    readArtifact,
    writePlan: (input) => writeArtifact(ARTIFACT_TYPES.PLAN, input),
    readPlan: (planId) => readArtifact(ARTIFACT_TYPES.PLAN, planId),
    writeExecution: (input) => writeArtifact(ARTIFACT_TYPES.EXECUTION, input),
    readExecution: (planId) => readArtifact(ARTIFACT_TYPES.EXECUTION, planId),
    submitSteering,
    checkSteering,
    readSteering,
    consumeSteering,
    listSteeringTargets: async () => {
      const layout = await resolveRepositoryLayout();
      if (layout.error) return layout;
      return listSteeringTargets(layout);
    },
  };
}
