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

// Constrained orchestration state tools. The shepherd phases author and read
// plan artifacts; the flock's squad lead records and reads execution artifacts.
// This matrix is the single source of truth for both the plugin-level tool
// enforcement (src/index.js) and the per-agent permission entries below.
export const STATE_TOOLS = Object.freeze({
  planWrite: "herdr_plan_write",
  planRead: "herdr_plan_read",
  executionWrite: "herdr_execution_write",
  executionRead: "herdr_execution_read",
});

export const STATE_TOOL_ACCESS = Object.freeze(
  new Map([
    [STATE_TOOLS.planWrite, new Set(["shepherd", "shepherd-governor"])],
    [STATE_TOOLS.planRead, new Set(["shepherd", "shepherd-governor"])],
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

const SHEPHERD_STATE_TOOLS = [STATE_TOOLS.planWrite, STATE_TOOLS.planRead];
const SHEEPDOG_STATE_TOOLS = [STATE_TOOLS.executionWrite, STATE_TOOLS.executionRead];

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
  "herdr worktree create*": "deny",
  "herdr worktree open*": "deny",
  "herdr worktree remove*": "deny",
  "git branch -D*": "deny",
  "git branch -d*": "deny",
  "git commit --no-verify*": "deny",
  "git commit * --no-verify*": "deny",
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
  const sheepdogModel = options.sheepdogModel ?? "litellm/glm-5.3-flash";
  const sheepdogVariant = options.sheepdogVariant;
  const reviewerModel = options.reviewerModel ?? "litellm-responses/gpt-5.6-terra";
  const shepherdPermissions = options.shepherdPermissions ?? {};
  const shepherdPrompt = appendPrompt(SHEPHERD_PROMPT, options.shepherdPromptAppend);

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
        bash: {
          "*": "deny",
          ...herdrInspection,
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
        ...stateToolPermissions(SHEPHERD_STATE_TOOLS),
        bash: {
          "*": "deny",
          ...herdrInspection,
          ...spawnMatrix(GOVERNOR_SPAWNABLE_AGENTS),
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
          "git merge *--no-verify*": "deny",
          "git branch -D*": "deny",
          "git branch -d*": "deny",
          "git worktree remove * --force*": "deny",
          "gh pr create*": "allow",
          "gh pr view*": "allow",
          "gh pr checks*": "allow",
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
        "Leads execution squads of grazer, sheep, and shearers and performs clean local integration with merge and cherry-pick lifecycle commands only.",
      prompt: SHEEPDOG_PROMPT,
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
        bash: {
          "*": "deny",
          ...safeGitInspection,
          ...herdrInspection,
          ...spawnMatrix(SHEEPDOG_SPAWNABLE_AGENTS),
          ...SHEEPDOG_LIFECYCLE_ALLOWS,
          ...SHEEPDOG_DENIALS,
          ...separatorDenials,
        },
        task: "deny",
      },
    },

    grazer: {
      mode: "primary",
      model: workerModel,
      ...(workerVariant ? { variant: workerVariant } : {}),
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
  };
}

function appendPrompt(prompt, addition) {
  if (addition === undefined || addition === "") return prompt;
  if (typeof addition !== "string") {
    throw new TypeError("shepherdPromptAppend must be a string.");
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
      bash: { "*": "deny", ...safeGitInspection, ...separatorDenials },
      task: "deny",
    },
  };
}
