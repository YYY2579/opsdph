# DeepSeek Harness — Ops Fork（运维二开版）

English | [中文](README.zh.md)

This repository is a private secondary-development (二开) fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

It is frozen at upstream commit `c291e7961a515f6d7af9304e7fd1d257929aef26` (`0.1.5-rc.2`) and does not track upstream; any upgrade is a deliberate, gated act (see [ops/DEVELOPMENT.md](ops/DEVELOPMENT.md)).

## What this fork adds

The fork adds an ops (运维) capability as new plugin packages under `packages/ops`, without modifying any upstream package:

- `packages/ops/common` — shared ops types: target identity, environment, risk level, result envelopes.
- `packages/ops/server` — managed-server inventory and model-facing tools:
  - `server_list` / `server_facts` / `server_file_read` — read-only, run automatically.
  - `server_exec` — risk-gated: L0 read-only commands run automatically; L1 and above ask through the approval seam, and a missing approval fails closed.
- Remote transport is the host OpenSSH client; credentials stay references, never values.

## Documentation

- [ops/SETUP.md](ops/SETUP.md) — local environment, proxy, credentials, known issues
- [ops/DEVELOPMENT.md](ops/DEVELOPMENT.md) — version freeze, repository constraints, development order, acceptance
- [ops/TASKS.md](ops/TASKS.md) — full task checklist and current progress
- [ops/ARCHITECTURE.md](ops/ARCHITECTURE.md) — the harness extension points the ops capability uses, and the ones it does not
- [ops/ROADMAP.md](ops/ROADMAP.md) — planned capabilities and their acceptance
- [packages/ops/AGENTS.md](packages/ops/AGENTS.md) — hard rules for changing this group's code

The upstream harness documentation remains in `docs/` for reference.

## Run from source

```sh
git clone https://github.com/YYY2579/opsdph.git deepseek-harness
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses the built artifacts without rebuilding.

## Development

Start with [ops/DEVELOPMENT.md](ops/DEVELOPMENT.md) and [ops/ARCHITECTURE.md](ops/ARCHITECTURE.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
