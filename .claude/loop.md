# Autonomous loop profile — claude-opencode-bridge

This file supplies the project-specific values for the `loop-ticket` skill, as an instance of the loop-profile contract. It **fills gaps only**: on any conflict the **skill's own rules win**, and a missing required slot hard-fails the loop.

## Required (hard-fail if absent)

- **issue-system:** github
- **repo:** `gdanov/claude-opencode-bridge`
- **state mechanism:** the issue's own **labels** — no GitHub Projects board covers this repo, so state is one label on the issue; the loop removes the previous state label when it applies the next one.
  - **state.ready** (input — the loop picks up from here): `loop:ready`
  - **state.working** (claimed / in flight): `loop:working`
  - **state.handoff** (the loop's stop point): `loop:review`
- **board ids:** none — the tracker is plain GitHub issues, whose write path needs no opaque ids.

## Markers (issue labels)

- **claim / heartbeat:** `agent-active`
- **park — needs human:** `needs-decision` (also assign the issue to the human)
- **hold — loop must skip:** `loop-hold`

Markers are orthogonal to the state label: a claim applies `agent-active` and `loop:working` together, and the handoff removes `agent-active`.

## Work recipe

- **build:** the `implement` skill.
- **gate:** `bun run typecheck && bun test` — exit 0 is green. `typecheck` is `tsc --noEmit`; `test` is `bun test` over `test/`.
- **review:** the `adversarial-review` skill; its grounding spec is the issue body.
- **fix:** the `implement` skill, fed the open PR threads. **Do not use `fix-pr-comments`.**
- **max review rounds:** 3.
- **end-of-loop diagnostics:** `off`.

## Review comments (GitHub, bot-authored)

- **Post inline findings:** `clanky-gh api repos/gdanov/claude-opencode-bridge/pulls/<n>/reviews` with a `comments[]` array.
- **List unresolved threads:** GraphQL `reviewThreads` via `clanky-gh api graphql`, filtering `isResolved == false && isOutdated == false` (fallback: `clanky-gh api repos/gdanov/claude-opencode-bridge/pulls/<n>/comments`).
- **Resolve a thread:** GraphQL `resolveReviewThread(threadId)` via `clanky-gh api graphql`.

## VCS

- **default-branch:** `main`.
- **worktrees:** under `.claude/worktrees/`, one per issue; branch name `issue-<n>-<short-slug>`; issue number in the commit subject and in the PR body via `Closes #<n>`.
- **review-request host + tooling:** GitHub via `clanky-gh` (`clanky-gh pr create`, `clanky-gh pr comment`; thread tooling per §"Review comments").
- **draft / ready signal:** `clanky-gh pr create --draft …` to open; `clanky-gh pr ready <n>` at the clean handoff. A park leaves it draft.
- **PR / review-thread author:** the **bot** (`clanky-clanq[bot]`, see Identity).
- **push remote:** `origin` = `git@github.com:gdanov/claude-opencode-bridge.git` (GitHub only).

## Dependencies & preconditions

- **formal-dependency convention:** an issue is blocked when its body lists `Depends on #<n>` that is still open.
- **precondition convention:** stated in the issue body.

## Identity (the loop acts as this account)

- **bot:** `clanky-clanq[bot]` — GitHub App `clanky-clanq`, App ID `4131607`. Issue comments, labels, assignments, and PRs/threads go out as the bot.
- **resume-trigger identity:** a comment authored by **not-`clanky-clanq[bot]`**.

## Access

- **bot (issues / PRs / comments / labels):** `clanky-gh <gh args>`; clients that need a raw token use `clanky-gh-token`. The App key is `~/.config/claude-opencode-bridge/clanky-github.pem` (or `CLANKY_GITHUB_KEY`), **never in the repo**. The App installation covers `gdanov/claude-opencode-bridge`.
- **branch push:** plain `git push origin <branch>` over the operator's git transport. The bot token is not the git transport; it authors the PR + threads via the API after the push.
- **state (read/write):** the state is an issue label, which the bot writes directly (`clanky-gh issue edit <n> --add-label` / `--remove-label`) — no board principal is involved.

## Worker dispatch facts

- **Runtime proof must load the worktree's plugin, not the primary checkout's.** The live plugin is the symlink `~/.config/opencode/plugins/claude-bridge` → the primary checkout. Never repoint that symlink and never edit `~/.config/opencode` — it is the operator's live environment. Prove behaviour with `opencode run --standalone --model <ref>` driven from a throwaway project whose config loads the worktree plugin by absolute path (`plugins: [{ package: "<worktree>" }]`), and check the run really loaded it (a hook only the worktree defines fires). Do not pass `--auto`: the auto-mode classifier blocks it. Instead, the probe project's `opencode.json` grants only what the probe needs; the #3 probe used `permissions: [{ action, resource: "*", effect: "allow" }]` entries for the actions `shell`, `bash`, and `task`. Run it with `XDG_CONFIG_HOME` pointed at an empty directory so the operator's global bridge does not load alongside the worktree's (the probe's own `PreToolUse` hook logging one line per tool call confirms a single instance); auth lives in the data directory and is unaffected. The #3 probe also pointed `CLAUDE_CONFIG_DIR` at an empty directory, which keeps the operator's user hooks and installed plugin hooks (including `mutagen-git`) out of the run; leave it unset when the probe should run them.
- **A real model call is required.** Hooks and tool calls only happen inside a real `opencode run`; `opencode models` lists what the operator's auth already provides. The `--standalone` flag runs a private server, so the background service and its sessions are untouched.
- **Project hooks are read from `<project>/.claude/settings.json`,** not from a `hooks` key in `opencode.json`; the bridge's `collectHooks` merges user settings, project `settings.json`, and installed plugin hooks. A probe project can therefore define its own `PreToolUse` hook there, and the operator's installed `mutagen-git` hook runs alongside it.
- **Hook input is written to the child's stdin as one JSON object;** a probe hook that logs its stdin is the cheapest way to see `cwd`, `tool_name`, and the agent fields.
