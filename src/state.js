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

const STATE_DIR = "herdr";
const ARTIFACT_DIRECTORIES = Object.freeze({
  [ARTIFACT_TYPES.PLAN]: "plans",
  [ARTIFACT_TYPES.EXECUTION]: "executions",
});

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

function error(code, message, retryable = false) {
  return { ok: false, error: { code, message, retryable } };
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
      return fs.realpathSync(absolute);
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
