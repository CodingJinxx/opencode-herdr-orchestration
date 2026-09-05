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

// --- Shepherd ownership and lifecycle synchronization (M3) ------------------
// Validated target lifecycle records per active Plan ID. All text fields are
// bounded semantic summaries; reasoning transcripts and terminal scrollback
// are never stored (SENSITIVE_CONTENT_EXCLUDED). Closed vocabularies below
// are the only accepted values for their fields.
export const OWNERSHIP_SCHEMA_VERSION = 1;
export const OWNER_PHASES = Object.freeze({ PLANNING: "planning", GOVERNANCE: "governance" });
export const LIFECYCLE_STATES = Object.freeze({
  PLANNING: "planning",
  EXECUTING: "executing",
  RESULT_EVALUATION: "result-evaluation",
  CONSEQUENTIAL_PREPARATION: "consequential-preparation",
  FINALIZED: "finalized",
});
export const SYNC_POINTS = Object.freeze({
  PLANNING_START: "planning-start",
  PRE_PLAN: "pre-plan",
  PRE_ASSIGNMENT: "pre-assignment",
  MILESTONE_EXECUTING: "milestone-executing",
  RESULT_RECEIVED: "result-received",
  CONTINUE: "continue",
  FINALIZE: "finalize",
  CONSEQUENTIAL_PREPARATION: "consequential-preparation",
});
export const SYNC_DISPOSITIONS = Object.freeze({
  INTEGRATED: "integrated",
  CORRECTED: "corrected",
  ESCALATED: "escalated",
  DEFERRED: "deferred",
});
export const SNAPSHOT_STAGES = Object.freeze({
  PLANNING: "planning",
  EXECUTING: "executing",
  RESULT_EVALUATION: "result-evaluation",
  CONSEQUENTIAL_PREPARATION: "consequential-preparation",
});
// Steering never authorizes consequential actions. This closed list plus any
// other consequential action is always denied; existing approvals still apply.
export const CONSEQUENTIAL_DENIED_ACTIONS = Object.freeze(["push", "tag", "publish", "deploy", "merge"]);
const OWNERSHIP_DIR = "ownership";
const OWNERSHIP_RECORD_FILE = "record.json";
const OWNERSHIP_SYNC_FILE = "sync.json";
const OWNERSHIP_SNAPSHOTS_DIR = "snapshots";
const OWNERSHIP_LOCK_FILE = "queue.lock";
const OWNERSHIP_LOCK_STALE_MS = 30_000;
const OWNERSHIP_LOCK_RETRIES = 200;
const OWNERSHIP_LOCK_RETRY_MS = 10;
const SESSION_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
const MAX_MILESTONE_CHARS = 256;
const MAX_OBJECTIVE_CHARS = 2048;
const MAX_ACTION_CHARS = 2048;
const MAX_SHEEPDOG_TARGET_CHARS = 128;
const MAX_REVISION_CHARS = 128;
const MAX_PENDING_CONSEQUENTIAL_CHARS = 1024;
const MAX_CORRECTION_CHARS = 2048;
const SENSITIVE_CONTENT_PATTERN = /(transcript|scrollback)/i;

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

  // --- M3 ownership validation ------------------------------------------------
  const OWNER_PHASE_VALUES = new Set(Object.values(OWNER_PHASES));
  const LIFECYCLE_STATE_VALUES = new Set(Object.values(LIFECYCLE_STATES));
  const SYNC_POINT_VALUES = new Set(Object.values(SYNC_POINTS));
  const SYNC_DISPOSITION_VALUES = new Set(Object.values(SYNC_DISPOSITIONS));
  const SNAPSHOT_STAGE_VALUES = new Set(Object.values(SNAPSHOT_STAGES));

  function sensitiveExcluded(value) {
    return typeof value === "string" && SENSITIVE_CONTENT_PATTERN.test(value);
  }

  function validateOwnerPhase(phase) {
    if (typeof phase !== "string" || !OWNER_PHASE_VALUES.has(phase)) {
      return error(
        "INVALID_OWNER_PHASE",
        `Owner phase must be one of: ${[...OWNER_PHASE_VALUES].join(", ")}.`,
      );
    }
    return null;
  }

  function validateSession(session) {
    if (typeof session !== "string" || !SESSION_PATTERN.test(session)) {
      return error(
        "INVALID_SESSION",
        "Authoritative session must be 1-128 characters of letters, digits, colon, underscore, or hyphen.",
      );
    }
    return null;
  }

  function validateGeneration(generation) {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      return error("INVALID_GENERATION", "Generation must be a safe integer of at least 1.");
    }
    return null;
  }

  function validateMilestone(milestone) {
    if (typeof milestone !== "string" || milestone.length === 0 || milestone.length > MAX_MILESTONE_CHARS) {
      return error(
        "INVALID_MILESTONE",
        `Milestone must be a non-empty string of at most ${MAX_MILESTONE_CHARS} characters.`,
      );
    }
    if (sensitiveExcluded(milestone)) {
      return error(
        "SENSITIVE_CONTENT_EXCLUDED",
        "Milestone must not contain reasoning transcript or scrollback content; store only bounded semantic summaries.",
      );
    }
    return null;
  }

  function validateLifecycleState(value) {
    if (typeof value !== "string" || !LIFECYCLE_STATE_VALUES.has(value)) {
      return error(
        "INVALID_LIFECYCLE_STATE",
        `Lifecycle state must be one of: ${[...LIFECYCLE_STATE_VALUES].join(", ")}.`,
      );
    }
    return null;
  }

  function validateBoundedSemantic(field, value, max, { allowEmpty = true } = {}) {
    if (typeof value !== "string") {
      return error("INVALID_LIFECYCLE_FIELD", `${field} must be a string.`);
    }
    if ((!allowEmpty && value.length === 0) || value.length > max) {
      return error(
        "INVALID_LIFECYCLE_FIELD",
        `${field} must be ${allowEmpty ? "0" : "1"}-${max} characters.`,
      );
    }
    if (sensitiveExcluded(value)) {
      return error(
        "SENSITIVE_CONTENT_EXCLUDED",
        `${field} must not contain reasoning transcript or scrollback content; store only bounded semantic summaries.`,
      );
    }
    return null;
  }

  function validateSyncPoint(value) {
    if (typeof value !== "string" || !SYNC_POINT_VALUES.has(value)) {
      return error("INVALID_SYNC_POINT", `Sync point must be one of: ${[...SYNC_POINT_VALUES].join(", ")}.`);
    }
    return null;
  }

  function validateDisposition(value) {
    if (typeof value !== "string" || !SYNC_DISPOSITION_VALUES.has(value)) {
      return error(
        "INVALID_DISPOSITION",
        `Disposition must be one of: ${[...SYNC_DISPOSITION_VALUES].join(", ")}.`,
      );
    }
    return null;
  }

  function validateSnapshotStage(value) {
    if (typeof value !== "string" || !SNAPSHOT_STAGE_VALUES.has(value)) {
      return error(
        "INVALID_SNAPSHOT_STAGE",
        `Snapshot stage must be one of: ${[...SNAPSHOT_STAGE_VALUES].join(", ")}.`,
      );
    }
    return null;
  }

  function consequentialDenial() {
    return {
      push: false,
      tag: false,
      publish: false,
      deploy: false,
      merge: false,
      anyConsequential: false,
      approvalsStillRequired: true,
      note: "Steering never authorizes push, tag, publish, deploy, merge, or any consequential action; existing approvals still required.",
    };
  }

  function validateCorrectionText(correction) {
    if (typeof correction !== "string" || correction.length === 0 || correction.length > MAX_CORRECTION_CHARS) {
      return error(
        "INVALID_CORRECTION",
        `Correction must be a non-empty string of at most ${MAX_CORRECTION_CHARS} characters.`,
      );
    }
    if (sensitiveExcluded(correction)) {
      return error(
        "SENSITIVE_CONTENT_EXCLUDED",
        "Correction must not contain reasoning transcript or scrollback content; send only bounded semantic instructions.",
      );
    }
    // Raw steering records are JSON dumps with sequence plus opaque id, or
    // checkpoint shapes. Shepherd sends normal corrective instructions, never
    // raw records.
    if (
      (/"sequence"\s*:\s*\d+/.test(correction) && /st_[0-9a-f]{16}/.test(correction)) ||
      /"consumedIds"/.test(correction) ||
      (/"checkpoint"\s*:/.test(correction) && /"highestContiguous"/.test(correction))
    ) {
      return error(
        "RAW_RECORD_REJECTED",
        "Correction must be normal semantic instructions for sheepdog, never raw steering records or checkpoint dumps.",
      );
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

  // --- M3 ownership storage ---------------------------------------------------
  //
  // Lifecycle records live per active Plan ID under
  // `<git-common-dir>/flocky/ownership/<planId>/record.json` with a scoped
  // per-target lock. Sync dispositions live in `sync.json` as a map from
  // closed sync-point vocabulary to disposition plus fencing. Snapshots live
  // in `snapshots/<stage>.json` for the four snapshot stages. All writes are
  // atomic via temp plus rename under the per-target lock, so concurrent
  // planning and governance contenders elect exactly one winner and losers
  // fail closed with STALE_GENERATION instead of diverging.
  function ownershipPlanDir(layout, planId) {
    return path.join(layout.identity, STATE_DIR, OWNERSHIP_DIR, planId);
  }

  function ownershipRecordPath(layout, planId) {
    return path.join(ownershipPlanDir(layout, planId), OWNERSHIP_RECORD_FILE);
  }

  function ownershipSyncPath(layout, planId) {
    return path.join(ownershipPlanDir(layout, planId), OWNERSHIP_SYNC_FILE);
  }

  function ownershipSnapshotPath(layout, planId, stage) {
    return path.join(ownershipPlanDir(layout, planId), OWNERSHIP_SNAPSHOTS_DIR, `${stage}.json`);
  }

  function ownershipLockPath(layout, planId) {
    return path.join(ownershipPlanDir(layout, planId), OWNERSHIP_LOCK_FILE);
  }

  async function acquireOwnershipLock(lockPath) {
    const claim = `${process.pid}.${randomBytes(6).toString("hex")}\n`;
    for (let attempt = 0; attempt < OWNERSHIP_LOCK_RETRIES; attempt += 1) {
      try {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, claim, { flag: "wx" });
        return { ok: true, claim };
      } catch (cause) {
        if (cause?.code !== "EEXIST") {
          return error("WRITE_FAILED", `Unable to acquire ownership lock: ${processErrorDetail(cause)}`, true);
        }
      }
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(lockPath).mtimeMs;
      } catch {
        continue;
      }
      if (Number.isFinite(mtimeMs) && Date.now() - mtimeMs > OWNERSHIP_LOCK_STALE_MS) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Another contender removed or replaced it; retry.
        }
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, OWNERSHIP_LOCK_RETRY_MS));
    }
    return error("OWNERSHIP_BUSY", "Another ownership mutation holds the per-target lock; retry.", true);
  }

  function releaseOwnershipLock(lockPath, claim) {
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

  function readOwnershipRecordFile(recordPath, layout, planId) {
    let text;
    try {
      text = fs.readFileSync(recordPath, "utf8");
    } catch (cause) {
      if (cause?.code === "ENOENT") return { ok: true, present: false };
      return error("READ_FAILED", `Unable to read ownership record: ${processErrorDetail(cause)}`, true);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      return error("CORRUPT_OWNERSHIP", `Ownership record is not valid JSON: ${processErrorDetail(cause)}`);
    }
    if (parsed?.schema !== OWNERSHIP_SCHEMA_VERSION) {
      return error("CORRUPT_OWNERSHIP", `Ownership schema ${JSON.stringify(parsed?.schema)} is not ${OWNERSHIP_SCHEMA_VERSION}.`);
    }
    if (parsed?.planId !== planId) {
      return error("CORRUPT_OWNERSHIP", "Ownership record carries a different plan ID.");
    }
    if (parsed?.identity !== layout.identity) {
      return error(
        "IDENTITY_MISMATCH",
        `Ownership record belongs to repository ${parsed?.identity}, current repository identity is ${layout.identity}.`,
      );
    }
    return { ok: true, present: true, record: parsed };
  }

  function validateOwnershipRecordShape(record) {
    const phaseFailure = validateOwnerPhase(record?.phase);
    if (phaseFailure) return phaseFailure;
    const sessionFailure = validateSession(record?.session);
    if (sessionFailure) return sessionFailure;
    const generationFailure = validateGeneration(record?.generation);
    if (generationFailure) return generationFailure;
    const milestoneFailure = validateMilestone(record?.milestone);
    if (milestoneFailure) return milestoneFailure;
    const stateFailure = validateLifecycleState(record?.lifecycleState);
    if (stateFailure) return stateFailure;
    for (const [field, max] of [
      ["currentObjective", MAX_OBJECTIVE_CHARS],
      ["currentAction", MAX_ACTION_CHARS],
    ]) {
      const failure = validateBoundedSemantic(field, record?.[field], max, { allowEmpty: true });
      if (failure) return failure;
    }
    for (const [field, max] of [
      ["activeSheepdogTarget", MAX_SHEEPDOG_TARGET_CHARS],
      ["relevantRevision", MAX_REVISION_CHARS],
      ["pendingConsequentialAction", MAX_PENDING_CONSEQUENTIAL_CHARS],
    ]) {
      const failure = validateBoundedSemantic(field, record?.[field], max, { allowEmpty: true });
      if (failure) return failure;
    }
    if (typeof record?.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))) {
      return error("CORRUPT_OWNERSHIP", "Ownership record updatedAt is not a valid timestamp.");
    }
    return null;
  }

  function checkOwnerFencing(record, phase, session, generation) {
    if (record.phase !== phase || record.session !== session) {
      return error(
        "NOT_AUTHORITATIVE_PHASE",
        `NOT AUTHORITATIVE PHASE: plan ${JSON.stringify(record.planId)} is owned by phase ${JSON.stringify(record.phase)} session ${JSON.stringify(record.session)} generation ${record.generation}; caller ${JSON.stringify(phase)} session ${JSON.stringify(session)} is not authoritative.`,
      );
    }
    if (generation !== undefined && record.generation !== generation) {
      return error(
        "STALE_GENERATION",
        `Generation ${JSON.stringify(generation)} does not match authoritative generation ${record.generation} for plan ${JSON.stringify(record.planId)}; refetch ownership before acting.`,
      );
    }
    return null;
  }

  function readOwnershipSyncFile(syncPath, layout, planId) {
    let text;
    try {
      text = fs.readFileSync(syncPath, "utf8");
    } catch (cause) {
      if (cause?.code === "ENOENT") {
        return {
          ok: true,
          present: false,
          sync: { schema: OWNERSHIP_SCHEMA_VERSION, planId, identity: layout.identity, points: {} },
        };
      }
      return error("READ_FAILED", `Unable to read ownership sync: ${processErrorDetail(cause)}`, true);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      return error("CORRUPT_OWNERSHIP", `Ownership sync is not valid JSON: ${processErrorDetail(cause)}`);
    }
    if (parsed?.schema !== OWNERSHIP_SCHEMA_VERSION || parsed?.planId !== planId || parsed?.identity !== layout.identity) {
      return error("CORRUPT_OWNERSHIP", "Ownership sync identity or schema mismatch.");
    }
    if (!parsed?.points || typeof parsed.points !== "object" || Array.isArray(parsed.points)) {
      return error("CORRUPT_OWNERSHIP", "Ownership sync points must be an object.");
    }
    return { ok: true, present: true, sync: parsed };
  }

  function validateClaimInput(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return error("INVALID_REQUEST", "Ownership claim requires an object with planId, phase, session, generation, milestone, lifecycleState, and bounded semantic fields.");
    }
    const allowed = new Set([
      "planId",
      "phase",
      "session",
      "generation",
      "milestone",
      "lifecycleState",
      "currentObjective",
      "currentAction",
      "activeSheepdogTarget",
      "relevantRevision",
      "pendingConsequentialAction",
    ]);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) return error("INVALID_REQUEST", `Ownership claim accepts only ${[...allowed].join(", ")}.`);
    }
    for (const key of ["planId", "phase", "session", "generation", "milestone", "lifecycleState"]) {
      if (!(key in input)) return error("INVALID_REQUEST", `Ownership claim requires ${key}.`);
    }
    // Optional semantic fields default to empty string when omitted.
    const normalized = {
      currentObjective: "",
      currentAction: "",
      activeSheepdogTarget: "",
      relevantRevision: "",
      pendingConsequentialAction: "",
      ...input,
    };
    const planIdFailure = validatePlanId(normalized.planId);
    if (planIdFailure) return planIdFailure;
    const phaseFailure = validateOwnerPhase(normalized.phase);
    if (phaseFailure) return phaseFailure;
    const sessionFailure = validateSession(normalized.session);
    if (sessionFailure) return sessionFailure;
    const generationFailure = validateGeneration(normalized.generation);
    if (generationFailure) return generationFailure;
    const milestoneFailure = validateMilestone(normalized.milestone);
    if (milestoneFailure) return milestoneFailure;
    const stateFailure = validateLifecycleState(normalized.lifecycleState);
    if (stateFailure) return stateFailure;
    for (const [field, max] of [
      ["currentObjective", MAX_OBJECTIVE_CHARS],
      ["currentAction", MAX_ACTION_CHARS],
      ["activeSheepdogTarget", MAX_SHEEPDOG_TARGET_CHARS],
      ["relevantRevision", MAX_REVISION_CHARS],
      ["pendingConsequentialAction", MAX_PENDING_CONSEQUENTIAL_CHARS],
    ]) {
      const failure = validateBoundedSemantic(field, normalized[field], max, { allowEmpty: true });
      if (failure) return failure;
    }
    return { ok: true, normalized };
  }

  async function claimOwnership(input) {
    const validated = validateClaimInput(input);
    if (validated?.error) return validated;
    const normalized = validated.normalized;
    const layout = await resolveRepositoryLayout();
    if (layout.error) return layout;
    const lockPath = ownershipLockPath(layout, normalized.planId);
    const acquired = await acquireOwnershipLock(lockPath);
    if (acquired.error) return acquired;
    try {
      const recordPath = ownershipRecordPath(layout, normalized.planId);
      const existing = readOwnershipRecordFile(recordPath, layout, normalized.planId);
      if (existing.error) return existing;
      if (!existing.present) {
        if (normalized.generation !== 1) {
          return error(
            "STALE_GENERATION",
            `First ownership claim for plan ${JSON.stringify(normalized.planId)} must use generation 1.`,
          );
        }
      } else {
        const shapeFailure = validateOwnershipRecordShape(existing.record);
        if (shapeFailure) return shapeFailure;
        if (normalized.generation <= existing.record.generation) {
          return error(
            "STALE_GENERATION",
            `Claim generation ${normalized.generation} is not newer than authoritative generation ${existing.record.generation} for plan ${JSON.stringify(normalized.planId)}; both phases cannot race on the same generation.`,
          );
        }
      }
      const timestamp = resolveNow(now).toISOString();
      const record = {
        schema: OWNERSHIP_SCHEMA_VERSION,
        planId: normalized.planId,
        identity: layout.identity,
        toplevel: layout.toplevel,
        phase: normalized.phase,
        session: normalized.session,
        generation: normalized.generation,
        milestone: normalized.milestone,
        lifecycleState: normalized.lifecycleState,
        currentObjective: normalized.currentObjective,
        currentAction: normalized.currentAction,
        activeSheepdogTarget: normalized.activeSheepdogTarget,
        relevantRevision: normalized.relevantRevision,
        pendingConsequentialAction: normalized.pendingConsequentialAction,
        updatedAt: timestamp,
      };
      const written = writeAtomicFile(recordPath, JSON.stringify(record, null, 2));
      if (written.error) return written;
      return { ok: true, ownership: record };
    } finally {
      releaseOwnershipLock(lockPath, acquired.claim);
    }
  }

  async function readOwnership(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return error("INVALID_REQUEST", "Ownership read requires an object with planId, phase, and session.");
    }
    const keys = Object.keys(input);
    if (keys.some((key) => key !== "planId" && key !== "phase" && key !== "session")) {
      return error("INVALID_REQUEST", "Ownership read accepts only planId, phase, and session.");
    }
    if (input.planId === undefined || input.phase === undefined || input.session === undefined) {
      return error("INVALID_REQUEST", "Ownership read requires planId, phase, and session.");
    }
    const planIdFailure = validatePlanId(input.planId);
    if (planIdFailure) return planIdFailure;
    const phaseFailure = validateOwnerPhase(input.phase);
    if (phaseFailure) return phaseFailure;
    const sessionFailure = validateSession(input.session);
    if (sessionFailure) return sessionFailure;
    const layout = await resolveRepositoryLayout();
    if (layout.error) return layout;
    const recordPath = ownershipRecordPath(layout, input.planId);
    const stored = readOwnershipRecordFile(recordPath, layout, input.planId);
    if (stored.error) return stored;
    if (!stored.present) return error("OWNERSHIP_NOT_FOUND", `No ownership record exists for plan ${JSON.stringify(input.planId)}.`);
    const shapeFailure = validateOwnershipRecordShape(stored.record);
    if (shapeFailure) return shapeFailure;
    const fencing = checkOwnerFencing(stored.record, input.phase, input.session, undefined);
    if (fencing) return fencing;
    return { ok: true, ownership: stored.record };
  }

  async function recordSync(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return error("INVALID_REQUEST", "Ownership sync requires planId, phase, session, generation, syncPoint, and disposition.");
    }
    const allowed = new Set(["planId", "phase", "session", "generation", "syncPoint", "disposition", "note"]);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) return error("INVALID_REQUEST", "Ownership sync accepts only planId, phase, session, generation, syncPoint, disposition, and optional note.");
    }
    for (const key of ["planId", "phase", "session", "generation", "syncPoint", "disposition"]) {
      if (!(key in input)) return error("INVALID_REQUEST", `Ownership sync requires ${key}.`);
    }
    const planIdFailure = validatePlanId(input.planId);
    if (planIdFailure) return planIdFailure;
    const phaseFailure = validateOwnerPhase(input.phase);
    if (phaseFailure) return phaseFailure;
    const sessionFailure = validateSession(input.session);
    if (sessionFailure) return sessionFailure;
    const generationFailure = validateGeneration(input.generation);
    if (generationFailure) return generationFailure;
    const pointFailure = validateSyncPoint(input.syncPoint);
    if (pointFailure) return pointFailure;
    const dispositionFailure = validateDisposition(input.disposition);
    if (dispositionFailure) return dispositionFailure;
    if (input.note !== undefined) {
      const noteFailure = validateBoundedSemantic("note", input.note, MAX_ACTION_CHARS, { allowEmpty: true });
      if (noteFailure) return noteFailure;
    }
    const layout = await resolveRepositoryLayout();
    if (layout.error) return layout;
    const lockPath = ownershipLockPath(layout, input.planId);
    const acquired = await acquireOwnershipLock(lockPath);
    if (acquired.error) return acquired;
    try {
      const recordPath = ownershipRecordPath(layout, input.planId);
      const stored = readOwnershipRecordFile(recordPath, layout, input.planId);
      if (stored.error) return stored;
      if (!stored.present) return error("OWNERSHIP_NOT_FOUND", `No ownership record exists for plan ${JSON.stringify(input.planId)}; claim ownership before sync.`);
      const shapeFailure = validateOwnershipRecordShape(stored.record);
      if (shapeFailure) return shapeFailure;
      const fencing = checkOwnerFencing(stored.record, input.phase, input.session, input.generation);
      if (fencing) return fencing;
      // Pending consequential action must be recorded before its mandatory
      // consequential-preparation check: the lifecycle record must already
      // carry a non-empty pending action.
      if (input.syncPoint === SYNC_POINTS.CONSEQUENTIAL_PREPARATION && stored.record.pendingConsequentialAction.length === 0) {
        return error(
          "PENDING_CONSEQUENTIAL_REQUIRED",
          "Pending consequential action must be recorded in the lifecycle record before the consequential-preparation sync point.",
        );
      }
      const syncPath = ownershipSyncPath(layout, input.planId);
      const current = readOwnershipSyncFile(syncPath, layout, input.planId);
      if (current.error) return current;
      const timestamp = resolveNow(now).toISOString();
      const entry = {
        syncPoint: input.syncPoint,
        disposition: input.disposition,
        phase: input.phase,
        session: input.session,
        generation: input.generation,
        note: input.note ?? "",
        timestamp,
        consequentialAuthorization: consequentialDenial(),
      };
      const next = {
        schema: OWNERSHIP_SCHEMA_VERSION,
        planId: input.planId,
        identity: layout.identity,
        points: { ...current.sync.points, [input.syncPoint]: entry },
      };
      const written = writeAtomicFile(syncPath, JSON.stringify(next, null, 2));
      if (written.error) return written;
      return { ok: true, planId: input.planId, sync: entry, points: next.points };
    } finally {
      releaseOwnershipLock(lockPath, acquired.claim);
    }
  }

  async function readSync(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return error("INVALID_REQUEST", "Ownership sync read requires planId, phase, and session.");
    }
    const keys = Object.keys(input);
    if (keys.some((key) => key !== "planId" && key !== "phase" && key !== "session")) {
      return error("INVALID_REQUEST", "Ownership sync read accepts only planId, phase, and session.");
    }
    if (input.planId === undefined || input.phase === undefined || input.session === undefined) {
      return error("INVALID_REQUEST", "Ownership sync read requires planId, phase, and session.");
    }
    const planIdFailure = validatePlanId(input.planId);
    if (planIdFailure) return planIdFailure;
    const phaseFailure = validateOwnerPhase(input.phase);
    if (phaseFailure) return phaseFailure;
    const sessionFailure = validateSession(input.session);
    if (sessionFailure) return sessionFailure;
    const layout = await resolveRepositoryLayout();
    if (layout.error) return layout;
    const recordPath = ownershipRecordPath(layout, input.planId);
    const stored = readOwnershipRecordFile(recordPath, layout, input.planId);
    if (stored.error) return stored;
    if (!stored.present) return error("OWNERSHIP_NOT_FOUND", `No ownership record exists for plan ${JSON.stringify(input.planId)}.`);
    const fencing = checkOwnerFencing(stored.record, input.phase, input.session, undefined);
    if (fencing) return fencing;
    const syncPath = ownershipSyncPath(layout, input.planId);
    const current = readOwnershipSyncFile(syncPath, layout, input.planId);
    if (current.error) return current;
    return { ok: true, planId: input.planId, points: current.sync.points, ownership: stored.record };
  }

  async function recordSnapshot(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return error("INVALID_REQUEST", "Ownership snapshot requires planId, phase, session, generation, and stage.");
    }
    const allowed = new Set([
      "planId",
      "phase",
      "session",
      "generation",
      "stage",
      "milestone",
      "lifecycleState",
      "currentObjective",
      "currentAction",
      "activeSheepdogTarget",
      "relevantRevision",
      "pendingConsequentialAction",
    ]);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) return error("INVALID_REQUEST", "Ownership snapshot accepts only lifecycle fields plus stage.");
    }
    for (const key of ["planId", "phase", "session", "generation", "stage"]) {
      if (!(key in input)) return error("INVALID_REQUEST", `Ownership snapshot requires ${key}.`);
    }
    const planIdFailure = validatePlanId(input.planId);
    if (planIdFailure) return planIdFailure;
    const phaseFailure = validateOwnerPhase(input.phase);
    if (phaseFailure) return phaseFailure;
    const sessionFailure = validateSession(input.session);
    if (sessionFailure) return sessionFailure;
    const generationFailure = validateGeneration(input.generation);
    if (generationFailure) return generationFailure;
    const stageFailure = validateSnapshotStage(input.stage);
    if (stageFailure) return stageFailure;
    for (const [field, max] of [
      ["milestone", MAX_MILESTONE_CHARS],
      ["currentObjective", MAX_OBJECTIVE_CHARS],
      ["currentAction", MAX_ACTION_CHARS],
      ["activeSheepdogTarget", MAX_SHEEPDOG_TARGET_CHARS],
      ["relevantRevision", MAX_REVISION_CHARS],
      ["pendingConsequentialAction", MAX_PENDING_CONSEQUENTIAL_CHARS],
    ]) {
      if (input[field] !== undefined) {
        const failure = field === "milestone"
          ? (input[field].length === 0 ? error("INVALID_MILESTONE", "Milestone must be non-empty when provided.") : validateBoundedSemantic(field, input[field], max, { allowEmpty: false }))
          : validateBoundedSemantic(field, input[field], max, { allowEmpty: true });
        if (failure) return failure;
        if (sensitiveExcluded(input[field])) {
          return error("SENSITIVE_CONTENT_EXCLUDED", `${field} must not contain reasoning transcript or scrollback content.`);
        }
      }
    }
    if (input.lifecycleState !== undefined) {
      const stateFailure = validateLifecycleState(input.lifecycleState);
      if (stateFailure) return stateFailure;
    }
    const layout = await resolveRepositoryLayout();
    if (layout.error) return layout;
    const lockPath = ownershipLockPath(layout, input.planId);
    const acquired = await acquireOwnershipLock(lockPath);
    if (acquired.error) return acquired;
    try {
      const recordPath = ownershipRecordPath(layout, input.planId);
      const stored = readOwnershipRecordFile(recordPath, layout, input.planId);
      if (stored.error) return stored;
      if (!stored.present) return error("OWNERSHIP_NOT_FOUND", `No ownership record exists for plan ${JSON.stringify(input.planId)}; claim ownership before snapshots.`);
      const shapeFailure = validateOwnershipRecordShape(stored.record);
      if (shapeFailure) return shapeFailure;
      const fencing = checkOwnerFencing(stored.record, input.phase, input.session, input.generation);
      if (fencing) return fencing;
      const pending = input.pendingConsequentialAction ?? stored.record.pendingConsequentialAction;
      if (input.stage === SNAPSHOT_STAGES.CONSEQUENTIAL_PREPARATION && pending.length === 0) {
        return error(
          "PENDING_CONSEQUENTIAL_REQUIRED",
          "Pending consequential action must be recorded before the consequential-preparation snapshot.",
        );
      }
      const timestamp = resolveNow(now).toISOString();
      const snapshot = {
        schema: OWNERSHIP_SCHEMA_VERSION,
        planId: input.planId,
        identity: layout.identity,
        stage: input.stage,
        phase: input.phase,
        session: input.session,
        generation: input.generation,
        milestone: input.milestone ?? stored.record.milestone,
        lifecycleState: input.lifecycleState ?? stored.record.lifecycleState,
        currentObjective: input.currentObjective ?? stored.record.currentObjective,
        currentAction: input.currentAction ?? stored.record.currentAction,
        activeSheepdogTarget: input.activeSheepdogTarget ?? stored.record.activeSheepdogTarget,
        relevantRevision: input.relevantRevision ?? stored.record.relevantRevision,
        pendingConsequentialAction: pending,
        timestamp,
        consequentialAuthorization: consequentialDenial(),
      };
      const target = ownershipSnapshotPath(layout, input.planId, input.stage);
      const written = writeAtomicFile(target, JSON.stringify(snapshot, null, 2));
      if (written.error) return written;
      return { ok: true, snapshot };
    } finally {
      releaseOwnershipLock(lockPath, acquired.claim);
    }
  }

  async function routeCorrection(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return error("INVALID_REQUEST", "Correction routing requires planId, phase, session, generation, and correction.");
    }
    const allowed = new Set(["planId", "phase", "session", "generation", "correction", "syncPoint"]);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) return error("INVALID_REQUEST", "Correction routing accepts only planId, phase, session, generation, correction, and optional syncPoint.");
    }
    for (const key of ["planId", "phase", "session", "generation", "correction"]) {
      if (!(key in input)) return error("INVALID_REQUEST", `Correction routing requires ${key}.`);
    }
    const planIdFailure = validatePlanId(input.planId);
    if (planIdFailure) return planIdFailure;
    const phaseFailure = validateOwnerPhase(input.phase);
    if (phaseFailure) return phaseFailure;
    const sessionFailure = validateSession(input.session);
    if (sessionFailure) return sessionFailure;
    const generationFailure = validateGeneration(input.generation);
    if (generationFailure) return generationFailure;
    const correctionFailure = validateCorrectionText(input.correction);
    if (correctionFailure) return correctionFailure;
    if (input.syncPoint !== undefined) {
      const pointFailure = validateSyncPoint(input.syncPoint);
      if (pointFailure) return pointFailure;
    }
    const layout = await resolveRepositoryLayout();
    if (layout.error) return layout;
    const recordPath = ownershipRecordPath(layout, input.planId);
    const stored = readOwnershipRecordFile(recordPath, layout, input.planId);
    if (stored.error) return stored;
    if (!stored.present) return error("OWNERSHIP_NOT_FOUND", `No ownership record exists for plan ${JSON.stringify(input.planId)}; claim ownership before corrections.`);
    const fencing = checkOwnerFencing(stored.record, input.phase, input.session, input.generation);
    if (fencing) return fencing;
    const timestamp = resolveNow(now).toISOString();
    // Semantic correction: normal instructions for sheepdog, never raw
    // records. Steering never authorizes consequential actions.
    return {
      ok: true,
      planId: input.planId,
      correction: {
        instruction: input.correction,
        syncPoint: input.syncPoint ?? null,
        target: "sheepdog",
        channel: "normal-corrective-instructions",
        timestamp,
        generation: input.generation,
      },
      consequentialAuthorization: consequentialDenial(),
    };
  }

  // Ownership-gated steering proof: when no ownership record exists the raw
  // M2 behavior applies (explicit planId or single-target inference). When a
  // record exists, the caller must prove authoritative phase plus session
  // plus generation; otherwise NOT AUTHORITATIVE PHASE with no bodies loaded.
  function parseOwnershipProof(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return { present: false };
    const hasProof = "phase" in input || "session" in input || "generation" in input;
    if (!hasProof) return { present: false };
    if (!("phase" in input && "session" in input && "generation" in input)) {
      return { invalid: true };
    }
    const phaseFailure = validateOwnerPhase(input.phase);
    if (phaseFailure) return { invalid: true, failure: phaseFailure };
    const sessionFailure = validateSession(input.session);
    if (sessionFailure) return { invalid: true, failure: sessionFailure };
    const generationFailure = validateGeneration(input.generation);
    if (generationFailure) return { invalid: true, failure: generationFailure };
    return { present: true, phase: input.phase, session: input.session, generation: input.generation };
  }

  async function enforceOwnershipForSteering(layout, planId) {
    const recordPath = ownershipRecordPath(layout, planId);
    const stored = readOwnershipRecordFile(recordPath, layout, planId);
    if (stored.error) return stored;
    if (!stored.present) return { ok: true, owned: false };
    const shapeFailure = validateOwnershipRecordShape(stored.record);
    if (shapeFailure) return shapeFailure;
    return { ok: true, owned: true, record: stored.record };
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
    // M3 ownership fencing: when a lifecycle record exists for the target,
    // only the recorded owner phase plus session plus generation may check.
    // M2 callers without ownership keep the original explicit-or-singleton
    // behavior with no filesystem side effects beyond reads.
    let planIdInput;
    let proof = { present: false };
    if (input !== null && typeof input === "object" && !Array.isArray(input) && ("phase" in input || "session" in input || "generation" in input)) {
      const parsed = parseOwnershipProof(input);
      if (parsed.invalid) {
        return parsed.failure ?? error("INVALID_REQUEST", "Steering check ownership proof requires phase, session, and generation together.");
      }
      proof = parsed;
      if (!("planId" in input)) {
        return error("INVALID_REQUEST", "Steering check with ownership proof requires an explicit planId.");
      }
      const extra = Object.keys(input).filter((key) => key !== "planId" && key !== "phase" && key !== "session" && key !== "generation");
      if (extra.length > 0) {
        return error("INVALID_REQUEST", "Steering check accepts only planId plus optional ownership proof (phase, session, generation).");
      }
      planIdInput = input.planId;
    } else {
      const normalized = normalizeSteeringTargetInput(input);
      if (normalized.invalid) {
        return error("INVALID_REQUEST", "Steering check accepts only an explicit planId string or an object with optional planId.");
      }
      planIdInput = normalized.planId;
    }
    const layout = await resolveRepositoryLayout();
    if (layout.error) return layout;
    const resolved = await resolveSteeringTarget(layout, planIdInput);
    if (resolved.error) return resolved;
    const planId = resolved.planId;
    const ownership = await enforceOwnershipForSteering(layout, planId);
    if (ownership.error) return ownership;
    if (ownership.owned) {
      if (!proof.present) {
        return error(
          "NOT_AUTHORITATIVE_PHASE",
          `NOT AUTHORITATIVE PHASE: plan ${JSON.stringify(planId)} is owned by phase ${JSON.stringify(ownership.record.phase)} session ${JSON.stringify(ownership.record.session)}; check requires the authoritative phase, session, and generation.`,
        );
      }
      const fencing = checkOwnerFencing(ownership.record, proof.phase, proof.session, proof.generation);
      if (fencing) {
        if (fencing.error.code === "STALE_GENERATION") {
          return error(
            "NOT_AUTHORITATIVE_PHASE",
            `NOT AUTHORITATIVE PHASE: stale generation ${JSON.stringify(proof.generation)} for plan ${JSON.stringify(planId)}; authoritative generation is ${ownership.record.generation}.`,
          );
        }
        return fencing;
      }
    }

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
    let planIdInput;
    let proof = { present: false };
    if (input !== null && typeof input === "object" && !Array.isArray(input) && ("phase" in input || "session" in input || "generation" in input)) {
      const parsed = parseOwnershipProof(input);
      if (parsed.invalid) {
        return parsed.failure ?? error("INVALID_REQUEST", "Steering read ownership proof requires phase, session, and generation together.");
      }
      proof = parsed;
      if (!("planId" in input)) {
        return error("INVALID_REQUEST", "Steering read with ownership proof requires an explicit planId.");
      }
      const extra = Object.keys(input).filter((key) => key !== "planId" && key !== "phase" && key !== "session" && key !== "generation");
      if (extra.length > 0) {
        return error("INVALID_REQUEST", "Steering read accepts only planId plus optional ownership proof (phase, session, generation).");
      }
      planIdInput = input.planId;
    } else {
      const normalized = normalizeSteeringTargetInput(input);
      if (normalized.invalid) {
        return error("INVALID_REQUEST", "Steering read accepts only an explicit planId string or an object with optional planId.");
      }
      planIdInput = normalized.planId;
    }
    const layout = await resolveRepositoryLayout();
    if (layout.error) return layout;
    const resolved = await resolveSteeringTarget(layout, planIdInput);
    if (resolved.error) return resolved;
    const planId = resolved.planId;
    const ownership = await enforceOwnershipForSteering(layout, planId);
    if (ownership.error) return ownership;
    if (ownership.owned) {
      if (!proof.present) {
        return error(
          "NOT_AUTHORITATIVE_PHASE",
          `NOT AUTHORITATIVE PHASE: plan ${JSON.stringify(planId)} is owned by phase ${JSON.stringify(ownership.record.phase)} session ${JSON.stringify(ownership.record.session)}; read requires the authoritative phase, session, and generation.`,
        );
      }
      const fencing = checkOwnerFencing(ownership.record, proof.phase, proof.session, proof.generation);
      if (fencing) {
        if (fencing.error.code === "STALE_GENERATION") {
          return error(
            "NOT_AUTHORITATIVE_PHASE",
            `NOT AUTHORITATIVE PHASE: stale generation ${JSON.stringify(proof.generation)} for plan ${JSON.stringify(planId)}; authoritative generation is ${ownership.record.generation}.`,
          );
        }
        return fencing;
      }
    }

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
    // M3 gated form adds ownership proof plus mandatory sync disposition:
    // planId, ids, phase, session, generation, syncPoint, disposition.
    // M2 form (planId plus ids only) is preserved for targets without an
    // ownership record.
    const gatedKeys = new Set(["planId", "ids", "phase", "session", "generation", "syncPoint", "disposition"]);
    const keys = Object.keys(input);
    if (keys.some((key) => !gatedKeys.has(key))) {
      return error("INVALID_REQUEST", "Steering consume accepts only planId, ids, and optional ownership proof plus sync disposition (phase, session, generation, syncPoint, disposition).");
    }
    const idsFailure = validateSteeringIds(input.ids);
    if (idsFailure) return idsFailure;
    if (input.planId !== undefined) {
      const planIdFailure = validatePlanId(input.planId);
      if (planIdFailure) return planIdFailure;
    }
    const hasProof = "phase" in input || "session" in input || "generation" in input || "syncPoint" in input || "disposition" in input;
    let proof = { present: false };
    let syncClaim = null;
    if (hasProof) {
      const parsed = parseOwnershipProof(input);
      if (parsed.invalid) {
        return parsed.failure ?? error("INVALID_REQUEST", "Steering consume ownership proof requires phase, session, and generation together.");
      }
      proof = parsed;
      if (!proof.present) {
        return error("INVALID_REQUEST", "Steering consume with sync disposition requires phase, session, and generation together.");
      }
      if (!("syncPoint" in input && "disposition" in input)) {
        return error("INVALID_REQUEST", "Steering consume with ownership proof requires syncPoint and disposition; disposition is recorded before consume.");
      }
      const pointFailure = validateSyncPoint(input.syncPoint);
      if (pointFailure) return pointFailure;
      const dispositionFailure = validateDisposition(input.disposition);
      if (dispositionFailure) return dispositionFailure;
      syncClaim = { syncPoint: input.syncPoint, disposition: input.disposition };
      if (input.planId === undefined) {
        return error("INVALID_REQUEST", "Steering consume with ownership proof requires an explicit planId.");
      }
    }

    const layout = await resolveRepositoryLayout();
    if (layout.error) return layout;
    const resolved = await resolveSteeringTarget(layout, input.planId);
    if (resolved.error) return resolved;
    const planId = resolved.planId;
    const ownership = await enforceOwnershipForSteering(layout, planId);
    if (ownership.error) return ownership;
    if (ownership.owned) {
      if (!proof.present || !syncClaim) {
        return error(
          "NOT_AUTHORITATIVE_PHASE",
          `NOT AUTHORITATIVE PHASE: plan ${JSON.stringify(planId)} is owned by phase ${JSON.stringify(ownership.record.phase)} session ${JSON.stringify(ownership.record.session)}; consume requires the authoritative phase, session, generation, plus recorded sync disposition before consume.`,
        );
      }
      const fencing = checkOwnerFencing(ownership.record, proof.phase, proof.session, proof.generation);
      if (fencing) {
        if (fencing.error.code === "STALE_GENERATION") {
          return error(
            "NOT_AUTHORITATIVE_PHASE",
            `NOT AUTHORITATIVE PHASE: stale generation ${JSON.stringify(proof.generation)} for plan ${JSON.stringify(planId)}; authoritative generation is ${ownership.record.generation}.`,
          );
        }
        return fencing;
      }
      // Disposition must already be recorded for this sync point and
      // generation before consume advances the checkpoint (idempotent).
      const syncPath = ownershipSyncPath(layout, planId);
      const currentSync = readOwnershipSyncFile(syncPath, layout, planId);
      if (currentSync.error) return currentSync;
      const recorded = currentSync.sync.points[syncClaim.syncPoint];
      if (
        !recorded ||
        recorded.generation !== proof.generation ||
        recorded.disposition !== syncClaim.disposition ||
        recorded.phase !== proof.phase ||
        recorded.session !== proof.session
      ) {
        return error(
          "SYNC_REQUIRED",
          `Disposition ${JSON.stringify(syncClaim.disposition)} for sync point ${JSON.stringify(syncClaim.syncPoint)} must be recorded by the authoritative owner before consume; call ownership sync first.`,
        );
      }
    } else if (syncClaim) {
      return error("INVALID_REQUEST", "Steering consume sync disposition requires an ownership record; claim ownership first.");
    }

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
      // Steering never authorizes consequential actions; existing approvals
      // still required. This denial rides every consume, owned or not.
      return {
        ok: true,
        planId,
        checkpoint: { highestContiguous: highest, consumedIds: [...merged].sort() },
        unread,
        consequentialAuthorization: consequentialDenial(),
      };
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
    claimOwnership,
    readOwnership,
    recordSync,
    readSync,
    recordSnapshot,
    routeCorrection,
    consequentialPolicy: () => ({ ...consequentialDenial(), deniedActions: [...CONSEQUENTIAL_DENIED_ACTIONS] }),
    listSteeringTargets: async () => {
      const layout = await resolveRepositoryLayout();
      if (layout.error) return layout;
      return listSteeringTargets(layout);
    },
    listOwnershipTargets: async () => {
      const layout = await resolveRepositoryLayout();
      if (layout.error) return layout;
      const root = path.join(layout.identity, STATE_DIR, OWNERSHIP_DIR);
      let names;
      try {
        names = fs.readdirSync(root);
      } catch (cause) {
        if (cause?.code === "ENOENT") return { ok: true, targets: [] };
        return error("READ_FAILED", `Unable to list ownership targets: ${processErrorDetail(cause)}`, true);
      }
      const targets = [];
      for (const name of names) {
        if (!PLAN_ID_PATTERN.test(name)) continue;
        try {
          if (!fs.statSync(path.join(root, name)).isDirectory()) continue;
        } catch {
          continue;
        }
        targets.push(name);
      }
      targets.sort();
      return { ok: true, targets };
    },
  };
}
