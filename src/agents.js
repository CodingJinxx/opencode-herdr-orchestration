import {
  SHEEP_BUILD_PROMPT,
  SHEEP_PLAN_PROMPT,
  SHEPERD_BUILD_PROMPT,
  SHEPERD_PLAN_PROMPT,
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
};

const markdownOnly = {
  "*": "deny",
  "*.md": "allow",
  "**/*.md": "allow",
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

export function createAgents(options = {}) {
  const workerModel = options.workerModel ?? "litellm/glm-5.3-flash";
  const reviewerModel = options.reviewerModel ?? "litellm-responses/gpt-5.6-terra";

  return {
    "sheperd-plan": {
      mode: "primary",
      description: "Researches and presents implementation-ready plans through sheep-plan workers without implementing them.",
      prompt: SHEPERD_PLAN_PROMPT,
      permission: {
        grep: "allow",
        todowrite: "allow",
        edit: markdownOnly,
        apply_patch: markdownOnly,
        bash: {
          "*": "deny",
          ...herdrInspection,
          "herdr agent start * --kind opencode --pane * -- --agent sheep-plan": "allow",
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
          "git push origin HEAD": "allow",
          "git push -u origin HEAD": "allow",
          "git push --set-upstream origin HEAD": "allow",
          "git commit --no-verify*": "deny",
          "git commit * --no-verify*": "deny",
          "git push *main*": "deny",
          "git push *master*": "deny",
          "git push *:*": "deny",
          "git push *--no-verify*": "deny",
          "git push *--force*": "deny",
          "git push *-f*": "deny",
          "git push *--delete*": "deny",
          "git branch -D*": "deny",
          "git branch -d*": "deny",
          "git worktree remove * --force*": "deny",
          ...separatorDenials,
        },
        task: "deny",
      },
    },

    "sheperd-build": {
      mode: "primary",
      description: "Executes approved plans through planning, implementation, and independent review workers.",
      prompt: SHEPERD_BUILD_PROMPT,
      permission: {
        grep: "allow",
        edit: markdownOnly,
        apply_patch: markdownOnly,
        "ia-forge_deployment_status": "allow",
        "ia-forge_file_logs": "allow",
        "ia-forge_run_preset": "allow",
        "ia-forge_service_control": "allow",
        "ia-forge_service_logs": "allow",
        bash: {
          "*": "deny",
          ...herdrInspection,
          "herdr agent start * --kind opencode --pane * -- --agent sheep-plan": "allow",
          "herdr agent start * --kind opencode --pane * -- --agent sheep-build": "allow",
          "herdr agent start * --kind opencode --pane * -- --agent shearer-review-low": "allow",
          "herdr agent start * --kind opencode --pane * -- --agent shearer-review-medium": "allow",
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

    "sheep-plan": {
      mode: "primary",
      model: workerModel,
      description: "Performs read-only repository research for a sheperd.",
      prompt: SHEEP_PLAN_PROMPT,
      permission: {
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        todowrite: "allow",
        edit: "deny",
        apply_patch: "deny",
        bash: { "*": "deny", ...safeGitInspection, ...separatorDenials },
        task: "deny",
      },
    },

    "sheep-build": {
      mode: "primary",
      model: workerModel,
      description: "Implements a bounded task, verifies it, and hands a local commit to sheperd-build.",
      prompt: SHEEP_BUILD_PROMPT,
      permission: {
        grep: "allow",
        bash: {
          "*": "allow",
          "git push*": "deny",
          "git merge*": "deny",
          "git pull*": "deny",
          "git branch -D*": "deny",
          "git branch -d*": "deny",
          "git rebase*": "deny",
          "git reset*": "deny",
          "git commit *--no-verify*": "deny",
          "git commit --no-verify*": "deny",
          "git *;*": "deny",
          "git *&&*": "deny",
          "git *||*": "deny",
          "git *|*": "deny",
          "git *>*": "deny",
          "git *<*": "deny",
        },
        task: "deny",
      },
    },

    "shearer-review-low": reviewerAgent(reviewerModel, "low"),
    "shearer-review-medium": reviewerAgent(reviewerModel, "medium"),
  };
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
      bash: { "*": "deny", ...safeGitInspection, ...separatorDenials },
      task: "deny",
    },
  };
}
