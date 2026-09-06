import test from "node:test";
import assert from "node:assert/strict";

import {
  PANE_CAP,
  SHEEPDOG_PROMPT,
  SHEPHERD_GOVERNOR_PROMPT,
  SHEPHERD_PROMPT,
  decidePanePlacement,
  isDevPane,
  managedPanes,
  managedPanesInTab,
  nextRoleLabel,
  preCreateDefaultPane,
  sheepdogStartupDestination,
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
    /startup destinations for grazer plus sheep plus shearer-low plus shearer-medium worker categories stay within the four-pane cap per tab/,
  );
  assert.match(SHEEPDOG_PROMPT, /pre-create default minimal/);
  assert.match(SHEEPDOG_PROMPT, /starts in its own Sheepdog pane and starts flock workers in sibling flock panes of the current tab with overflow to a new tab/);

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
  assert.match(SHEEPDOG_PROMPT, /on cap go to a new tab with indexed role labels and never split a fifth pane/);
  assert.match(SHEEPDOG_PROMPT, /reuse capacity-available managed panes first within the cap/);
});
