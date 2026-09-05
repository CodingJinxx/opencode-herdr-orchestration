import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readmeText() {
  return readFileSync(resolve("README.md"), "utf8");
}

function troubleshootingSection() {
  const readme = readmeText();
  const start = readme.indexOf("## Troubleshooting");
  assert.ok(start >= 0, "README must contain ## Troubleshooting");
  const end = readme.indexOf("## Recovery", start);
  assert.ok(end > start, "Troubleshooting must end before ## Recovery");
  return readme.slice(start, end);
}

test("19-M1 Troubleshooting section sits after Upgrade before Recovery", () => {
  const readme = readmeText();
  assert.match(readme, /## Troubleshooting/);
  const upgrade = readme.indexOf("## Upgrade");
  const troubleshooting = readme.indexOf("## Troubleshooting");
  const recovery = readme.indexOf("## Recovery");
  assert.ok(upgrade >= 0, "Upgrade section must exist");
  assert.ok(troubleshooting > upgrade, "Troubleshooting must sit after Upgrade");
  assert.ok(recovery > troubleshooting, "Troubleshooting must sit before Recovery");
});

test("19-M1 both cases carry Symptom plus Cause plus Check plus Fix plus Verify", () => {
  const section = troubleshootingSection();
  assert.match(section, /Missing Herdr OpenCode integration/);
  assert.match(section, /Windows exe versus shim launcher resolution/);
  const first = section.indexOf("Missing Herdr OpenCode integration");
  const second = section.indexOf("Windows exe versus shim launcher resolution");
  assert.ok(first >= 0 && second > first, "cases must appear in order");
  const firstCase = section.slice(first, second);
  const secondCase = section.slice(second);
  for (const label of ["Symptom:", "Cause:", "Check:", "Fix:", "Verify:"]) {
    assert.ok(firstCase.includes(label), `integration case must contain ${label}`);
    assert.ok(secondCase.includes(label), `launcher case must contain ${label}`);
  }
});

test("19-M1 Troubleshooting pins live versions verbatim", () => {
  const readme = readmeText();
  assert.match(readme, /herdr 0\.8\.2/);
  assert.match(readme, /1\.18\.29/);
  assert.match(readme, /opencode: current \(v10\)/);
  assert.match(readme, /stable/);
  assert.match(readme, /0\.2\.1/);
  const section = troubleshootingSection();
  assert.match(section, /herdr 0\.8\.2/);
  assert.match(section, /1\.18\.29/);
  assert.match(section, /opencode: current \(v10\)/);
  assert.match(section, /opencode: not installed/);
  assert.match(section, /\(Get-Command herdr\)\.Source/);
  assert.match(section, /\(Get-Command opencode\)\.Source/);
  assert.match(section, /\(Get-Command opencode -All\)\.Source/);
  assert.match(section, /\(Get-Command herdr -All\)\.Source/);
  assert.match(section, /\$env:PATH/);
  assert.match(section, /opencode agent list/);
  assert.match(section, /opencode debug agent shepherd/);
  assert.match(section, /node bin\/orchestration\.js status/);
  assert.match(section, /npm view opencode-herdr-orchestration version/);
  assert.match(section, /herdr channel show/);
  assert.match(section, /herdr update --help/);
  assert.match(section, /herdr integration status/);
  assert.match(section, /herdr integration install --help/);
});

test("19-M1 Troubleshooting links lineage with resolving anchors", () => {
  const readme = readmeText();
  const section = troubleshootingSection();
  assert.match(section, /\[Installation\]\(#installation\)/);
  assert.match(section, /\[Upgrade\]\(#upgrade\)/);
  assert.match(section, /\[Recovery\]\(#recovery\)/);
  for (const header of ["## Installation", "## Upgrade", "## Recovery"]) {
    assert.ok(readme.includes(header), `${header} anchor must resolve`);
  }
  const refs = [...section.matchAll(/src\/installer\.js:(\d+)/g)];
  assert.ok(refs.length >= 3, "docs carry resolving file refs");
  const expectedTokens = {
    "src/installer.js:40": "configDirectory",
    "src/installer.js:529": "OPENCODE_DISABLE_PROJECT_CONFIG",
    "src/installer.js:552": "status",
  };
  for (const [file, token] of Object.entries(expectedTokens)) {
    assert.ok(section.includes(file), `${file} referenced`);
    const lineNumber = Number(file.split(":")[1]);
    const lines = readFileSync(resolve(file.split(":")[0]), "utf8").split("\n");
    assert.ok(lineNumber >= 1 && lineNumber <= lines.length, `${file} resolves`);
    const window = lines.slice(Math.max(0, lineNumber - 2), lineNumber + 1).join("\n");
    assert.match(window, new RegExp(token), `${file} points at ${token}`);
  }
});

test("19-M1 Troubleshooting links without duplicating full procedures", () => {
  const section = troubleshootingSection();
  assert.doesNotMatch(section, /npx -y opencode-herdr-orchestration@latest install/);
  assert.doesNotMatch(section, /npx -y opencode-herdr-orchestration@latest update/);
  assert.match(section, /instead of duplicating them here/);
  assert.match(section, /instead of inventing new install spellings/);
  assert.match(section, /instead of launcher reordering/);
});

test("19-M1 Troubleshooting carries no global env overwriting instructions", () => {
  const section = troubleshootingSection();
  assert.doesNotMatch(section, /setx/i);
  assert.doesNotMatch(section, /SetEnvironmentVariable/);
  assert.doesNotMatch(section, /\$env:PATH\s*=/);
  assert.doesNotMatch(section, /export PATH/);
  assert.match(section, /never overwrites the global environment/);
  assert.match(section, /never sets global environment values/);
  assert.match(section, /session-local/);
});
