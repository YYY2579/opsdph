# AGENTS.md — Ops capability group

These rules supplement the repo-wide [conventions](../../AGENTS.md) and [package rules](../AGENTS.md). This group is a fork-local addition; it is not part of upstream DeepSeek Harness. Planning documents live in [`ops/`](../../ops/DEVELOPMENT.md).

## Boundaries

- **Add here, do not edit upstream.** A new capability is a new package under `packages/ops/`. Do not modify `core/`, `shell/`, `fs/`, `subprocess/`, `interaction/`, `client/`, or `apps/` logic. Only these registration points change: `tsconfig.host.json` references, the hand-written source aliases in `tsconfig.base.json`, `packages/README.md` + `README.zh.md`, and `scripts/verify-subsystem-pages.ts`; `docs/module-graph.*` is regenerated, never hand-edited.
- **Do not execute through `ctx.subprocess`, `ctx.shell`, or `ctx.fs`.** Each is a single-provider seam — loading a second provider fails fast — and they serve where the agent itself runs, not which machines it manages. Remote execution goes through this group's own transport.

## Extension points

Use the documented seams only: `ctx.tools` for registration, `tools/pre-execute` for the risk decision, `ctx.approval` for one-shot authorization, `ctx.spillStore` for oversized output, `ctx.systemPrompt` for model-visible runtime context, `ctx.storage` for durable inventory. Registrations are effects: contribute through `ctx.effect()` or `ctx.on()` and return the disposer.

## Safety

- Every operation carries a `RiskLevel`: L0 read-only runs automatically; L1 and above ask. A missing or failing answerer means **do not execute** — never fall back to running it.
- The decision belongs to the operation that makes it. Schema omission, tool descriptions, and prompt text are not enforcement; a denial must be provable by executing the tool.
- Credentials stay references. No private key, password, or token enters configuration values, tool results, session events, or logs. The model-facing projection of a target omits its credential reference.
- Bound every result: bytes, lines, rows, and time. When a result is truncated, say so in the result the model receives.

## Conventions

- Package name `@deepseek-ai/dsh-ops-<role>`, directory `packages/ops/<role>`; `version` matches the root; `type: module`; `files` is exactly `["lib/index.js", "lib/types/**/*.d.ts"]` unless the package publishes another runtime artifact.
- Every dsh package used is a `peerDependencies` entry mirrored in `devDependencies`; `@deepseek-ai/cordis` is always both.
- `src/types.ts` holds types only. Tests live in `tests/`, not beside sources.
- Deployment-varying choices are validated `Config` fields, never constants.
- Opaque ids are branded through `@deepseek-ai/dsh-ops-common`; never pass a bare string where a target id is expected.
- Anything that reaches a model request must be reconstructable from the session log.

## Verification

Run, in order: `pnpm run constraints`, `pnpm exec vitest run packages/ops`, `pnpm run typecheck`. A product-visible plugin needs a real Loader composition test booting `cordis.yml`, not a hand-built `ctx.plugin()` suite. Report only the checks actually run.
