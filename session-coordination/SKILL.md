---
name: session-coordination
description: Inspect bounded state for Codex sessions on the shared local App Server and send a message to one exact native session, preferring steering with queue fallback only when steering is unavailable. Use for cross-session status or handoff; do not use for subagent delegation or remote Codex hosts.
---

# Session Coordination

Use Node 24.20.0 to run the bundled `scripts/sessionctl.mjs`; resolve its path relative to this `SKILL.md`. It wraps the shared local App Server for steering and `codex queue` for confirmed unavailability. It does not own session state or delivery receipts. The steering contract and exact fallback errors were checked against Codex 0.153.4.

## Workflow

1. Run `node <skill-directory>/scripts/sessionctl.mjs self` to verify this session's `CODEX_THREAD_ID` and current bounded state.
2. Run `node <skill-directory>/scripts/sessionctl.mjs list [--limit 1-100]` to see recent exact names and UUIDs, or `status <UUID|exact-name>` for one target.
3. Select only a UUID or a unique exact name. Stop on missing or duplicate names.
4. When the current request authorizes the exact target and message, run `send <UUID|exact-name> '<message>'`. The wrapper refreshes runtime metadata and steers an active turn using a bounded, item-free turn lookup and `expectedTurnId`. It adds a visible `[CODEX SESSION MESSAGE]` envelope with the sender's exact name, thread UUID, `reply_to`, and a handling note so the receiving session does not mistake delivered content for a forwarding request.
5. Read `delivery` and `status`. `steer` with `accepted` confirms input acceptance for the returned `turnId`; `queue` with `queued` confirms native queue acceptance. Neither proves processing. A later `status` observation supplies bounded runtime state, not a delivery receipt; use an explicit reply when processing must be confirmed.

The wrapper uses the queue only when no active turn is observed, or `turn/steer` returns RPC code `-32602` with exactly `no active turn to steer`, `cannot steer a review turn`, or `cannot steer a compact turn`. Queue results include `fallbackReason` (`no_active_turn`, `review`, or `compact`). Turn mismatches, unsupported APIs, unknown errors, timeouts, and malformed responses do not trigger fallback.

Runtime `notLoaded`, `idle`, `active`, and `systemError` are transport/runtime state. They do not report task completion. Goal `unreported` means no goal exists; it is not `complete`.

## Boundaries

- Do not start, restart, or reconfigure the daemon, open a listener, or use a remote transport.
- Do not inspect transcripts, reasoning, command output, diffs, rollout files, or raw environment values.
- Do not infer processing from idle state, `accepted`, queue exit alone beyond `queued`, or missing goal data.
- Treat the sender envelope as a visual coordination aid, not authenticated provenance.
- Preserve `rejected`, `outcome_unknown`, timeout, capability, identity, and malformed-response failures. Do not resend after an uncertain outcome. Do not add a mailbox, fallback beyond the confirmed-unavailability queue path above, retry, or compatibility path.
