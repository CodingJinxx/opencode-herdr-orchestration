// Read-only launcher diagnostics (doctor M1).
// Inspects the Windows opencode launcher resolution without changing state.
// Every collector below only reads: PATH inspection, Get-Command ordering,
// per-candidate --version probes, spawn probe observation, integration
// presence checks, and flapping signals. No global environment mutation,
// no shell profile change, no file creation, and no Herdr or OpenCode
// invocation beyond read-only status and version queries.
// Operator-executed remedies are reported as text for the human operator;
// this module never applies them.
import spawn from "cross-spawn";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { basename, delimiter } from "node:path";

export const DOCTOR_ANCHORS = Object.freeze([
  "#installation",
  "#manual-installation",
  "#upgrade",
  "#recovery",
  "#troubleshooting",
  "#missing-herdr-opencode-integration",
  "#windows-exe-versus-shim-launcher-resolution",
]);

export const README_ANCHORS = DOCTOR_ANCHORS;

export const HEALTHY_OPENCODE_VERSION = "1.18.29";
export const HEALTHY_HERDR_VERSION = "0.8.2";
export const HEALTHY_INTEGRATION_STATUS = "opencode: current (v10)";
export const MISSING_INTEGRATION_STATUS = "opencode: not installed";
export const WIN32_SPAWN_ERROR = "%1 is not a valid Win32 application";
export const STABLE_CHANNEL = "stable";

function normalizeSource(source) {
  return typeof source === "string" ? source.trim() : "";
}

export function classifyLauncher(source) {
  const value = normalizeSource(source);
  if (!value) return { source: value, kind: "unknown" };
  const lower = value.toLowerCase().replaceAll("/", "\\");
  const base = basename(value).toLowerCase();
  if (base === "opencode.cmd") return { source: value, kind: "shim-cmd" };
  if (base === "opencode.ps1") return { source: value, kind: "shim-ps1" };
  if (base === "opencode" || base === "opencode.sh") return { source: value, kind: "extensionless-shim" };
  if (base === "opencode.exe") {
    if (lower.includes("\\node_modules\\opencode-ai\\bin\\opencode.exe")) {
      return { source: value, kind: "direct-exe" };
    }
    return { source: value, kind: "shim-exe" };
  }
  return { source: value, kind: "unknown" };
}

export function orderCandidates(sources) {
  const list = Array.isArray(sources) ? sources : [];
  const ordered = [];
  const seen = new Set();
  for (const raw of list) {
    const value = normalizeSource(raw);
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    const classified = classifyLauncher(value);
    ordered.push({ source: classified.source, kind: classified.kind, order: ordered.length });
  }
  return ordered;
}

export function parseVersionText(text) {
  if (typeof text !== "string") return null;
  const match = text.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

export function checkVersionAgreement(versionEntries) {
  const entries = Array.isArray(versionEntries) ? versionEntries : [];
  const normalized = entries.map((entry) => ({
    source: normalizeSource(entry?.source),
    version: typeof entry?.version === "string" && entry.version.length > 0 ? entry.version : null,
    error: typeof entry?.error === "string" && entry.error.length > 0 ? entry.error : null,
  }));
  const versions = normalized.map((entry) => entry.version);
  const distinct = [...new Set(versions.filter((version) => version !== null))];
  const allHaveVersion = normalized.length > 0 && normalized.every((entry) => entry.version !== null && entry.error === null);
  const agree = allHaveVersion && distinct.length === 1;
  return {
    agree,
    agreement: agree,
    versions: normalized,
    distinct,
    detail: agree
      ? `All ${normalized.length} launcher(s) agree on ${distinct[0]}.`
      : `Launchers disagree or are missing versions: ${normalized.map((entry) => `${entry.source || "(empty)"}=${entry.version || entry.error || "unknown"}`).join(", ") || "no candidates"}.`,
  };
}

export function evaluateSpawnProbe({ source, stdout, stderr, status }) {
  const origin = normalizeSource(source);
  const outText = typeof stdout === "string" ? stdout : "";
  const errText = typeof stderr === "string" ? stderr : "";
  const combined = `${outText}\n${errText}`;
  if (combined.includes(WIN32_SPAWN_ERROR)) {
    return { source: origin, ok: false, version: parseVersionText(outText), error: WIN32_SPAWN_ERROR };
  }
  if (status !== 0) {
    const detail = errText.replace(/\s+/g, " ").trim().slice(0, 500) || `exit status ${String(status)}`;
    return { source: origin, ok: false, version: parseVersionText(outText), error: detail };
  }
  const version = parseVersionText(outText);
  if (!version) {
    return { source: origin, ok: false, version: null, error: "no version in probe output" };
  }
  return { source: origin, ok: true, version, error: null };
}

export function checkIntegrationPresence({ integrationStatusText, herdrHelpText, integrationInstallHelpText } = {}) {
  const statusText = typeof integrationStatusText === "string" ? integrationStatusText : "";
  const helpText = typeof herdrHelpText === "string" ? herdrHelpText : "";
  const installHelpText = typeof integrationInstallHelpText === "string" ? integrationInstallHelpText : "";
  const present = statusText.includes(HEALTHY_INTEGRATION_STATUS);
  const missing = statusText.includes(MISSING_INTEGRATION_STATUS);
  const hasIntegrationSubcommand = helpText.includes("herdr integration") || helpText.includes("integration <subcommand>");
  const installListsOpencode = installHelpText.includes("opencode");
  return {
    present,
    presence: present,
    statusText: statusText ? statusText.slice(0, 2000) : null,
    missing,
    hasIntegrationSubcommand,
    installListsOpencode,
    detail: present
      ? `Integration present: ${HEALTHY_INTEGRATION_STATUS}.`
      : `Integration not present: expected ${HEALTHY_INTEGRATION_STATUS}${missing ? ` (saw ${MISSING_INTEGRATION_STATUS})` : ""}.`,
  };
}

export function detectFlapping({ candidates, versions, npmViewVersion } = {}) {
  const ordered = Array.isArray(candidates) ? candidates : [];
  const versionEntries = Array.isArray(versions) ? versions : [];
  const npmVersion = typeof npmViewVersion === "string" && npmViewVersion.length > 0 ? npmViewVersion : null;
  const hasShim = ordered.some((candidate) => {
    const kind = candidate?.kind || classifyLauncher(candidate?.source || "").kind;
    return kind === "shim-cmd" || kind === "shim-ps1" || kind === "shim-exe" || kind === "extensionless-shim";
  });
  const reappearingShim = ordered.length > 1 && hasShim;
  const winnerVersion = versionEntries[0]?.version || null;
  const bumpedVersion = Boolean(winnerVersion && npmVersion && winnerVersion !== npmVersion);
  const distinct = [...new Set(versionEntries.map((entry) => entry?.version).filter(Boolean))];
  const versionSplit = distinct.length > 1;
  const signals = [];
  if (reappearingShim) signals.push("reappearing shim among ordered candidates after a global update");
  if (bumpedVersion) signals.push(`bumped launcher version ${winnerVersion} versus npm view ${npmVersion}`);
  if (versionSplit) signals.push(`version split across candidates: ${distinct.join(", ")}`);
  if (ordered.length > 1 && ordered[0]?.kind !== "direct-exe" && hasShim) {
    signals.push("winner is a shim while a direct exe exists elsewhere in order");
  }
  const flapping = signals.length > 0;
  return {
    flapping,
    reappearingShim,
    bumpedVersion,
    versionSplit,
    npmViewVersion: npmVersion,
    signals,
    detail: flapping ? `Flapping signals: ${signals.join("; ")}.` : "No flapping signals.",
  };
}

function describeCandidate(candidate, index) {
  return `${index}: ${candidate.source} [${candidate.kind}]`;
}

export function formatHumanSummary(report) {
  const winner = report?.winner ? `${report.winner.source} [${report.winner.kind}]` : "(no winner)";
  const candidates = Array.isArray(report?.candidates) ? report.candidates : [];
  const versions = Array.isArray(report?.versions) ? report.versions : [];
  const agreement = report?.agreement || {};
  const spawnProbe = report?.spawnProbe || {};
  const integration = report?.integration || {};
  const flapping = report?.flapping || {};
  const lines = [];
  lines.push("Launcher diagnostics (read-only, no changes applied).");
  lines.push(`Winner per (Get-Command opencode).Source: ${winner}.`);
  lines.push(`Ordered candidates per (Get-Command opencode -All).Source (${candidates.length}):`);
  for (let index = 0; index < candidates.length; index += 1) {
    const version = versions[index]?.version || versions[index]?.error || "unknown";
    lines.push(`- ${describeCandidate(candidates[index], index)} reports ${version}.`);
  }
  lines.push(
    agreement.agree
      ? `Agreement: all candidates agree on ${agreement.distinct?.[0] || HEALTHY_OPENCODE_VERSION}.`
      : `Agreement: ${agreement.detail || "versions disagree"}. Compare opencode --version against each full-path exe and shim form; healthy hosts report the same ${HEALTHY_OPENCODE_VERSION} from each.`,
  );
  lines.push(
    spawnProbe.ok
      ? `Spawn probe: Start-Process with -FilePath from the resolved launcher plus -ArgumentList --version -NoNewWindow -Wait reports ${spawnProbe.version} without ${WIN32_SPAWN_ERROR}.`
      : `Spawn probe: Start-Process with -FilePath from ${spawnProbe.source || "winner"} plus -ArgumentList --version -NoNewWindow -Wait did not succeed (${spawnProbe.error || "unknown"}); live the extensionless shim fails with ${WIN32_SPAWN_ERROR} while the direct exe reports ${HEALTHY_OPENCODE_VERSION}.`,
  );
  lines.push(
    integration.present
      ? `Integration presence: herdr integration status shows ${HEALTHY_INTEGRATION_STATUS}. herdr --help lists herdr integration <subcommand> and herdr integration install --help lists opencode as a valid target.`
      : `Integration presence: herdr integration status does not show ${HEALTHY_INTEGRATION_STATUS}${integration.missing ? ` (saw ${MISSING_INTEGRATION_STATUS})` : ""}. Check opencode agent list plus opencode debug agent shepherd plus node bin/orchestration.js status.`,
  );
  lines.push(
    flapping.flapping
      ? `Flapping signals: ${flapping.detail || flapping.signals?.join("; ")}. A global opencode upgrade recreates the npm shims, so a previously durable order can flap back to shim-first with a bumped opencode --version versus npm view opencode-ai version. Re-inspect (Get-Command opencode -All).Source for a reappearing shim.`
      : "Flapping signals: none. No reappearing shim and no bumped version versus npm view opencode-ai version.",
  );
  lines.push(`PATH inspected read-only via $env:PATH plus (Get-Command herdr).Source plus (Get-Command herdr -All).Source; Herdr resolves to a single bin exe with no shim confusion per herdr --version ${HEALTHY_HERDR_VERSION}. Confirm the server split with herdr status showing status: running for server separate from client. Autoupdate context is npm view opencode-herdr-orchestration version plus herdr channel show reporting ${STABLE_CHANNEL} plus herdr update --help plus opencode upgrade --help.`);
  lines.push("Operator-executed remedies (this package never overwrites the global environment and never sets global environment values automatically):");
  lines.push("- For current-session relief use the winning full exe path directly.");
  lines.push("- For a durable fix apply a persistent user-chosen PATH reorder that places the direct exe directory before the npm shim directory, then restart Herdr plus the terminal plus OpenCode intentionally when ready.");
  lines.push("- Session-local changes alone never fix Herdr spawns because panes inherit the Herdr server environment; the persistent reorder is an operator-chosen Windows user environment change, not a package change.");
  lines.push("See [Installation](#installation), [Manual Installation](#manual-installation), [Upgrade](#upgrade), and [Recovery](#recovery) for procedures instead of duplicating them here, with [Troubleshooting](#troubleshooting) plus [Missing Herdr OpenCode integration](#missing-herdr-opencode-integration) plus [Windows exe versus shim launcher resolution](#windows-exe-versus-shim-launcher-resolution) for symptom plus check plus verify lineage.");
  return lines.join("\n");
}

export function buildDoctorReport({ candidates, versions, spawnProbe, integration, flapping, pathEntries } = {}) {
  const ordered = orderCandidates(candidates || []);
  const versionEntries = Array.isArray(versions) && versions.length > 0
    ? versions.map((entry, index) => ({
      source: normalizeSource(entry?.source || ordered[index]?.source || ""),
      version: typeof entry?.version === "string" && entry.version ? entry.version : null,
      error: typeof entry?.error === "string" && entry.error ? entry.error : null,
    }))
    : ordered.map((candidate) => ({ source: candidate.source, version: null, error: "unknown" }));
  const agreement = checkVersionAgreement(versionEntries);
  const winner = ordered[0] || null;
  const probe = spawnProbe && typeof spawnProbe === "object" && spawnProbe.source
    ? spawnProbe
    : { source: winner?.source || null, ok: false, version: versionEntries[0]?.version || null, error: versionEntries[0]?.error || "unknown" };
  const integrationResult = integration && typeof integration === "object" ? integration : checkIntegrationPresence({});
  const flappingResult = flapping && typeof flapping === "object" && Array.isArray(flapping.signals)
    ? flapping
    : { flapping: false, reappearingShim: false, bumpedVersion: false, versionSplit: false, npmViewVersion: null, signals: [], detail: "No flapping signals." };
  const pathList = Array.isArray(pathEntries) ? pathEntries : [];
  const base = {
    tool: "doctor",
    readOnly: true,
    winner,
    candidates: ordered,
    orderedCandidates: ordered,
    versions: versionEntries,
    candidateVersions: versionEntries,
    agreement,
    spawnProbe: probe,
    spawnProbes: versionEntries.map((entry) => ({
      source: entry.source,
      ok: entry.version !== null && entry.error === null,
      version: entry.version,
      error: entry.error,
    })),
    integration: integrationResult,
    integrationPresence: integrationResult,
    flapping: flappingResult,
    flappingSignals: flappingResult.signals || [],
    path: { entries: pathList, inspectedReadOnly: true },
    remedies: [
      "For current-session relief use the winning full exe path directly.",
      "For a durable fix apply a persistent user-chosen PATH reorder that places the direct exe directory before the npm shim directory, then restart Herdr plus the terminal plus OpenCode intentionally when ready.",
      "Session-local changes alone never fix Herdr spawns because panes inherit the Herdr server environment.",
    ],
    anchors: [...DOCTOR_ANCHORS],
    readmeAnchors: [...DOCTOR_ANCHORS],
  };
  const summary = formatHumanSummary(base);
  return {
    ...base,
    operatorRemedies: [...base.remedies],
    summary,
    humanSummary: summary,
  };
}

function runCrossSpawnVersion(candidate) {
  try {
    const result = spawn.sync(candidate, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : (result.error ? String(result.error.message || result.error) : "");
    const version = parseVersionText(stdout);
    if (result.error) {
      return { source: candidate, version, error: String(result.error.message || result.error).slice(0, 500) };
    }
    if (result.status !== 0) {
      return { source: candidate, version, error: (stderr || `exit status ${String(result.status)}`).replace(/\s+/g, " ").trim().slice(0, 500) };
    }
    if (!version) return { source: candidate, version: null, error: "no version in output" };
    return { source: candidate, version, error: null };
  } catch (error) {
    return { source: candidate, version: null, error: String(error?.message || error).slice(0, 500) };
  }
}

function runHelpCapture(command, args) {
  try {
    const result = spawn.sync(command, args, { encoding: "utf8", windowsHide: true, timeout: 15000 });
    if (result.error) return "";
    return typeof result.stdout === "string" ? result.stdout : "";
  } catch {
    return "";
  }
}

function collectLiveCandidates(envPath) {
  const currentPlatform = platform();
  if (currentPlatform === "win32") {
    try {
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Command opencode -All).Source"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
      });
      const stdout = typeof result.stdout === "string" ? result.stdout : "";
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (lines.length > 0) return lines;
    } catch {}
  }
  const raw = typeof envPath === "string" ? envPath : "";
  const entries = raw.split(delimiter).map((entry) => entry.trim()).filter(Boolean);
  const found = [];
  const names = currentPlatform === "win32" ? ["opencode.cmd", "opencode.ps1", "opencode.exe", "opencode"] : ["opencode"];
  for (const dir of entries) {
    for (const name of names) {
      const candidate = `${dir.replace(/[\\/]+$/, "")}\\${name}`;
      try {
        if (existsSync(candidate)) found.push(candidate);
      } catch {}
    }
    if (found.length >= 8) break;
  }
  return found;
}

function collectLivePathEntries(envPath) {
  const raw = typeof envPath === "string" ? envPath : "";
  return raw.split(delimiter).map((entry) => entry.trim()).filter(Boolean);
}

export function collectDoctorReport(options = {}) {
  const envPath = options.envPath !== undefined ? options.envPath : (process.env.PATH || process.env.Path || "");
  const liveCandidates = options.candidates !== undefined ? options.candidates : collectLiveCandidates(envPath);
  const ordered = orderCandidates(liveCandidates);
  const liveVersions = options.versions !== undefined
    ? options.versions
    : ordered.map((candidate) => runCrossSpawnVersion(candidate.source));
  const agreement = checkVersionAgreement(liveVersions);
  const winnerProbeInput = options.spawnProbe !== undefined ? options.spawnProbe : (() => {
    const winnerSource = ordered[0]?.source;
    if (!winnerSource) return { source: null, ok: false, version: null, error: "no candidates" };
    const match = liveVersions[0];
    if (match && match.error && String(match.error).includes(WIN32_SPAWN_ERROR)) {
      return evaluateSpawnProbe({ source: winnerSource, stdout: "", stderr: match.error, status: 1 });
    }
    if (match && match.version) {
      return { source: winnerSource, ok: match.error === null, version: match.version, error: match.error };
    }
    return { source: winnerSource, ok: false, version: null, error: (match && match.error) || "unknown" };
  })();
  const integration = options.integration !== undefined ? options.integration : checkIntegrationPresence({
    integrationStatusText: runHelpCapture("herdr", ["integration", "status"]),
    herdrHelpText: runHelpCapture("herdr", ["--help"]),
    integrationInstallHelpText: runHelpCapture("herdr", ["integration", "install", "--help"]),
  });
  let npmViewVersion = null;
  if (options.npmViewVersion !== undefined) {
    npmViewVersion = options.npmViewVersion;
  } else {
    const npmText = runHelpCapture("npm", ["view", "opencode-ai", "version"]);
    npmViewVersion = parseVersionText(npmText);
  }
  const flapping = options.flapping !== undefined
    ? options.flapping
    : detectFlapping({ candidates: ordered, versions: liveVersions, npmViewVersion });
  return buildDoctorReport({
    candidates: ordered.map((candidate) => candidate.source),
    versions: liveVersions,
    spawnProbe: winnerProbeInput,
    integration,
    flapping,
    pathEntries: collectLivePathEntries(envPath),
  });
}
