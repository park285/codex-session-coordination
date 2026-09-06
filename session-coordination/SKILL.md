---
name: session-coordination
description: Inspect bounded state for Codex sessions on the shared local App Server and queue a message to one exact native session target. Use for cross-session status or handoff; do not use for subagent delegation or remote Codex hosts.
---

# Session Coordination

Use Node 24.20.0 to run the bundled `scripts/sessionctl.mjs`; resolve its path relative to this `SKILL.md`. It wraps the shared local App Server and `codex queue`. It does not own session state or delivery receipts.

## Workflow

1. Run `node <skill-directory>/scripts/sessionctl.mjs self` to verify this session's `CODEX_THREAD_ID` and current bounded state.
2. Run `node <skill-directory>/scripts/sessionctl.mjs list [--limit 1-100]` to see recent exact names and UUIDs, or `status <UUID|exact-name>` for one target.
3. Select only a UUID or a unique exact name. Stop on missing or duplicate names.
4. When the current request authorizes the exact target and message, run `send <UUID|exact-name> '<message>'`. The wrapper adds a visible `[CODEX SESSION MESSAGE]` envelope with the sender's exact name, thread UUID, `reply_to`, and a handling note so the receiving session does not mistake delivered content for a forwarding request.
5. Treat `queued` only as native queue acceptance. Use a later `status` observation or an explicit reply when the task requires evidence of processing.

Runtime `notLoaded`, `idle`, `active`, and `systemError` are transport/runtime state. They do not report task completion. Goal `unreported` means no goal exists; it is not `complete`.

## Boundaries

- Do not start, restart, or reconfigure the daemon, open a listener, or use a remote transport.
- Do not inspect transcripts, reasoning, command output, diffs, rollout files, or raw environment values.
- Do not infer success from idle state, queue exit alone beyond `queued`, or missing goal data.
- Treat the sender envelope as a visual coordination aid, not authenticated provenance.
- Preserve `rejected`, `outcome_unknown`, timeout, capability, identity, and malformed-response failures. Do not add a mailbox, fallback transport, retry, or compatibility path.
