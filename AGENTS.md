# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, etc.) working in this repository.

You are working fully unattended. The owner is away and will not answer questions, so never block waiting for input.

## Operating rules
- Never use AskUserQuestion or end a turn with a question. When a decision is ambiguous, pick the most reasonable option, write down the choice and why in `DECISIONS.md`, and continue.
- Do not stop after one task. When you finish something, pick the next item from `BACKLOG.md` and keep going.
- If a tool call is denied or a command fails, don't retry it unchanged. Try another approach, or log it in `BLOCKED.md` and move to other work.
- If you hit a rate or usage limit, or need to wait on something long-running, use `/loop` or `ScheduleWakeup` to resume later. Don't end the session.
- Commit small, working increments often with clear messages, so progress survives if the session is reclaimed. If a git remote is configured, push to a feature branch (never to main/default).

## Safety boundaries (these override "keep going")
- Never delete or overwrite files you didn't create in this session.
- No outward-facing actions: no PRs, issues, comments, emails, messages, publishing, purchases, or calls to paid APIs. Leave drafts in the workspace instead.
- No secrets in code or commits. Don't change environment or system configuration beyond installing dev dependencies.

## What to work on
Build small, genuinely useful, self-contained things the owner could plausibly use. Good candidates:
- CLI tools and scripts that automate tedious tasks (file organization, data conversion, log analysis)
- Small libraries with tests and a README
- Reference docs or cheat sheets on practical topics, checked against real sources
- Templates and boilerplates (project scaffolds, CI configs, dotfiles)

Prefer finished-and-tested over ambitious-and-half-done. Each project goes in its own directory under `projects/<name>/` at the root of this repository (so it is committed and survives the session) with a README covering what it is, how to run it, and its limitations. It needs tests or a demo run that actually passes.

## Bookkeeping (keep updated as you go)
All bookkeeping files live at the repository root.
- `BACKLOG.md`: a prioritized list of ideas. Seed it with 10+ ideas first, then work top-down, adding new ideas as they come up.
- `PROGRESS.md`: a running log with timestamp, what was done, status, and where it lives.
- `DECISIONS.md` and `BLOCKED.md`, as described above.
- When you wrap up a work block, write `SUMMARY.md`: the most useful things built, how to try each in one command, and what the owner should review first.

## Getting started
If the bookkeeping files don't exist yet: create them, seed the backlog, and begin the top item. Otherwise, read `PROGRESS.md` and `BACKLOG.md` and resume from where the last session left off.
