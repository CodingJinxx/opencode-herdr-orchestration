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

const MIGRATION_LOCK_FILE = ".migration-lock";
const MIGRATION_JOURNAL_FILE = ".migration-journal";
const MIGRATION_TEMP_SUFFIX = ".migrating";
const MIGRATION_LOCK_STALE_MS = 10_000;
const MARKDOWN_SUFFIX = ".md";

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
  // root is reconciled into the canonical `<git-common-dir>/flocky` root:
  //
  // - legacy-only artifacts are validated, staged, and atomically promoted;
  // - identical bytes on both sides are accepted without modification;
  // - divergent valid bytes fail closed with a structured MIGRATION_CONFLICT
  //   (no silent selection and no silent replacement);
  // - the legacy root is never auto-deleted and never acts as a second
  //   canonical authority, so an active legacy write is surfaced as a
  //   conflict instead of silently losing to the canonical copy.
  //
  // A migration lock serializes reconciliation and a write-ahead journal
  // records staged promotions, so a later service call resumes (rolls the
  // staged bytes forward) or rolls back an interrupted reconciliation.

  function migrationPaths(layout) {
    const canonicalRoot = path.join(layout.identity, STATE_DIR);
    const legacyRoot = path.join(layout.identity, LEGACY_STATE_DIR);
    return {
      canonicalRoot,
      legacyRoot,
      lockPath: path.join(canonicalRoot, MIGRATION_LOCK_FILE),
      journalPath: path.join(canonicalRoot, MIGRATION_JOURNAL_FILE),
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

  function fileExists(target) {
    try {
      fs.statSync(target);
      return true;
    } catch {
      return false;
    }
  }

  function acquireMigrationLock(paths) {
    try {
      fs.mkdirSync(paths.canonicalRoot, { recursive: true });
    } catch (cause) {
      return error("MIGRATION_LOCK_FAILED", `Unable to create the Flocky state root: ${processErrorDetail(cause)}`, true);
    }
    const payload = JSON.stringify({
      pid: process.pid,
      acquiredAt: resolveNow(now).toISOString(),
    });
    try {
      fs.writeFileSync(paths.lockPath, payload, { encoding: "utf8", flag: "wx" });
      return { ok: true };
    } catch (cause) {
      if (cause?.code !== "EEXIST") {
        return error("MIGRATION_LOCK_FAILED", `Unable to acquire the migration lock: ${processErrorDetail(cause)}`, true);
      }
    }
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(paths.lockPath, "utf8"));
    } catch {
      existing = null;
    }
    const acquiredAt = Date.parse(existing?.acquiredAt ?? "");
    const fresh =
      Number.isFinite(acquiredAt) &&
      resolveNow(now).getTime() - acquiredAt < MIGRATION_LOCK_STALE_MS;
    if (fresh) {
      return error(
        "MIGRATION_BUSY",
        `Another process (pid ${existing?.pid ?? "unknown"}) holds the migration lock acquired at ${existing?.acquiredAt ?? "an unknown time"}; retry once it finishes or the lock goes stale.`,
        true,
      );
    }
    // A crashed writer leaves its lock behind; once the lock is stale the
    // next service call steals it and resumes or rolls back via the journal.
    try {
      fs.writeFileSync(paths.lockPath, payload, "utf8");
      return { ok: true, recovered: true };
    } catch (stealCause) {
      return error("MIGRATION_BUSY", `Unable to steal the stale migration lock: ${processErrorDetail(stealCause)}`, true);
    }
  }

  function releaseMigrationLock(paths) {
    try {
      fs.unlinkSync(paths.lockPath);
    } catch {
      // A missing lock is fine; a later call recovers through staleness.
    }
  }

  function readMigrationJournal(journalPath) {
    let text;
    try {
      text = fs.readFileSync(journalPath, "utf8");
    } catch (cause) {
      if (cause?.code === "ENOENT") return { ok: true, entries: [] };
      return error("MIGRATION_JOURNAL_READ_FAILED", `Unable to read the migration journal: ${processErrorDetail(cause)}`, true);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      return error("MIGRATION_JOURNAL_CORRUPT", `Migration journal is not valid JSON: ${processErrorDetail(cause)}`);
    }
    if (!Array.isArray(parsed)) {
      return error("MIGRATION_JOURNAL_CORRUPT", "Migration journal must contain a JSON array of staged promotions.");
    }
    return { ok: true, entries: parsed.filter((entry) => entry && typeof entry === "object") };
  }

  function writeMigrationJournal(journalPath, entries) {
    const temp = `${journalPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
      fs.renameSync(temp, journalPath);
    } catch (cause) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // The temp file may not exist when the write itself failed.
      }
      return error("MIGRATION_JOURNAL_WRITE_FAILED", `Unable to update the migration journal: ${processErrorDetail(cause)}`, true);
    }
    return { ok: true };
  }

  function appendMigrationJournal(journalPath, entry) {
    const journal = readMigrationJournal(journalPath);
    if (journal.error) return journal;
    return writeMigrationJournal(journalPath, [...journal.entries, entry]);
  }

  function removeMigrationJournalEntry(journalPath, entry) {
    const journal = readMigrationJournal(journalPath);
    if (journal.error) return journal;
    const remaining = journal.entries.filter((candidate) => candidate?.temp !== entry.temp);
    if (remaining.length === journal.entries.length) return { ok: true };
    return writeMigrationJournal(journalPath, remaining);
  }

  function sweepOrphanStagedFiles(paths) {
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
        try {
          fs.unlinkSync(path.join(directory, name));
        } catch {
          // Best-effort sweep; the file no longer participates in any promotion.
        }
      }
    }
  }

  function recoverInterruptedMigration(paths) {
    const journal = readMigrationJournal(paths.journalPath);
    if (journal.error) return journal;
    if (journal.entries.length === 0) {
      sweepOrphanStagedFiles(paths);
      return { ok: true, promoted: 0 };
    }
    const promoted = [];
    const unresolved = [];
    for (const entry of journal.entries) {
      const temp = typeof entry.temp === "string" ? entry.temp : null;
      const target = typeof entry.target === "string" ? entry.target : null;
      if (!temp || !target) continue; // Malformed entries carry no staged bytes.
      if (fileExists(temp)) {
        try {
          // Roll forward: finish the interrupted atomic promotion.
          fs.renameSync(temp, target);
          promoted.push(entry);
        } catch (cause) {
          unresolved.push({ entry, cause });
        }
      }
      // Missing temp: the staged bytes are gone; roll back by dropping the entry.
    }
    const remaining = unresolved.map(({ entry }) => entry);
    const written = writeMigrationJournal(paths.journalPath, remaining);
    if (written.error) return written;
    if (unresolved.length > 0) {
      return error(
        "MIGRATION_PROMOTE_FAILED",
        `Unable to resume ${unresolved.length} interrupted migration promotion(s): ${unresolved
          .map(({ entry, cause }) => `${JSON.stringify(entry.planId ?? entry.target)} (${processErrorDetail(cause)})`)
          .join("; ")}. The journal retains the staged entries for a later retry.`,
        true,
      );
    }
    sweepOrphanStagedFiles(paths);
    return { ok: true, promoted: promoted.length };
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
    if (metadata.identity !== layout.identity) {
      return {
        ok: false,
        reason: "LEGACY_IDENTITY_MISMATCH",
        detail: `Legacy artifact belongs to repository ${JSON.stringify(metadata.identity)}, not ${JSON.stringify(layout.identity)}.`,
      };
    }
    return { ok: true };
  }

  function promoteLegacyArtifact(paths, type, planId, canonicalDirectory, target, bytes) {
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
    const entry = {
      artifactType: type,
      planId,
      temp,
      target,
      stagedAt: resolveNow(now).toISOString(),
    };
    const appended = appendMigrationJournal(paths.journalPath, entry);
    if (appended.error) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // The staged temp is removed with the journal write that protected it.
      }
      return appended;
    }
    try {
      fs.renameSync(temp, target); // Atomic, validation-preserving promotion.
    } catch (cause) {
      // The journal entry stays behind so a later service call can roll the
      // staged bytes forward (temp still present) or roll back (temp gone).
      return error("MIGRATION_PROMOTE_FAILED", `Unable to promote staged legacy ${type} artifact ${JSON.stringify(planId)}: ${processErrorDetail(cause)}`, true);
    }
    removeMigrationJournalEntry(paths.journalPath, entry);
    return { ok: true };
  }

  async function reconcileLegacyState(layout) {
    const paths = migrationPaths(layout);
    const lock = acquireMigrationLock(paths);
    if (lock.error) return lock;
    try {
      const recovered = recoverInterruptedMigration(paths);
      if (recovered.error) return recovered;

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
          const canonicalBytes = readBytesOptional(canonicalTarget);
          if (canonicalBytes.error) return canonicalBytes;

          if (canonicalBytes.present && canonicalBytes.bytes.equals(legacyBytes.bytes)) {
            continue; // Identical bytes: the canonical copy already carries the legacy state.
          }

          if (canonicalBytes.present && parseArtifact(canonicalBytes.bytes.toString("utf8")).error) {
            // The canonical copy carries no parsable state, so the validated
            // legacy copy repairs it through the normal staged promotion.
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
            const repaired = promoteLegacyArtifact(paths, type, planId, canonicalDirectory, canonicalTarget, legacyBytes.bytes);
            if (repaired.error) return repaired;
            migrated.push({ artifactType: type, planId, path: canonicalTarget });
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
          const promotion = promoteLegacyArtifact(paths, type, planId, canonicalDirectory, canonicalTarget, legacyBytes.bytes);
          if (promotion.error) return promotion;
          migrated.push({ artifactType: type, planId, path: canonicalTarget });
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
    } finally {
      releaseMigrationLock(paths);
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
  };
}
