import test from "node:test";
import assert from "node:assert/strict";

import {
  HEALTHY_HERDR_VERSION,
  HEALTHY_INTEGRATION_STATUS,
  HEALTHY_OPENCODE_VERSION,
  MISSING_INTEGRATION_STATUS,
  STABLE_CHANNEL,
  WIN32_SPAWN_ERROR,
  buildDoctorReport,
  checkIntegrationPresence,
  classifyLauncher,
  detectFlapping,
  evaluateSpawnProbe,
  formatHumanSummary,
  orderCandidates,
} from "../src/doctor.js";

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

test("19-M1 missing integration case distinguishes healthy versus missing via source", () => {
  const healthy = checkIntegrationPresence({ integrationStatusText: HEALTHY_INTEGRATION_STATUS });
  assert.equal(healthy.present, true);
  const missing = checkIntegrationPresence({ integrationStatusText: MISSING_INTEGRATION_STATUS });
  assert.equal(missing.present, false);
  assert.equal(missing.missing, true);
});

test("19-M1 launcher resolution case exposes shim-first flap with bumped version via source", () => {
  assert.equal(classifyLauncher(HOSTILE_QUARTET[0]).kind, "shim-cmd");
  assert.equal(classifyLauncher(HOSTILE_QUARTET[1]).kind, "direct-exe");
  assert.equal(classifyLauncher(HOSTILE_QUARTET[2]).kind, "shim-ps1");
  assert.equal(classifyLauncher(HOSTILE_QUARTET[3]).kind, "extensionless-shim");
  const ordered = orderCandidates(HOSTILE_QUARTET);
  const flapping = detectFlapping({ candidates: ordered, versions: HOSTILE_VERSIONS, npmViewVersion: HEALTHY_OPENCODE_VERSION });
  assert.equal(flapping.reappearingShim, true);
  assert.equal(flapping.bumpedVersion, true);
  assert.equal(flapping.flapping, true);
  const probe = evaluateSpawnProbe({ source: HOSTILE_QUARTET[3], stdout: "", stderr: WIN32_SPAWN_ERROR, status: 1 });
  assert.equal(probe.ok, false);
  assert.equal(probe.error, WIN32_SPAWN_ERROR);
});

test("19-M1 live versions pinned via source constants", () => {
  assert.equal(HEALTHY_HERDR_VERSION, "0.8.2");
  assert.equal(HEALTHY_OPENCODE_VERSION, "1.18.29");
  assert.equal(HEALTHY_INTEGRATION_STATUS, "opencode: current (v10)");
  assert.equal(MISSING_INTEGRATION_STATUS, "opencode: not installed");
  assert.equal(STABLE_CHANNEL, "stable");
  assert.equal(WIN32_SPAWN_ERROR, "%1 is not a valid Win32 application");
});

test("19-M1 operator remedies carry durable plus session-local split via report", () => {
  const ordered = orderCandidates(HOSTILE_QUARTET);
  const report = buildDoctorReport({
    candidates: HOSTILE_QUARTET,
    versions: HOSTILE_VERSIONS,
    spawnProbe: evaluateSpawnProbe({ source: HOSTILE_QUARTET[3], stdout: "", stderr: WIN32_SPAWN_ERROR, status: 1 }),
    integration: checkIntegrationPresence({ integrationStatusText: MISSING_INTEGRATION_STATUS }),
    flapping: detectFlapping({ candidates: ordered, versions: HOSTILE_VERSIONS, npmViewVersion: HEALTHY_OPENCODE_VERSION }),
    pathEntries: ["C:\\npm-prefix"],
  });
  const summary = formatHumanSummary(report);
  for (const fragment of [
    "operator-chosen",
    "persistent user-chosen",
    "restart Herdr",
    "Session-local changes alone never fix Herdr spawns",
    "panes inherit the Herdr server environment",
    "never overwrites the global environment",
    "never sets global environment values",
    "reappearing shim",
    "bumped",
  ]) {
    assert.ok(summary.includes(fragment), `report summary must contain ${fragment}`);
  }
  assert.ok(Array.isArray(report.remedies) && report.remedies.length >= 2);
  assert.ok(Array.isArray(report.operatorRemedies) && report.operatorRemedies.length >= 2);
});
