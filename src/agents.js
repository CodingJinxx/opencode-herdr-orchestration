import {
  GRAZER_PROMPT,
  SHEEPDOG_PROMPT,
  SHEEP_PROMPT,
  SHEPHERD_GOVERNOR_PROMPT,
  SHEPHERD_PROMPT,
  SHEARER_REVIEW_PROMPT,
} from "./prompts.js";

const separatorDenials = {
  "*;*": "deny",
  "*&&*": "deny",
  "*||*": "deny",
  "*|*": "deny",
  "*>*": "deny",
  "*<*": "deny",
};

const safeGitInspection = {
  "git status": "allow",
  "git status --short": "allow",
  "git status --porcelain": "allow",
  "git diff": "allow",
  "git diff --cached": "allow",
  "git diff --stat": "allow",
  "git diff --cached --stat": "allow",
  "git log": "allow",
  "git log --oneline": "allow",
  "git log --oneline -10": "allow",
  "git show": "allow",
  "git branch --show-current": "allow",
  "git branch --list": "allow",
  "git rev-parse HEAD": "allow",
  "git rev-parse --show-toplevel": "allow",
  "git rev-parse --abbrev-ref HEAD": "allow",
  "git merge-base HEAD main": "allow",
  "git merge-base HEAD master": "allow",
  "git ls-files": "allow",
};

// 20-M1 responsive wait: bounded `herdr agent get` polling uses only the
// already-permitted prompt plus wait plus get plus read plus list surfaces.
// No event stream command is evidenced, so no new Herdr command is invented;
// `herdr agent wait` stays a bounded sleep between `get` state checks and the
// safety timeout stays the final bound only. Sheepdog owns routine flock waits
// with no per-transition Shepherd wakeups; governor leaf bans stay untouched.
const herdrInspection = {
  "Get-Item Env:HERDR_ENV": "allow",
  "herdr --help": "allow",
  "herdr agent": "allow",
  "herdr agent list*": "allow",
  "herdr agent prompt*": "allow",
  "herdr agent wait*": "allow",
  "herdr agent get*": "allow",
  "herdr agent read*": "allow",
  "herdr agent send-keys*": "allow",
  "herdr pane current*": "allow",
  "herdr pane list*": "allow",
  "herdr pane layout*": "allow",
  "herdr pane split*": "allow",
  "herdr pane read*": "allow",
  "herdr worktree": "allow",
  "herdr worktree list*": "allow",
  "herdr worktree create *": "allow",
  "herdr worktree open *": "allow",
  "herdr worktree remove --workspace *": "allow",
  "herdr worktree remove * --force*": "deny",
};

const markdownOnly = {
  "*": "deny",
  "*.md": "allow",
  "**/*.md": "allow",
};

// Constrained orchestration state tools. The planning shepherd authors plan
// artifacts; shepherd-governor and sheepdog read the authoritative plan, and
// sheepdog records and reads execution artifacts. This matrix is the single
// source of truth for both the plugin-level tool enforcement (src/index.js)
// and the per-agent permission entries below.
export const STATE_TOOLS = Object.freeze({
  planWrite: "herdr_plan_write",
  planRead: "herdr_plan_read",
  executionWrite: "herdr_execution_write",
  executionRead: "herdr_execution_read",
});

export const STATE_TOOL_ACCESS = Object.freeze(
  new Map([
    [STATE_TOOLS.planWrite, new Set(["shepherd"])],
    [STATE_TOOLS.planRead, new Set(["shepherd", "shepherd-governor", "sheepdog"])],
    [STATE_TOOLS.executionWrite, new Set(["sheepdog"])],
    [STATE_TOOLS.executionRead, new Set(["sheepdog"])],
  ]),
);

const ALL_STATE_TOOLS = Object.freeze(Object.values(STATE_TOOLS));

function stateToolPermissions(allowedTools) {
  return Object.fromEntries(
    ALL_STATE_TOOLS.map((name) => [name, allowedTools.includes(name) ? "allow" : "deny"]),
  );
}

// Developer steering submission (M2, Option A, trusted Developer only).
// The explicit non-flock `developer` context is the sole submitter; all
// seven orchestration roles are denied as defense in depth. The runtime
// context-agent check in src/index.js plus the /steer hook in src/steer.js
// stays authoritative over these static entries: even a user override
// flipping one to "allow" must not bypass the allowlist. No flock role may
// present as Developer: the developer profile below holds only the submit
// tool and no spawn matrix entry creates or targets it.
export const DEVELOPER_AGENT = "developer";
export const DEVELOPER_PROMPT = String.raw`
You are developer, the trusted steering submitter. Submit bounded steering via /steer as <content> or <planId> :: <content>; omit planId only when exactly one active steering target exists. You hold only herdr_steering_submit; you never implement flock work, never spawn workers, and never read raw steering.
`.trim();
export const ORCHESTRATION_ROLES = Object.freeze([
  "shepherd",
  "shepherd-governor",
  "sheepdog",
  "grazer",
  "sheep",
  "shearer-low",
  "shearer-medium",
]);
export const STEERING_TOOLS = Object.freeze({
  submit: "herdr_steering_submit",
});
export const STEERING_TOOL_ACCESS = Object.freeze(
  new Map([[STEERING_TOOLS.submit, new Set([DEVELOPER_AGENT])]]),
);
const ALL_STEERING_TOOLS = Object.freeze(Object.values(STEERING_TOOLS));

function steeringToolPermissions(allowedTools) {
  return Object.fromEntries(
    ALL_STEERING_TOOLS.map((name) => [name, allowedTools.includes(name) ? "allow" : "deny"]),
  );
}

// Shepherd ownership raw steering plus lifecycle tools (M3). Only the two
// Shepherd phases may check, read, or consume raw steering and only the
// recorded owner phase plus session plus generation passes the state-level
// fencing (NOT AUTHORITATIVE PHASE otherwise). Sheepdog and every leaf are
// explicitly denied in code, not only in prompts; the runtime check in
// src/index.js stays authoritative over static overrides.
export const SHEPHERD_PHASES = Object.freeze(["shepherd", "shepherd-governor"]);
export const RAW_STEERING_TOOLS = Object.freeze({
  check: "herdr_steering_check",
  read: "herdr_steering_read",
  consume: "herdr_steering_consume",
});
export const OWNERSHIP_TOOLS = Object.freeze({
  claim: "herdr_ownership_claim",
  read: "herdr_ownership_read",
  sync: "herdr_ownership_sync",
  snapshot: "herdr_ownership_snapshot",
  correct: "herdr_ownership_correct",
});
export const RAW_STEERING_TOOL_ACCESS = Object.freeze(
  new Map(Object.values(RAW_STEERING_TOOLS).map((name) => [name, new Set(SHEPHERD_PHASES)])),
);
export const OWNERSHIP_TOOL_ACCESS = Object.freeze(
  new Map(Object.values(OWNERSHIP_TOOLS).map((name) => [name, new Set(SHEPHERD_PHASES)])),
);
const ALL_RAW_STEERING_TOOLS = Object.freeze(Object.values(RAW_STEERING_TOOLS));
const ALL_OWNERSHIP_TOOLS = Object.freeze(Object.values(OWNERSHIP_TOOLS));

function rawSteeringToolPermissions(allowedTools) {
  return Object.fromEntries(
    ALL_RAW_STEERING_TOOLS.map((name) => [name, allowedTools.includes(name) ? "allow" : "deny"]),
  );
}

function ownershipToolPermissions(allowedTools) {
  return Object.fromEntries(
    ALL_OWNERSHIP_TOOLS.map((name) => [name, allowedTools.includes(name) ? "allow" : "deny"]),
  );
}

const SHEPHERD_STATE_TOOLS = [STATE_TOOLS.planWrite, STATE_TOOLS.planRead];
const GOVERNOR_STATE_TOOLS = [STATE_TOOLS.planRead];
const SHEEPDOG_STATE_TOOLS = [
  STATE_TOOLS.planRead,
  STATE_TOOLS.executionWrite,
  STATE_TOOLS.executionRead,
];
const SHEPHERD_RAW_STEERING_TOOLS = Object.values(RAW_STEERING_TOOLS);
const SHEPHERD_OWNERSHIP_TOOLS = Object.values(OWNERSHIP_TOOLS);

const SHEPHERD_SPAWNABLE_AGENTS = ["grazer"];
const GOVERNOR_SPAWNABLE_AGENTS = ["grazer", "sheepdog"];
const SHEEPDOG_SPAWNABLE_AGENTS = ["grazer", "sheep", "shearer-low", "shearer-medium"];

const SHEEPDOG_LIFECYCLE_ALLOWS = {
  "git merge --ff-only*": "allow",
  "git merge --no-ff --no-edit*": "allow",
  "git merge --continue": "allow",
  "git merge --abort": "allow",
  "git merge --quit": "allow",
  "git cherry-pick*": "allow",
  "git cherry-pick --continue": "allow",
  "git cherry-pick --skip": "allow",
  "git cherry-pick --abort": "allow",
  "git cherry-pick --quit": "allow",
  "git commit*": "allow",
};

// Sheepdog Herdr lifecycle (21-M1): explicit prompt plus wait plus get plus
// read allows. These re-assert the shared herdrInspection entries so the four
// lifecycle operations stay evaluation-effective under OpenCode last-match
// glob semantics: "*" deny is the fallback first, these allows sit in the
// middle, separator denies stay global last. A prompt whose task text carries
// raw "; && || | > <" matches a separator deny after the prompt allow and
// fails closed to deny even inside quotes, so task text must avoid raw
// separators (see SHEEPDOG_PROMPT safe rule).
const SHEEPDOG_HERDR_LIFECYCLE_ALLOWS = {
  "herdr agent prompt*": "allow",
  "herdr agent wait*": "allow",
  "herdr agent get*": "allow",
  "herdr agent read*": "allow",
};

// Sheepdog interrupt bound (21-M1): replacement for the broad
// "herdr agent send-keys*" allow in shared herdrInspection. The broad pattern
// is explicitly denied first so only the narrow Ctrl-C spellings below are
// evaluation-effective. Matchers are string globs and cannot prove semantic
// intent, so the prompt inspect-first plus never-type rule stays primary; see
// SHEEPDOG_PROMPT and README Worker interruption residual.
const SHEEPDOG_SEND_KEYS_DENY = {
  "herdr agent send-keys*": "deny",
};
const SHEEPDOG_SEND_KEYS_CTRL_C_ALLOWS = {
  "herdr agent send-keys * --keys C-c*": "allow",
  "herdr agent send-keys * --keys c-c*": "allow",
  "herdr agent send-keys * --keys ctrl+c*": "allow",
  "herdr agent send-keys * --keys Ctrl+C*": "allow",
  "herdr agent send-keys * C-c*": "allow",
  "herdr agent send-keys * ctrl+c*": "allow",
};

// Governor Herdr prompt residual (21-M2): `herdr agent prompt` plus wait plus
// get plus read patterns are name-based and cannot encode worker role, so they
// stay broad as far as text matchers permit. Prompt bans plus start denial
// (spawn matrix allows only grazer and sheepdog) plus the response matrix
// (retrieval allows only grazer and sheepdog) are the load-bearing layers;
// see SHEPHERD_GOVERNOR_PROMPT and README Governor prompt scoping residual.
// Governor interrupt bound (21-M2): replacement for the broad
// "herdr agent send-keys*" allow in shared herdrInspection, mirroring the
// sheepdog M1 bound. The broad pattern is explicitly denied first so only the
// narrow Ctrl-C spellings below are evaluation-effective. Matchers are string
// globs and cannot prove semantic intent, so the prompt inspect-first plus
// never-type plus never-bypass rule stays primary.
const GOVERNOR_SEND_KEYS_DENY = {
  "herdr agent send-keys*": "deny",
};
const GOVERNOR_SEND_KEYS_CTRL_C_ALLOWS = {
  "herdr agent send-keys * --keys C-c*": "allow",
  "herdr agent send-keys * --keys c-c*": "allow",
  "herdr agent send-keys * --keys ctrl+c*": "allow",
  "herdr agent send-keys * --keys Ctrl+C*": "allow",
  "herdr agent send-keys * C-c*": "allow",
  "herdr agent send-keys * ctrl+c*": "allow",
};

// Pane layout (14-18-M1): live discovery on installed 0.8.2 via full-path
// `herdr --help` plus `herdr --skill` plus scoped read-only queries
// (`pane list --workspace w1K`, `tab list --workspace w1K`,
// `pane current --current`, `pane layout --current`, `agent get <name>`,
// `pane get w1K:p999` error sampling). Direct `herdr ...` spelling stays
// denied for leaves; discovery used only read-only help plus list plus get
// plus current plus layout, never split plus rename plus close plus start.
// Tab evidenced as list plus create plus get plus focus plus rename plus
// close; list takes `--workspace <ID>`, create takes
// `--workspace/--cwd/--label/--env/--focus/--no-focus`, rename takes
// `<TAB_ID> <LABEL>...`, close plus get plus focus take `<tab_id>`.
// Pane placement evidenced as split plus move plus focus plus resize plus
// swap plus layout plus get plus list plus current plus read plus rename plus
// close; split is `[PANE_ID] --pane/--current --direction right/down --ratio
// --cwd --env --focus/--no-focus`, move is `<PANE_ID>
// --tab/--split/--target-pane/--ratio/--new-tab/--workspace/--new-workspace/--label/--tab-label/--focus/--no-focus`,
// focus and neighbor take `--direction left/right/up/down --pane/--current`,
// resize takes `--direction --amount --pane/--current`, swap takes
// `--direction/--pane/--current/--source-pane/--target-pane`, layout takes
// `--pane/--current`, get takes `<pane_id>`, list takes
// `--workspace <ID>`, current takes `--pane/--current`, read takes
// `<PANE_ID> --source visible/recent/recent-unwrapped/detection
// --lines/--format/--ansi/--raw`, rename takes `<PANE_ID> [LABEL]...
// --clear`, close takes `<pane_id>`.
// Agent rename evidenced as `herdr agent rename <TARGET> <NAME>|--clear`
// (live `agent list` shows `name` such as `issue1418m1sheep` and `agent get`
// shows `name` plus `pane_id`); pane rename plus tab rename helps evidenced
// but only pane plus agent rename are enabled, tab rename stays denied to
// keep the single-tab 4-pane cap.
// Count queries evidenced as `herdr tab list --workspace <ID>` returning
// `{"id":"cli:tab:list","result":{"tabs":[{"pane_count":1,"tab_id":"w1K:t1",...}]},"type":"tab_list"}`,
// `herdr pane list --workspace <ID>` returning
// `{"id":"cli:pane:list","result":{"panes":[{...,"pane_id":"w1K:p1","tab_id":"w1K:t1","workspace_id":"w1K",...}]},"type":"pane_list"}`
// (count is length filtered by workspace plus tab), `herdr pane layout
// --current` returning
// `{"id":"cli:pane:layout","result":{"layout":{"panes":[...],"splits":[],"focused_pane_id":"w1K:p1",...}},"type":"pane_layout"}`,
// `herdr pane current --current` returning
// `{"id":"cli:pane:current","result":{"pane":{...}},"type":"pane_current"}`.
// Creation JSON per `herdr --skill`: `tab create` returns
// `.result.tab` plus `.result.root_pane`, `pane split` returns the new pane
// as `.result.pane` (skill geometry is `pane split --current --direction
// right/down --cwd "$PWD" --no-focus`, wide to the right and narrow or tall
// down, reading `.result.pane.pane_id` and never deriving from sidebar
// order), `pane move` would return
// `.result.move_result.pane.pane_id` plus `.result.move_result.previous_pane_id`
// but move stays denied and is documented only.
// Exits per `herdr --skill` plus live sampling: most controls return JSON on
// stdout with `id` plus `result` plus `type`; server errors are JSON such as
// `{"error":{"code":"pane_not_found","message":"pane w1K:p999 not found"},"id":"cli:pane:get"}`
// on stderr with exit 1; syntax plus validation such as `pane split
// --direction invalid` returning `invalid split direction` exits with 2.
// IDs are opaque stable handles (`w1K`, `w1K:t1`, `w1K:p1` from
// `HERDR_WORKSPACE_ID` plus `HERDR_TAB_ID` plus `HERDR_PANE_ID`); closed IDs
// are not reused; prefer `--current` and never rely on the UI-focused pane.
// Fallback if any of tab list plus pane get plus rename plus close plus
// split are missing: reuse the current pane via `--pane` plus `--current`,
// report STOP naming the missing capability, never invent `herdr pane
// create*` plus `herdr tab split*` plus `herdr agent events*` plus
// `herdr pane move*` plus `herdr pane resize*` plus `herdr workspace
// create*` behavior.
// Protected Dev Developer Terminal exclusion cannot be matcher-enforced:
// pane IDs are opaque and labels are absent from scan plus split plus close
// command strings, while a `*Dev*` glob would overmatch legitimate
// `--cwd C:\Dev\...` values, so no such glob is added; the prompt plus
// README Pane layout policy exclusion stays primary; see README residual.
const SHEPHERD_PANE_ALLOWS = {
  "herdr tab list*": "allow",
  "herdr pane get*": "allow",
  "herdr pane rename*": "allow",
  "herdr agent rename*": "allow",
};
const GOVERNOR_PANE_ALLOWS = {
  "herdr tab list*": "allow",
  "herdr pane get*": "allow",
  "herdr pane rename*": "allow",
  "herdr agent rename*": "allow",
};
const SHEEPDOG_PANE_ALLOWS = {
  "herdr tab list*": "allow",
  "herdr pane get*": "allow",
  "herdr pane rename*": "allow",
  "herdr agent rename*": "allow",
  "herdr pane close*": "allow",
};

const SHEEPDOG_DENIALS = {
  "git push*": "deny",
  "git pull*": "deny",
  "git fetch*": "deny",
  "git remote*": "deny",
  "git rebase*": "deny",
  "git reset*": "deny",
  "git revert*": "deny",
  "git checkout*": "deny",
  "git switch*": "deny",
  "git stash*": "deny",
  "git clean*": "deny",
  "git worktree*": "deny",
  "git branch -D*": "deny",
  "git branch -d*": "deny",
  "git commit --no-verify*": "deny",
  "git commit * --no-verify*": "deny",
  "git commit --amend*": "deny",
  "git commit * --amend*": "deny",
  "git merge *--no-verify*": "deny",
};

const SHEEP_DENIALS = {
  "herdr*": "deny",
  "gh*": "deny",
  "npm publish*": "deny",
  "git push*": "deny",
  "git pull*": "deny",
  "git fetch*": "deny",
  "git remote*": "deny",
  "git merge*": "deny",
  "git cherry-pick*": "deny",
  "git rebase*": "deny",
  "git reset*": "deny",
  "git revert*": "deny",
  "git checkout*": "deny",
  "git switch*": "deny",
  "git stash*": "deny",
  "git clean*": "deny",
  "git worktree*": "deny",
  "git tag*": "deny",
  "git apply*": "deny",
  "git am*": "deny",
  "git branch -D*": "deny",
  "git branch -d*": "deny",
  "git commit --no-verify*": "deny",
  "git commit *--no-verify*": "deny",
  "git commit --amend*": "deny",
  "git commit *--amend*": "deny",
};

function mergeRecord(base, override) {
  if (!base || typeof base !== "object" || Array.isArray(base)) return override ?? base;
  if (!override || typeof override !== "object" || Array.isArray(override)) return override ?? base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = mergeRecord(base[key], value);
  }
  return merged;
}

export function mergeAgent(defaults, override) {
  return mergeRecord(defaults, override);
}

function spawnMatrix(agents) {
  return Object.fromEntries(
    agents.map((agent) => [`herdr agent start * --kind opencode --pane * -- --agent ${agent}`, "allow"]),
  );
}

export function createAgents(options = {}) {
  const shepherdModel = options.shepherdModel;
  const workerModel = options.workerModel ?? "litellm/glm-5.3-flash";
  const workerVariant = options.workerVariant;
  const grazerVariant = options.grazerVariant ?? workerVariant;
  const sheepdogModel = options.sheepdogModel ?? "litellm/glm-5.3-flash";
  const sheepdogVariant = options.sheepdogVariant;
  const reviewerModel = options.reviewerModel ?? "litellm-responses/gpt-5.6-terra";
  const shepherdPermissions = options.shepherdPermissions ?? {};
  const shepherdPrompt = appendPrompt(SHEPHERD_PROMPT, options.shepherdPromptAppend, "shepherdPromptAppend");
  const sheepdogPermissions = options.sheepdogPermissions ?? {};
  const sheepdogPrompt = appendPrompt(SHEEPDOG_PROMPT, options.sheepdogPromptAppend, "sheepdogPromptAppend");

  return {
    shepherd: {
      mode: "primary",
      ...(shepherdModel ? { model: shepherdModel } : {}),
      description:
        "Plans through grazer research and presents implementation-ready plans; never implements, integrates, or delivers.",
      prompt: shepherdPrompt,
      permission: {
        grep: "allow",
        todowrite: "allow",
        edit: markdownOnly,
        apply_patch: markdownOnly,
        herdr_agent_response: "allow",
        ...stateToolPermissions(SHEPHERD_STATE_TOOLS),
        ...steeringToolPermissions([]),
        ...rawSteeringToolPermissions(SHEPHERD_RAW_STEERING_TOOLS),
        ...ownershipToolPermissions(SHEPHERD_OWNERSHIP_TOOLS),
        bash: {
          "*": "deny",
          ...herdrInspection,
          ...SHEPHERD_PANE_ALLOWS,
          ...spawnMatrix(SHEPHERD_SPAWNABLE_AGENTS),
          "git status*": "allow",
          "git diff*": "allow",
          "git log*": "allow",
          "git show*": "allow",
          "git branch*": "allow",
          "git rev-parse*": "allow",
          "git merge-base*": "allow",
          "git worktree*": "allow",
          "git add *.md": "allow",
          "git add **/*.md": "allow",
          "git commit*": "allow",
          "git push*": "deny",
          "git commit --no-verify*": "deny",
          "git commit * --no-verify*": "deny",
          "git commit --amend*": "deny",
          "git commit * --amend*": "deny",
          "git branch -D*": "deny",
          "git branch -d*": "deny",
          "git worktree remove * --force*": "deny",
          ...separatorDenials,
        },
        task: "deny",
        ...shepherdPermissions,
      },
    },

    "shepherd-governor": {
      mode: "primary",
      ...(shepherdModel ? { model: shepherdModel } : {}),
      description:
        "Executes approved plans through sheepdog squads, verifies results, and owns final delivery: pushes, merges, PRs.",
      prompt: SHEPHERD_GOVERNOR_PROMPT,
      permission: {
        grep: "allow",
        todowrite: "allow",
        edit: markdownOnly,
        apply_patch: markdownOnly,
        herdr_agent_response: "allow",
        ...stateToolPermissions(GOVERNOR_STATE_TOOLS),
        ...steeringToolPermissions([]),
        ...rawSteeringToolPermissions(SHEPHERD_RAW_STEERING_TOOLS),
        ...ownershipToolPermissions(SHEPHERD_OWNERSHIP_TOOLS),
        bash: {
          "*": "deny",
          ...herdrInspection,
          ...GOVERNOR_PANE_ALLOWS,
          ...spawnMatrix(GOVERNOR_SPAWNABLE_AGENTS),
          "git status*": "allow",
          "git diff*": "allow",
          "git log*": "allow",
          "git show*": "allow",
          "git branch*": "allow",
          "git rev-parse*": "allow",
          "git merge-base*": "allow",
          "git worktree list*": "allow",
          "git add *.md": "allow",
          "git add **/*.md": "allow",
          "git commit*": "allow",
          "git push*": "allow",
          "git merge*": "allow",
          "git fetch*": "allow",
          "git pull --ff-only*": "allow",
          "git push --force*": "deny",
          "git push * --force*": "deny",
          "git push -f*": "deny",
          "git push * -f*": "deny",
          "git push *--delete*": "deny",
          "git push *--no-verify*": "deny",
          "git commit *--no-verify*": "deny",
          "git commit --amend*": "deny",
          "git commit *--amend*": "deny",
          "git merge *--no-verify*": "deny",
          "git branch -D*": "deny",
          "git branch -d*": "deny",
          "git worktree add*": "deny",
          "git worktree remove*": "deny",
          "git worktree move*": "deny",
          "git worktree prune*": "deny",
          "git worktree remove * --force*": "deny",
          "herdr worktree create*": "deny",
          "herdr worktree open*": "deny",
          "herdr worktree remove*": "deny",
          "gh pr create*": "allow",
          "gh pr view*": "allow",
          "gh pr checks*": "allow",
          ...GOVERNOR_SEND_KEYS_DENY,
          ...GOVERNOR_SEND_KEYS_CTRL_C_ALLOWS,
          ...separatorDenials,
        },
        task: "deny",
      },
    },

    sheepdog: {
      mode: "primary",
      model: sheepdogModel,
      ...(sheepdogVariant ? { variant: sheepdogVariant } : {}),
      description:
        "Leads execution squads of grazer, sheep, and shearers, prepares worker branches and worktrees, owns validation, review tiers, retries, and conflict recovery, and performs clean local integration with merge and cherry-pick lifecycle commands only.",
      prompt: sheepdogPrompt,
      permission: {
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        todowrite: "allow",
        edit: "deny",
        apply_patch: "deny",
        herdr_agent_response: "allow",
        ...stateToolPermissions(SHEEPDOG_STATE_TOOLS),
        ...steeringToolPermissions([]),
        ...rawSteeringToolPermissions([]),
        ...ownershipToolPermissions([]),
        bash: {
          "*": "deny",
          ...safeGitInspection,
          ...herdrInspection,
          ...SHEEPDOG_PANE_ALLOWS,
          ...spawnMatrix(SHEEPDOG_SPAWNABLE_AGENTS),
          ...SHEEPDOG_HERDR_LIFECYCLE_ALLOWS,
          ...SHEEPDOG_LIFECYCLE_ALLOWS,
          ...SHEEPDOG_DENIALS,
          ...SHEEPDOG_SEND_KEYS_DENY,
          ...SHEEPDOG_SEND_KEYS_CTRL_C_ALLOWS,
          ...separatorDenials,
        },
        task: "deny",
        ...sheepdogPermissions,
      },
    },

    grazer: {
      mode: "primary",
      model: workerModel,
      ...(grazerVariant ? { variant: grazerVariant } : {}),
      description: "Performs read-only repository research for the shepherd, shepherd-governor, or sheepdog.",
      prompt: GRAZER_PROMPT,
      permission: {
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        todowrite: "allow",
        edit: "deny",
        apply_patch: "deny",
        herdr_agent_response: "deny",
        ...stateToolPermissions([]),
        ...steeringToolPermissions([]),
        ...rawSteeringToolPermissions([]),
        ...ownershipToolPermissions([]),
        bash: { "*": "deny", ...safeGitInspection, ...separatorDenials },
        task: "deny",
      },
    },

    sheep: {
      mode: "primary",
      model: workerModel,
      ...(workerVariant ? { variant: workerVariant } : {}),
      description:
        "Implements a bounded task, verifies it, and hands a local commit to sheepdog.",
      prompt: SHEEP_PROMPT,
      permission: {
        grep: "allow",
        herdr_agent_response: "deny",
        ...stateToolPermissions([]),
        ...steeringToolPermissions([]),
        ...rawSteeringToolPermissions([]),
        ...ownershipToolPermissions([]),
        bash: {
          "*": "allow",
          ...SHEEP_DENIALS,
          ...separatorDenials,
        },
        task: "deny",
      },
    },

    "shearer-low": reviewerAgent(reviewerModel, "low"),
    "shearer-medium": reviewerAgent(reviewerModel, "medium"),

    developer: {
      mode: "primary",
      description: "Trusted Developer steering submitter; submits bounded steering via /steer; never implements flock work.",
      prompt: DEVELOPER_PROMPT,
      permission: {
        ...stateToolPermissions([]),
        ...steeringToolPermissions([STEERING_TOOLS.submit]),
        ...rawSteeringToolPermissions([]),
        ...ownershipToolPermissions([]),
        herdr_agent_response: "deny",
        task: "deny",
        edit: "deny",
        apply_patch: "deny",
        bash: { "*": "deny", ...separatorDenials },
      },
    },
  };
}

function appendPrompt(prompt, addition, optionName = "shepherdPromptAppend") {
  if (addition === undefined || addition === "") return prompt;
  if (typeof addition !== "string") {
    throw new TypeError(`${optionName} must be a string.`);
  }
  return `${prompt.trimEnd()}\n\n${addition.trim()}`;
}

function reviewerAgent(model, variant) {
  return {
    mode: "primary",
    model,
    variant,
    description: `Independently reviews an implementation with GPT-5.6 Terra ${variant} reasoning.`,
    prompt: SHEARER_REVIEW_PROMPT,
    permission: {
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      edit: "deny",
      apply_patch: "deny",
      todowrite: "deny",
      herdr_agent_response: "deny",
      ...stateToolPermissions([]),
      ...steeringToolPermissions([]),
      ...rawSteeringToolPermissions([]),
      ...ownershipToolPermissions([]),
      bash: { "*": "deny", ...safeGitInspection, ...separatorDenials },
      task: "deny",
    },
  };
}
