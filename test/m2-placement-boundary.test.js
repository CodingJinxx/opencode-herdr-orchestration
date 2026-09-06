import test from "node:test";
import assert from "node:assert/strict";

import {
  PANE_CAP,
  ROLE_TAB_POLICY_PARAGRAPH,
  ROLE_TAB_POLICY_SENTENCES,
  SHEEPDOG_PROMPT,
  SHEPHERD_GOVERNOR_PROMPT,
  SHEPHERD_PROMPT,
  decidePanePlacement,
  governorStartupDestination,
  isDevPane,
  managedPanes,
  managedPanesInTab,
  nextRoleLabel,
  nextRoleTabLabel,
  preCreateDefaultPane,
  roleTabBaseLabel,
  roleTabCapFor,
  roleTabGeometry,
  sheepdogRoleTabDestination,
  sheepdogStartupDestination,
  shepherdStartupDestination,
} from "../src/prompts.js";

function pane({
  pane_id,
  tab_id = "w1K:t1",
  label = "sheep-1",
  terminal_title = label,
  terminal_title_stripped = label,
} = {}) {
  return { pane_id, tab_id, label, terminal_title, terminal_title_stripped };
}

function devPane({ pane_id, tab_id = "w1K:t1", title = "Dev" } = {}) {
  return {
    pane_id,
    tab_id,
    label: title,
    terminal_title: title,
    terminal_title_stripped: title,
  };
}

test("14-18-M2 four-pane boundary reuses first and overflows to new tab when cap binds", () => {
  assert.equal(PANE_CAP, 4);
  const full = [
    pane({ pane_id: "w1K:p1", label: "caller" }),
    pane({ pane_id: "w1K:p2", label: "sheep-1" }),
    pane({ pane_id: "w1K:p3", label: "sheep-2" }),
    pane({ pane_id: "w1K:p4", label: "grazer-1" }),
  ];
  const atCap = decidePanePlacement({ panes: full, tabId: "w1K:t1", reuseCandidateId: "w1K:p2" });
  assert.equal(atCap.action, "overflow-reuse");
  assert.equal(atCap.paneId, "w1K:p2");
  assert.match(atCap.reason, /Reuse first within the four-pane cap per tab/);

  const overWithoutCandidate = decidePanePlacement({ panes: full, tabId: "w1K:t1" });
  assert.equal(overWithoutCandidate.action, "new-tab");
  assert.notEqual(overWithoutCandidate.action, "split");
  assert.match(overWithoutCandidate.reason, /Overflow to a new tab with indexed role labels when the cap binds/);

  const fiveWouldBeClutter = decidePanePlacement({
    panes: [...full, pane({ pane_id: "w1K:p5", label: "sheep-3" })],
    tabId: "w1K:t1",
    reuseCandidateId: "w1K:p3",
  });
  assert.equal(fiveWouldBeClutter.action, "overflow-reuse");
  assert.notEqual(fiveWouldBeClutter.action, "split");
});

test("14-18-M2 reuse is preferred over clutter when capacity remains", () => {
  const panes = [
    pane({ pane_id: "w1K:p1", label: "caller" }),
    pane({ pane_id: "w1K:p2", label: "sheep-1" }),
  ];
  const reuse = decidePanePlacement({ panes, tabId: "w1K:t1", reuseCandidateId: "w1K:p2" });
  assert.equal(reuse.action, "reuse");
  assert.equal(reuse.paneId, "w1K:p2");
  assert.match(reuse.reason, /Reuse the matching pane when found/);

  const splitWhenNoReuse = decidePanePlacement({ panes, tabId: "w1K:t1" });
  assert.equal(splitWhenNoReuse.action, "split");
  assert.match(splitWhenNoReuse.reason, /split only when no reusable pane exists/);
});

test("14-18-M2 protected Dev Developer Terminal is never renamed split closed reused or modified", () => {
  assert.equal(isDevPane(devPane({ pane_id: "w1K:pDev" })), true);
  assert.equal(
    isDevPane({
      pane_id: "w1K:pDev2",
      tab_id: "w1K:t1",
      label: "Developer Terminal",
      terminal_title: "Developer Terminal",
      terminal_title_stripped: "Developer Terminal",
    }),
    true,
  );
  assert.equal(isDevPane(pane({ pane_id: "w1K:p1", label: "sheep-1" })), false);
  assert.equal(isDevPane({ pane_id: "w1K:pCwd", tab_id: "w1K:t1", label: "sheep-1", terminal_title: "sheep-1", terminal_title_stripped: "sheep-1" }), false);

  const withDev = [
    pane({ pane_id: "w1K:p1", label: "caller" }),
    devPane({ pane_id: "w1K:pDev" }),
    pane({ pane_id: "w1K:p2", label: "sheep-1" }),
  ];
  assert.deepEqual(
    managedPanes(withDev).map((entry) => entry.pane_id).sort(),
    ["w1K:p1", "w1K:p2"],
  );
  assert.deepEqual(
    managedPanesInTab(withDev, "w1K:t1").map((entry) => entry.pane_id).sort(),
    ["w1K:p1", "w1K:p2"],
  );

  const devOnlyReuse = decidePanePlacement({
    panes: withDev,
    tabId: "w1K:t1",
    reuseCandidateId: "w1K:pDev",
  });
  assert.notEqual(devOnlyReuse.paneId, "w1K:pDev");
  assert.equal(devOnlyReuse.action, "split");
  assert.match(devOnlyReuse.reason, /treat reuse as absent/);

  const fullWithDev = [
    pane({ pane_id: "w1K:p1", label: "caller" }),
    pane({ pane_id: "w1K:p2", label: "sheep-1" }),
    pane({ pane_id: "w1K:p3", label: "sheep-2" }),
    pane({ pane_id: "w1K:p4", label: "grazer-1" }),
    devPane({ pane_id: "w1K:pDev" }),
  ];
  assert.equal(managedPanesInTab(fullWithDev, "w1K:t1").length, 4);
  const overflowIgnoresDev = decidePanePlacement({
    panes: fullWithDev,
    tabId: "w1K:t1",
    reuseCandidateId: "w1K:p2",
  });
  assert.equal(overflowIgnoresDev.action, "overflow-reuse");
  assert.notEqual(overflowIgnoresDev.paneId, "w1K:pDev");

  for (const prompt of [SHEPHERD_PROMPT, SHEPHERD_GOVERNOR_PROMPT, SHEEPDOG_PROMPT]) {
    assert.match(prompt, /excluded from every scan plus split plus placement plus rename plus close plus reuse/);
    assert.match(prompt, /Never count it toward the four-pane cap/);
    assert.match(prompt, /never place a worker there, never rename it, never close it/);
  }
});

test("14-18-M2 initial plus dynamic plus focused plus empty tab cases keep Dev excluded", () => {
  const initial = [pane({ pane_id: "w1K:p1", label: "caller" })];
  assert.equal(managedPanesInTab(initial, "w1K:t1").length, 1);
  assert.equal(decidePanePlacement({ panes: initial, tabId: "w1K:t1" }).action, "split");

  const dynamic = [
    pane({ pane_id: "w1K:p1", label: "caller" }),
    pane({ pane_id: "w1K:p2", label: "sheep-1" }),
    pane({ pane_id: "w1K:p3", label: "sheep-2" }),
  ];
  assert.equal(
    decidePanePlacement({ panes: dynamic, tabId: "w1K:t1", reuseCandidateId: "w1K:p2" }).action,
    "reuse",
  );
  assert.equal(
    decidePanePlacement({ panes: dynamic, tabId: "w1K:t1" }).action,
    "split",
  );

  const focusedCurrent = "w1K:p1";
  assert.equal(preCreateDefaultPane(focusedCurrent), "w1K:p1");
  for (const prompt of [SHEPHERD_PROMPT, SHEPHERD_GOVERNOR_PROMPT, SHEEPDOG_PROMPT]) {
    assert.match(prompt, /Start in the calling pane and never rely on another client focused pane/);
  }

  const empty = [];
  assert.deepEqual(managedPanes(empty), []);
  assert.equal(decidePanePlacement({ panes: empty, tabId: "w1K:t1" }).action, "split");

  const emptyWithOnlyDev = [devPane({ pane_id: "w1K:pDev" })];
  assert.deepEqual(managedPanes(emptyWithOnlyDev), []);
  assert.deepEqual(managedPanesInTab(emptyWithOnlyDev, "w1K:t1"), []);
  const emptyDevPlacement = decidePanePlacement({
    panes: emptyWithOnlyDev,
    tabId: "w1K:t1",
    reuseCandidateId: "w1K:pDev",
  });
  assert.notEqual(emptyDevPlacement.paneId, "w1K:pDev");
});

test("14-18-M2 Sheepdog startup named destinations for grazer plus sheep plus shearer categories within cap", () => {
  assert.match(
    SHEEPDOG_PROMPT,
    /startup destinations for grazer plus sheep plus shearer-low plus shearer-medium worker categories stay within the per-role cap/,
  );
  assert.match(SHEEPDOG_PROMPT, /role tabs created lazily on first need/);
  assert.match(SHEEPDOG_PROMPT, /stays alone in its own tab titled Sheepdog plus descriptor with no flock workers/);

  assert.equal(nextRoleLabel([], "sheep"), "sheep-1");
  assert.equal(nextRoleLabel(["sheep-1", "sheep-2"], "sheep"), "sheep-3");
  assert.equal(nextRoleLabel(["grazer-1"], "grazer"), "grazer-2");
  assert.equal(nextRoleLabel(["shearer-low-1"], "shearer-low"), "shearer-low-2");

  const room = [pane({ pane_id: "w1K:p1", label: "Sheepdog", tab_id: "w1K:t1" })];
  for (const category of ["grazer", "sheep", "shearer-low", "shearer-medium"]) {
    const destination = sheepdogStartupDestination({
      panes: room,
      tabId: "w1K:t1",
      roleCategory: category,
      existingLabels: ["Sheepdog"],
    });
    assert.ok(destination.label.startsWith(`${category}-`));
    assert.equal(destination.action, "split");
  }

  const full = [
    pane({ pane_id: "w1K:p1", label: "Sheepdog" }),
    pane({ pane_id: "w1K:p2", label: "sheep-1" }),
    pane({ pane_id: "w1K:p3", label: "sheep-2" }),
    pane({ pane_id: "w1K:p4", label: "grazer-1" }),
  ];
  for (const category of ["grazer", "sheep", "shearer-low", "shearer-medium"]) {
    const destination = sheepdogStartupDestination({
      panes: full,
      tabId: "w1K:t1",
      roleCategory: category,
      existingLabels: ["Sheepdog", "sheep-1", "sheep-2", "grazer-1"],
      reuseCandidateId: "w1K:p2",
    });
    assert.equal(destination.action, "overflow-reuse");
    assert.notEqual(destination.action, "split");
    assert.ok(destination.label.startsWith(`${category}-`));
    assert.notEqual(destination.paneId, "w1K:pDev");
  }

  for (const category of ["grazer", "sheep", "shearer-low", "shearer-medium"]) {
    const overflow = sheepdogStartupDestination({
      panes: full,
      tabId: "w1K:t1",
      roleCategory: category,
      existingLabels: ["Sheepdog", "sheep-1", "sheep-2", "grazer-1"],
    });
    assert.equal(overflow.action, "new-tab");
    assert.notEqual(overflow.action, "split");
    assert.ok(overflow.label.startsWith(`${category}-`));
    assert.match(overflow.reason, /Overflow to a new tab with indexed role labels when the cap binds/);
  }

  const withDevFull = [...full, devPane({ pane_id: "w1K:pDev" })];
  const devExcluded = sheepdogStartupDestination({
    panes: withDevFull,
    tabId: "w1K:t1",
    roleCategory: "sheep",
    existingLabels: ["Sheepdog", "sheep-1"],
    reuseCandidateId: "w1K:p2",
  });
  assert.equal(devExcluded.action, "overflow-reuse");
  assert.notEqual(devExcluded.paneId, "w1K:pDev");
});

test("14-18-M2 six-step dynamic placement uses the same policy with no separate rulebook", () => {
  for (const prompt of [SHEPHERD_PROMPT, SHEPHERD_GOVERNOR_PROMPT, SHEEPDOG_PROMPT]) {
    assert.match(prompt, /Six-step placement is reuse-first plus evidence-only with new-tab overflow/);
    assert.match(prompt, /Dynamic placement follows the same single normative pane policy with new-tab overflow and no separate rulebook/);
    assert.match(prompt, /On finish, reuse the pane for the next same-role assignment after confirming idle plus done/);
    assert.match(prompt, /Reuse is preferred over clutter/);
    assert.match(prompt, /Never touch the Dev pane in any tab/);
  }
  assert.match(SHEEPDOG_PROMPT, /six-step placement is reuse-first plus evidence-only with new-tab overflow with cap check plus reuse check plus split plus rename plus tab create plus start/);
  assert.match(SHEEPDOG_PROMPT, /on cap go to a new indexed role tab and never split beyond the per-role cap/);
  assert.match(SHEEPDOG_PROMPT, /reuse capacity-available managed panes first within the cap/);
});

test("30-M1 shepherd plus governor startup destinations mirror sheepdog placement with Dev excluded", () => {
  const room = [pane({ pane_id: "w1K:p1", label: "caller", tab_id: "w1K:t1" })];
  const shepherdDest = shepherdStartupDestination({ panes: room, tabId: "w1K:t1", existingLabels: ["caller"] });
  assert.ok(shepherdDest.label.startsWith("grazer-"), "shepherd starts grazers with indexed labels");
  assert.equal(shepherdDest.action, "split", "room means split");

  const governorSheepdog = governorStartupDestination({
    panes: room,
    tabId: "w1K:t1",
    roleCategory: "sheepdog",
    existingLabels: ["caller"],
  });
  assert.ok(governorSheepdog.label.startsWith("Sheepdog-"), "governor sheepdog uses indexed Sheepdog labels");
  assert.equal(governorSheepdog.action, "split", "room means split");

  const governorGrazer = governorStartupDestination({
    panes: room,
    tabId: "w1K:t1",
    roleCategory: "grazer",
    existingLabels: ["caller"],
  });
  assert.ok(governorGrazer.label.startsWith("grazer-"), "governor grazer uses indexed grazer labels");

  const full = [
    pane({ pane_id: "w1K:p1", label: "caller" }),
    pane({ pane_id: "w1K:p2", label: "sheep-1" }),
    pane({ pane_id: "w1K:p3", label: "sheep-2" }),
    pane({ pane_id: "w1K:p4", label: "grazer-1" }),
  ];
  assert.equal(shepherdStartupDestination({ panes: full, tabId: "w1K:t1", existingLabels: [] }).action, "new-tab");
  assert.equal(
    governorStartupDestination({ panes: full, tabId: "w1K:t1", roleCategory: "sheepdog", existingLabels: [] }).action,
    "new-tab",
  );

  const withDev = [...room, devPane({ pane_id: "w1K:pDev" })];
  const devExcluded = governorStartupDestination({
    panes: withDev,
    tabId: "w1K:t1",
    roleCategory: "sheepdog",
    existingLabels: ["caller"],
    reuseCandidateId: "w1K:pDev",
  });
  assert.notEqual(devExcluded.paneId, "w1K:pDev", "Dev never reused for startup");
});

test("32-M1 dedicated role tabs keep the caller tab sacred with quadrant geometry and per-role overflow", () => {
  for (const sentence of ROLE_TAB_POLICY_SENTENCES) {
    assert.equal(typeof sentence, "string");
    for (const [name, prompt] of [
      ["shepherd", SHEPHERD_PROMPT],
      ["shepherd-governor", SHEPHERD_GOVERNOR_PROMPT],
      ["sheepdog", SHEEPDOG_PROMPT],
    ]) {
      assert.ok(prompt.includes(sentence), `${name} must contain role-tab sentence: ${sentence}`);
    }
  }
  for (const [name, prompt] of [
    ["shepherd", SHEPHERD_PROMPT],
    ["shepherd-governor", SHEPHERD_GOVERNOR_PROMPT],
    ["sheepdog", SHEEPDOG_PROMPT],
  ]) {
    assert.ok(prompt.includes(ROLE_TAB_POLICY_PARAGRAPH), `${name} must contain the role-tab paragraph verbatim`);
  }

  assert.equal(roleTabCapFor("sheepdog"), 1);
  assert.equal(roleTabCapFor("grazer"), 4);
  assert.equal(roleTabCapFor("sheep"), 4);
  assert.equal(roleTabCapFor("shearer-low"), 2);
  assert.equal(roleTabCapFor("shearer-medium"), 2);
  assert.equal(roleTabBaseLabel("sheepdog"), "Sheepdog");
  assert.equal(roleTabBaseLabel("grazer"), "grazers");
  assert.equal(roleTabBaseLabel("sheep"), "sheep");
  assert.equal(roleTabBaseLabel("shearer-low"), "shearers");
  assert.equal(nextRoleTabLabel([], "grazer"), "grazers");
  assert.equal(nextRoleTabLabel(["grazers"], "grazer"), "grazers-2");
  assert.equal(nextRoleTabLabel(["grazers", "grazers-2"], "grazer"), "grazers-3");
  assert.deepEqual(roleTabGeometry("sheepdog"), { panes: 1, steps: [] });
  assert.equal(roleTabGeometry("grazer").panes, 4);
  assert.equal(roleTabGeometry("sheep").panes, 4);
  assert.deepEqual(roleTabGeometry("shearer-low"), { panes: 2, steps: ["split right once"] });

  const tabs = [
    { tab_id: "w1K:t0", label: "1" },
    { tab_id: "w1K:t1", label: "Sheepdog" },
    { tab_id: "w1K:t2", label: "grazers" },
  ];
  const panes = [
    pane({ pane_id: "w1K:p0", tab_id: "w1K:t0", label: "caller" }),
    pane({ pane_id: "w1K:p9", tab_id: "w1K:t1", label: "Sheepdog" }),
    pane({ pane_id: "w1K:p1", tab_id: "w1K:t2", label: "grazer-1" }),
  ];
  const roomy = sheepdogRoleTabDestination({ roleCategory: "grazer", tabs, panes, callerTabId: "w1K:t0" });
  assert.equal(roomy.tabLabel, "grazers");
  assert.equal(roomy.action, "split");
  assert.notEqual(roomy.tabLabel, "1", "never places on the caller tab");

  const reuse = sheepdogRoleTabDestination({
    roleCategory: "grazer",
    tabs,
    panes,
    reuseCandidateId: "w1K:p1",
    callerTabId: "w1K:t0",
  });
  assert.equal(reuse.action, "reuse");
  assert.equal(reuse.paneId, "w1K:p1");

  const callerCandidate = sheepdogRoleTabDestination({
    roleCategory: "grazer",
    tabs,
    panes,
    reuseCandidateId: "w1K:p0",
    callerTabId: "w1K:t0",
  });
  assert.notEqual(callerCandidate.tabLabel, "1", "a caller-tab candidate never satisfies role reuse");

  const sheepDest = sheepdogRoleTabDestination({ roleCategory: "sheep", tabs, panes, callerTabId: "w1K:t0" });
  assert.equal(sheepDest.action, "new-tab");
  assert.equal(sheepDest.tabLabel, "sheep");

  const fullPanes = [
    ...panes,
    pane({ pane_id: "w1K:p2", tab_id: "w1K:t2", label: "grazer-2" }),
    pane({ pane_id: "w1K:p3", tab_id: "w1K:t2", label: "grazer-3" }),
    pane({ pane_id: "w1K:p4", tab_id: "w1K:t2", label: "grazer-4" }),
  ];
  const overflow = sheepdogRoleTabDestination({
    roleCategory: "grazer",
    tabs,
    panes: fullPanes,
    callerTabId: "w1K:t0",
  });
  assert.equal(overflow.action, "new-tab");
  assert.equal(overflow.tabLabel, "grazers-2");

  const devInRoleTab = [
    ...panes,
    devPane({ pane_id: "w1K:pDev", tab_id: "w1K:t2" }),
  ];
  const devReuse = sheepdogRoleTabDestination({
    roleCategory: "grazer",
    tabs,
    panes: devInRoleTab,
    reuseCandidateId: "w1K:pDev",
    callerTabId: "w1K:t0",
  });
  assert.notEqual(devReuse.paneId, "w1K:pDev", "Dev never reused for role placement");
});
