// 20-M2 operational diagnostics log (diagnostics only, never results).
// Strategy: process-local bounded in-memory ring buffer with no filesystem,
// no Git, no Herdr commands, no plugin tools, and no persistence. Entries are
// ephemeral like SHEPHERD_MODE and response cursors: they do not survive a
// plugin restart and must never substitute for authoritative retrieval via
// herdr_agent_response until complete is true.
// Guardrails: no chain of thought, no transcripts, no scrollback, bounded
// size per field, bounded retention per log, never read as results.
export const DIAGNOSTIC_EVENT_TYPES = Object.freeze([
  "worker-started",
  "prompt-submitted",
  "state-changed",
  "command-failed",
  "settled",
  "disappeared",
  "timed-out",
  "recovery-started",
]);
const DIAGNOSTIC_EVENT_SET = new Set(DIAGNOSTIC_EVENT_TYPES);
export const MAX_DIAGNOSTIC_EVENTS_DEFAULT = 100;
export const MAX_DIAGNOSTIC_EVENTS_LIMIT = 1000;
export const MAX_DIAGNOSTIC_TARGET_CHARS = 64;
export const MAX_DIAGNOSTIC_CODE_CHARS = 64;
export const MAX_DIAGNOSTIC_DETAIL_CHARS = 512;
const SENSITIVE_DIAGNOSTIC_PATTERN = /(transcript|scrollback|chain\s*of\s*thought)/i;
function diagnosticError(code, message) {
  return { ok: false, error: { code, message, retryable: false } };
}
function validateDiagnosticType(type) {
  if (typeof type !== "string" || !DIAGNOSTIC_EVENT_SET.has(type)) {
    return diagnosticError(
      "INVALID_DIAGNOSTIC_TYPE",
      `Diagnostic type must be one of: ${DIAGNOSTIC_EVENT_TYPES.join(", ")}.`,
    );
  }
  return null;
}
function validateDiagnosticTarget(target) {
  if (typeof target !== "string" || target.length === 0 || target.length > MAX_DIAGNOSTIC_TARGET_CHARS) {
    return diagnosticError(
      "INVALID_DIAGNOSTIC_TARGET",
      `Diagnostic target must be a non-empty string of at most ${MAX_DIAGNOSTIC_TARGET_CHARS} characters.`,
    );
  }
  return null;
}
function validateDiagnosticCode(code) {
  if (code === undefined) return null;
  if (typeof code !== "string" || code.length === 0 || code.length > MAX_DIAGNOSTIC_CODE_CHARS) {
    return diagnosticError(
      "INVALID_DIAGNOSTIC_CODE",
      `Diagnostic code must be a non-empty string of at most ${MAX_DIAGNOSTIC_CODE_CHARS} characters.`,
    );
  }
  if (SENSITIVE_DIAGNOSTIC_PATTERN.test(code)) {
    return diagnosticError(
      "SENSITIVE_CONTENT_EXCLUDED",
      "Diagnostic code must not contain transcript, scrollback, or chain of thought content.",
    );
  }
  return null;
}
function validateDiagnosticDetail(detail) {
  if (detail === undefined) return null;
  if (typeof detail !== "string" || detail.length > MAX_DIAGNOSTIC_DETAIL_CHARS) {
    return diagnosticError(
      "INVALID_DIAGNOSTIC_DETAIL",
      `Diagnostic detail must be a string of at most ${MAX_DIAGNOSTIC_DETAIL_CHARS} characters; response text is never stored.`,
    );
  }
  if (SENSITIVE_DIAGNOSTIC_PATTERN.test(detail)) {
    return diagnosticError(
      "SENSITIVE_CONTENT_EXCLUDED",
      "Diagnostic detail must not contain transcript, scrollback, or chain of thought content; store only bounded operational summaries.",
    );
  }
  return null;
}
export function createDiagnosticsLog(options = {}) {
  const maxEvents = options.maxEvents ?? MAX_DIAGNOSTIC_EVENTS_DEFAULT;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > MAX_DIAGNOSTIC_EVENTS_LIMIT) {
    throw new TypeError(`maxEvents must be an integer from 1 through ${MAX_DIAGNOSTIC_EVENTS_LIMIT}.`);
  }
  const now = options.now ?? Date.now;
  let sequence = 0;
  const events = [];
  function record(type, fields = {}) {
    const typeFailure = validateDiagnosticType(type);
    if (typeFailure) return typeFailure;
    const targetFailure = validateDiagnosticTarget(fields.target);
    if (targetFailure) return targetFailure;
    const codeFailure = validateDiagnosticCode(fields.code);
    if (codeFailure) return codeFailure;
    const detailFailure = validateDiagnosticDetail(fields.detail);
    if (detailFailure) return detailFailure;
    sequence += 1;
    const event = {
      sequence,
      type,
      target: fields.target,
      ...(fields.code === undefined ? {} : { code: fields.code }),
      ...(fields.detail === undefined ? {} : { detail: fields.detail }),
      at: new Date(now()).toISOString(),
    };
    events.push(event);
    while (events.length > maxEvents) events.shift();
    return { ok: true, event: { ...event } };
  }
  function list() {
    return { ok: true, events: events.map((event) => ({ ...event })), dropped: sequence - events.length, maxEvents };
  }
  function clear() {
    events.length = 0;
    return { ok: true, dropped: sequence, maxEvents };
  }
  return { record, list, clear, maxEvents };
}
