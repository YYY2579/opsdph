# Agent Note: Ops capability uses the harness seams, not a single-provider transport

Status: implemented

English | [中文](2026-09-14-ops-capability-seams.zh.md)

## Problem

This fork adds an ops (运维) capability to DeepSeek Harness: a fleet of managed servers the agent reads from and, behind approval, mutates. Two architectures were in tension. The harness ships the single-provider seams `ctx.subprocess`, `ctx.shell`, and `ctx.fs`; a natural reading mounts remote execution on them. But each is a single-provider seam — every composition mounts one implementation, and loading a second fails fast — and they describe *where the agent itself runs*, not *which machines it manages*. Ops faces many targets at once and must not move all execution into one runtime.

The risk policy had to be real, not cosmetic. The task constraint "any mutation asks, and a missing approval never executes" held no weight unless the denial is provable by executing the tool; schema omission, tool descriptions, and prompt text are not enforcement.

## Decision

The ops capability lives in new fork-local packages `packages/ops/common` and `packages/ops/server` and registers only on documented harness extension points: `ctx.tools` for the model-facing tools, `tools/pre-execute` for the risk decision, `ctx.approval` for one-shot authorization, `ctx.spillStore` + `spill-policy` for oversized output, and `ctx.systemPrompt` + session events for reconstructable model-visible context. No upstream package is modified; only the registration points change.

Remote execution does not use `ctx.subprocess`, `ctx.shell`, or `ctx.fs`. The server package owns its own transport over the host OpenSSH client (`ssh.exe`): argument construction bound to `BatchMode=yes`, a retained-output byte ceiling, a hard `timeoutMs`, and `AbortSignal` cancellation. "Where the agent runs" stays on the harness seams; "which machines it manages" stays on this group's own transport. Credentials stay references: the inventory carries `keyRef` paths, never key material, and the model-facing projection omits them.

Risk classification is a pure function `classifyCommandRisk(command, environment)` in `packages/ops/server/src/risk.ts`: a command provably read-only is `L0`; a mutation is escalated by environment (`dev`/`lab` `L1`, `staging` `L2`, `prod` `L3`); destructive patterns are always `L4`. The `tools/pre-execute` listener in the server plugin is the single enforcement point: it relays non-ops tools via `next()`, runs `server_list` / `server_facts` / `server_file_read` through, denies unknown ops tools, and for `server_exec` returns `{ kind: 'ask', reason }` unless the command classifies `L0`. The tool runtime's own `serviceAsk` turns that `ask` into a denial unless the approval service returns `allowed-once`, and degrades to denial when the approval service, answerer, or agent is missing — fail-closed is the registry's behavior, not this plugin's fallback.

Every result is bounded. The transport truncates retained stdout at `maxOutputBytes` and reports `truncated: true`; oversized results flow through the composed `dsh-spill-policy` + `dsh-spill-local` and reach the model as a bounded preview plus a locator. `server_exec` subclassifies mutating commands before execute and never runs a denied call.

## Testing

The suite boots the plugin through the real Loader from `cordis.yml` — no hand-built `ctx.plugin()` fixtures. It covers: inventory listing without credential leaks, the L0–L4 classifier, the approval three-state (approve executes, reject does not, missing answerer fails closed) plus no-agent and unknown-target paths, oversized-result spill, session replay consistency and the `approval/asked`/`approval/decided` pair, and credential-reference absence from model-visible output. An opt-in `tests/e2e-vps.spec.ts` runs the same surface against a real host when `OPS_E2E_HOST` is set.

## Alternatives considered

**Mount remote execution on `ctx.subprocess` / `ctx.shell` / `ctx.fs`.** These are single-provider seams: each composition loads exactly one implementation, and a second fails fast. They answer "where does the agent itself run" — local, E2B, a remote box — not "which machines does this deployment manage," which must address many targets at once. Routing ops through them would collapse all managed execution into the agent's own runtime and break the multi-target inventory. The tasks constraint therefore forbids them for ops execution.

**A JavaScript SSH dependency (`ssh2`).** `ssh2` pulls `cpu-features` / `nan` with install scripts, which `pnpm-workspace.yaml`'s strict `allowBuilds` whitelist rejects without editing upstream files. The system OpenSSH client is zero new dependencies and reuses the user's identities and `known_hosts`.

**Enforcing risk by schema, tool descriptions, or prompt text.** None is provable by executing the tool: a schema omits a field but a direct call still reaches execute, and prompt text is advisory. The `tools/pre-execute` listener returns a decision the registry enforces, so a denial is observable in the executor.

**Enforcing fail-closed in the plugin instead of relying on the registry.** Returning `ask` and letting the tool runtime resolve it keeps one enforcement point. A plugin that re-implements denial would need to duplicate the approval vocabulary and could drift from the registry's cancellation/failure contract.

## Consequences

Model-facing tools get proof: a mutating `server_exec` that a user rejects visibly returns an error, and a composition without an approval service or answerer denies rather than running. The cost is the transport being owned in-repo: argument construction, bounding, timeout, and cancellation are this group's code, not a maintained seam's, and changes to them must pass this group's tests.

Reading risk from free text is a heuristic boundary: the classifier treats anything not provably read-only as a mutation and lets an environment subject the harmless case to a human check rather than risk an unnoticed write. That bias keeps L4 and destructive patterns fail-closed first and documents the boundary in `ops/ARCHITECTURE.md`.

Adding a model-facing ops tool now means three things must move together: register it on `ctx.tools`, classify its risk contribution in the `tools/pre-execute` listener, and project its output without credential references. This is the documented harness model-visible ⟺ logged rule applied to a new seam's products.