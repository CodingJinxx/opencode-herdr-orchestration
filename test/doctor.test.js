import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  DOCTOR_ANCHORS,
  HEALTHY_OPENCODE_VERSION,
  WIN32_SPAWN_ERROR,
  buildDoctorReport,
  checkIntegrationPresence,
  checkVersionAgreement,
  classifyLauncher,
  collectDoctorReport,
  detectFlapping,
  evaluateSpawnProbe,
  formatHumanSummary,
  orderCandidates,
} from "../src/doctor.js";
import { status as installationStatus } from "../src/installer.js";

const cli = resolve("bin/orchestration.js");

function readmeText() {
  return readFileSync(resolve("README.md"), "utf8");
}

function doctorSource() {
  return readFileSync(resolve("src/doctor.js"), "utf8");
}

function binSource() {
  return readFileSync(resolve("bin/orchestration.js"), "utf8");
}

// Hostile quartet: shim-first order with a bumped shim version and an
// extensionless probe failure, mirroring live Troubleshooting evidence.
const HOSTILE_QUARTET = [
  "C:\\npm-prefix\\opencode.cmd",
  "C:\\Users\\op\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe",
  "C:\\npm-prefix\\opencode.ps1",
  "C:\\npm-prefix\\opencode",
];

const HOSTILE_VERSIONS = [
  { source: HOSTILE_QUARTET[0], version: "1.19.0", error: null },
  { source: HOSTILE_QUARTET[1], version: "1.18.29", error: null },
  { source: HOSTILE_QUARTET[2], version: "1.18.29", error: null },
  { source: HOSTILE_QUARTET[3], version: null, error: WIN32_SPAWN_ERROR },
];

test("doctor ordering preserves PATH order with winner first", () => {
  const ordered = orderCandidates(HOSTILE_QUARTET);
  assert.equal(ordered.length, 4);
  assert.deepEqual(ordered.map((entry) => entry.source), HOSTILE_QUARTET);
  assert.deepEqual(ordered.map((entry) => entry.order), [0, 1, 2, 3]);
  assert.equal(ordered[0].source, HOSTILE_QUARTET[0]);
  // Winner is the first candidate in resolver order.
  const report = buildDoctorReport({
    candidates: HOSTILE_QUARTET,
    versions: HOSTILE_VERSIONS.slice(0, 3).concat([{ source: HOSTILE_QUARTET[3], version: "1.18.29", error: null }]),
    spawnProbe: { source: HOSTILE_QUARTET[0], ok: true, version: "1.19.0", error: null },
    integration: checkIntegrationPresence({ integrationStatusText: "opencode: current (v10)" }),
    flapping: detectFlapping({ candidates: orderCandidates(HOSTILE_QUARTET), versions: HOSTILE_VERSIONS, npmViewVersion: "1.18.29" }),
    pathEntries: ["C:\\npm-prefix", "C:\\other"],
  });
  assert.equal(report.winner.source, HOSTILE_QUARTET[0]);
  assert.deepEqual(report.candidates.map((entry) => entry.source), HOSTILE_QUARTET);
  assert.deepEqual(report.orderedCandidates.map((entry) => entry.source), HOSTILE_QUARTET);
});

test("doctor agreement detects unanimous versus split versions", () => {
  const unanimous = checkVersionAgreement([
    { source: "a", version: "1.18.29", error: null },
    { source: "b", version: "1.18.29", error: null },
  ]);
  assert.equal(unanimous.agree, true);
  assert.equal(unanimous.agreement, true);
  assert.deepEqual(unanimous.distinct, ["1.18.29"]);

  const split = checkVersionAgreement(HOSTILE_VERSIONS.slice(0, 2));
  assert.equal(split.agree, false);
  assert.deepEqual(split.distinct.sort(), ["1.18.29", "1.19.0"]);

  const missing = checkVersionAgreement(HOSTILE_VERSIONS);
  assert.equal(missing.agree, false);

  const single = checkVersionAgreement([{ source: "only", version: "1.18.29", error: null }]);
  assert.equal(single.agree, true);
});

test("doctor hostile quartet fixture exposes shim-first flap with bumped version", () => {
  const ordered = orderCandidates(HOSTILE_QUARTET);
  assert.equal(classifyLauncher(HOSTILE_QUARTET[0]).kind, "shim-cmd");
  assert.equal(classifyLauncher(HOSTILE_QUARTET[1]).kind, "direct-exe");
  assert.equal(classifyLauncher(HOSTILE_QUARTET[2]).kind, "shim-ps1");
  assert.equal(classifyLauncher(HOSTILE_QUARTET[3]).kind, "extensionless-shim");

  const agreement = checkVersionAgreement(HOSTILE_VERSIONS.slice(0, 3));
  assert.equal(agreement.agree, false);

  const flapping = detectFlapping({ candidates: ordered, versions: HOSTILE_VERSIONS, npmViewVersion: "1.18.29" });
  assert.equal(flapping.reappearingShim, true);
  assert.equal(flapping.bumpedVersion, true);
  assert.equal(flapping.flapping, true);
  assert.ok(flapping.signals.join(" ").includes("reappearing shim"));
  assert.ok(flapping.signals.join(" ").includes("bumped"));

  const directProbe = evaluateSpawnProbe({ source: HOSTILE_QUARTET[1], stdout: "opencode 1.18.29", stderr: "", status: 0 });
  assert.equal(directProbe.ok, true);
  assert.equal(directProbe.version, "1.18.29");

  const shimProbe = evaluateSpawnProbe({ source: HOSTILE_QUARTET[3], stdout: "", stderr: WIN32_SPAWN_ERROR, status: 1 });
  assert.equal(shimProbe.ok, false);
  assert.equal(shimProbe.error, WIN32_SPAWN_ERROR);

  const report = buildDoctorReport({
    candidates: HOSTILE_QUARTET,
    versions: HOSTILE_VERSIONS,
    spawnProbe: shimProbe,
    integration: checkIntegrationPresence({ integrationStatusText: "opencode: not installed" }),
    flapping,
    pathEntries: ["C:\\npm-prefix"],
  });
  assert.equal(report.winner.source, HOSTILE_QUARTET[0]);
  assert.equal(report.candidates.length, 4);
  assert.equal(report.versions.length, 4);
  assert.equal(report.candidateVersions.length, 4);
  assert.equal(report.agreement.agree, false);
  assert.equal(report.flapping.flapping, true);
  assert.ok(report.summary.includes(WIN32_SPAWN_ERROR));
  assert.ok(report.humanSummary.includes(WIN32_SPAWN_ERROR));
});

test("doctor flapping signals reappearing shim plus bumped version versus npm view", () => {
  const single = orderCandidates([HOSTILE_QUARTET[1]]);
  const calm = detectFlapping({
    candidates: single,
    versions: [{ source: HOSTILE_QUARTET[1], version: "1.18.29", error: null }],
    npmViewVersion: "1.18.29",
  });
  assert.equal(calm.flapping, false);
  assert.equal(calm.reappearingShim, false);
  assert.equal(calm.bumpedVersion, false);

  const ordered = orderCandidates(HOSTILE_QUARTET);
  const flapped = detectFlapping({ candidates: ordered, versions: HOSTILE_VERSIONS, npmViewVersion: "1.18.29" });
  assert.equal(flapped.flapping, true);
  assert.equal(flapped.bumpedVersion, true);
  assert.ok(flapped.detail.includes("bumped"));
});

test("doctor integration presence distinguishes healthy versus missing", () => {
  const healthy = checkIntegrationPresence({
    integrationStatusText: "herdr integration: opencode: current (v10)",
    herdrHelpText: "herdr integration <subcommand>",
    integrationInstallHelpText: "install opencode target",
  });
  assert.equal(healthy.present, true);
  assert.equal(healthy.presence, true);
  assert.equal(healthy.hasIntegrationSubcommand, true);
  assert.equal(healthy.installListsOpencode, true);

  const missing = checkIntegrationPresence({
    integrationStatusText: "herdr integration: opencode: not installed",
    herdrHelpText: "herdr integration <subcommand>",
    integrationInstallHelpText: "install opencode target",
  });
  assert.equal(missing.present, false);
  assert.equal(missing.missing, true);

  const report = buildDoctorReport({
    candidates: [HOSTILE_QUARTET[1]],
    versions: [{ source: HOSTILE_QUARTET[1], version: "1.18.29", error: null }],
    spawnProbe: { source: HOSTILE_QUARTET[1], ok: true, version: "1.18.29", error: null },
    integration: healthy,
    flapping: detectFlapping({
      candidates: orderCandidates([HOSTILE_QUARTET[1]]),
      versions: [{ source: HOSTILE_QUARTET[1], version: "1.18.29", error: null }],
      npmViewVersion: "1.18.29",
    }),
    pathEntries: [],
  });
  assert.equal(report.integration.present, true);
  assert.equal(report.integrationPresence.present, true);
});

test("doctor zero-write confinement uses only allowed deps with no writes", () => {
  const source = doctorSource();
  assert.doesNotMatch(source, /writeFileSync/);
  assert.doesNotMatch(source, /mkdirSync/);
  assert.doesNotMatch(source, /copyFileSync/);
  assert.doesNotMatch(source, /rmSync/);
  assert.doesNotMatch(source, /chmodSync/);
  assert.doesNotMatch(source, /renameSync/);
  assert.doesNotMatch(source, /unlinkSync/);
  assert.doesNotMatch(source, /appendFileSync/);
  assert.doesNotMatch(source, /createWriteStream/);
  assert.doesNotMatch(source, /writePluginConfig/);
  assert.doesNotMatch(source, /writeSteerCommand/);
  assert.doesNotMatch(source, /writeAgentFilesManifest/);
  assert.doesNotMatch(source, /SetEnvironmentVariable/);
  assert.doesNotMatch(source, /export PATH/);
  assert.doesNotMatch(source, /\$env:PATH\s*=/);
  assert.doesNotMatch(source, /process\.env\.PATH\s*=/);
  assert.doesNotMatch(source, /process\.env\.Path\s*=/);
  assert.match(source, /\$env:PATH/);
  // No setx anywhere (case-insensitive).
  assert.equal(/setx/i.test(source), false);

  const imports = [...source.matchAll(/^\s*import\s+[^;]+?from\s+["']([^"']+)["']/gm)].map((match) => match[1]);
  const allowed = new Set(["cross-spawn", "node:child_process", "node:fs", "node:os", "node:path"]);
  assert.ok(imports.length >= 4, "doctor imports the allowed read-only surface");
  for (const specifier of imports) {
    assert.ok(allowed.has(specifier), `doctor import ${specifier} must stay within cross-spawn plus child_process plus fs plus os plus path`);
  }

  // Pure report construction performs no filesystem writes: OS temp area stays untouched.
  const probeDir = mkdtempSync(join(tmpdir(), "doctor-confinement-"));
  const before = readdirSync(probeDir);
  const report = buildDoctorReport({
    candidates: HOSTILE_QUARTET.slice(1, 2),
    versions: [{ source: HOSTILE_QUARTET[1], version: "1.18.29", error: null }],
    spawnProbe: { source: HOSTILE_QUARTET[1], ok: true, version: "1.18.29", error: null },
    integration: checkIntegrationPresence({ integrationStatusText: "opencode: current (v10)" }),
    flapping: detectFlapping({
      candidates: orderCandidates(HOSTILE_QUARTET.slice(1, 2)),
      versions: [{ source: HOSTILE_QUARTET[1], version: "1.18.29", error: null }],
      npmViewVersion: "1.18.29",
    }),
    pathEntries: [probeDir],
  });
  assert.equal(report.readOnly, true);
  assert.deepEqual(readdirSync(probeDir), before);

  // Live injected collection also writes nothing.
  const live = collectDoctorReport({
    candidates: HOSTILE_QUARTET.slice(1, 2),
    versions: [{ source: HOSTILE_QUARTET[1], version: "1.18.29", error: null }],
    spawnProbe: { source: HOSTILE_QUARTET[1], ok: true, version: "1.18.29", error: null },
    integration: checkIntegrationPresence({ integrationStatusText: "opencode: current (v10)" }),
    flapping: detectFlapping({
      candidates: orderCandidates(HOSTILE_QUARTET.slice(1, 2)),
      versions: [{ source: HOSTILE_QUARTET[1], version: "1.18.29", error: null }],
      npmViewVersion: "1.18.29",
    }),
    envPath: probeDir,
  });
  assert.equal(live.readOnly, true);
  assert.deepEqual(readdirSync(probeDir), before);
});

test("doctor README pointer carries exact anchors without duplicating procedures", () => {
  const readme = readmeText();
  assert.match(readme, /node bin\/orchestration\.js doctor/);
  const pointerIndex = readme.indexOf("node bin/orchestration.js doctor");
  assert.ok(pointerIndex >= 0, "pointer must mention the doctor command");
  const pointer = readme.slice(Math.max(0, pointerIndex - 800), pointerIndex + 1200);
  for (const anchor of DOCTOR_ANCHORS) {
    assert.ok(pointer.includes(`(${anchor})`), `pointer must link ${anchor}`);
  }
  assert.match(pointer, /\[Installation\]\(#installation\)/);
  assert.match(pointer, /\[Manual Installation\]\(#manual-installation\)/);
  assert.match(pointer, /\[Upgrade\]\(#upgrade\)/);
  assert.match(pointer, /\[Recovery\]\(#recovery\)/);
  assert.match(pointer, /\[Troubleshooting\]\(#troubleshooting\)/);
  assert.match(pointer, /\[Missing Herdr OpenCode integration\]\(#missing-herdr-opencode-integration\)/);
  assert.match(pointer, /\[Windows exe versus shim launcher resolution\]\(#windows-exe-versus-shim-launcher-resolution\)/);
  for (const header of [
    "## Installation",
    "## Manual Installation",
    "## Upgrade",
    "## Troubleshooting",
    "### Missing Herdr OpenCode integration",
    "### Windows exe versus shim launcher resolution",
    "## Recovery",
  ]) {
    assert.ok(readme.includes(header), `${header} anchor must resolve`);
  }
  assert.match(pointer, /instead of duplicating them here/);
  assert.doesNotMatch(pointer, /npx -y opencode-herdr-orchestration@latest install/);
  assert.doesNotMatch(pointer, /npx -y opencode-herdr-orchestration@latest update/);
  assert.equal(/setx/i.test(pointer), false);
});

test("doctor bin dispatch keeps status shape untouched with doctor plus usage plus exit codes", () => {
  const bin = binSource();
  assert.match(bin, /collectDoctorReport/);
  assert.match(bin, /\.\.\/src\/doctor\.js/);
  assert.match(bin, /command === "doctor"/);
  assert.match(bin, /status\|doctor\|uninstall/);
  assert.match(bin, /function runDoctor/);
  // Status shape stays the single spread plus hooks line.
  assert.match(bin, /\{\s*\.\.\.installationStatus\(configDirectory\(\), packageRoot\), hooks:/);

  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  assert.deepEqual(pkg.files, ["bin", "hooks", "src", "README.md", "LICENSE"]);
  assert.match(pkg.scripts.check, /node --check src\/doctor\.js/);
  assert.match(pkg.scripts.check, /node --check bin\/orchestration\.js/);

  // Existing status keys stay intact via the installer export.
  const probeDir = mkdtempSync(join(tmpdir(), "doctor-status-"));
  const result = installationStatus(probeDir, resolve("."));
  assert.deepEqual(Object.keys(result).sort(), [
    "agentsReady",
    "cliVersion",
    "configFile",
    "detectedAgents",
    "installedVersion",
    "latestVersion",
    "latestVersionError",
    "obsoleteAgentFiles",
    "package",
    "pluginConfigured",
    "steerCommandConfigured",
    "updateAvailable",
  ]);

  const unknown = spawnSync(process.execPath, [cli, "does-not-exist"], { encoding: "utf8", windowsHide: true });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Usage:/);
  assert.match(unknown.stderr, /doctor/);

  const doctor = spawnSync(process.execPath, [cli, "doctor"], { encoding: "utf8", windowsHide: true });
  assert.equal(doctor.status, 0, doctor.stderr);
  const parsed = JSON.parse(doctor.stdout);
  for (const key of ["winner", "candidates", "orderedCandidates", "versions", "candidateVersions", "agreement", "spawnProbe", "integration", "flapping", "summary", "humanSummary", "remedies", "anchors"]) {
    assert.ok(key in parsed, `doctor JSON must carry ${key}`);
  }
});

test("doctor report carries JSON plus human summary with operator remedies and README anchors", () => {
  const ordered = orderCandidates(HOSTILE_QUARTET);
  const report = buildDoctorReport({
    candidates: HOSTILE_QUARTET,
    versions: HOSTILE_VERSIONS,
    spawnProbe: evaluateSpawnProbe({ source: HOSTILE_QUARTET[3], stdout: "", stderr: WIN32_SPAWN_ERROR, status: 1 }),
    integration: checkIntegrationPresence({
      integrationStatusText: "opencode: not installed",
      herdrHelpText: "herdr integration <subcommand>",
      integrationInstallHelpText: "install opencode",
    }),
    flapping: detectFlapping({ candidates: ordered, versions: HOSTILE_VERSIONS, npmViewVersion: "1.18.29" }),
    pathEntries: ["C:\\npm-prefix"],
  });
  assert.equal(report.tool, "doctor");
  assert.equal(report.readOnly, true);
  assert.ok(Array.isArray(report.remedies) && report.remedies.length >= 2);
  assert.ok(Array.isArray(report.operatorRemedies) && report.operatorRemedies.length >= 2);
  assert.deepEqual(report.anchors, [...DOCTOR_ANCHORS]);
  const summary = formatHumanSummary(report);
  assert.equal(report.summary, summary);
  for (const fragment of [
    "(Get-Command opencode).Source",
    "(Get-Command opencode -All).Source",
    "opencode --version",
    HEALTHY_OPENCODE_VERSION,
    "Start-Process",
    "-ArgumentList --version -NoNewWindow -Wait",
    WIN32_SPAWN_ERROR,
    "opencode: current (v10)",
    "opencode: not installed",
    "npm view opencode-ai version",
    "herdr integration status",
    "herdr channel show",
    "herdr status",
    "opencode agent list",
    "opencode debug agent shepherd",
    "node bin/orchestration.js status",
    "reappearing shim",
    "bumped",
    "operator-chosen",
    "persistent user-chosen",
    "restart Herdr",
    "Session-local changes alone never fix Herdr spawns",
    "panes inherit the Herdr server environment",
    "never overwrites the global environment",
    "never sets global environment values",
    "not a package",
  ]) {
    assert.ok(summary.includes(fragment), `summary must contain ${fragment}`);
  }
  for (const anchor of DOCTOR_ANCHORS) {
    assert.ok(summary.includes(`(${anchor})`), `summary must link ${anchor}`);
  }
});
