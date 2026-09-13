---
description: "Shared ops domain types for the DeepSeek Harness ops capability: target identity, environment, risk level, and result envelopes, for capability authors."
kind: "package-reference"
---

# @deepseek-ai/dsh-ops-common

English | [中文](README.zh.md)

## Summary

`dsh-ops-common` holds the vocabulary every ops capability shares: what a managed target is identified by, which environment it belongs to, how risky an operation is, and how an operation reports success or failure. It owns no service, no tool, and no state; capability packages depend on it so that a server, a container, and a database target all speak one language.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Depend on this package from an ops capability package. Build target identities with `brandServerId` so a server id cannot be passed where another id is expected, narrow configuration values against `ENVIRONMENTS` and `RISK_LEVELS`, and return one `OpsResult` from every operation so callers handle failure uniformly.

## Model Experience

### Inventory and risk vocabulary

#### What the model sees

Nothing directly. The `ServerId`, `Environment`, `RiskLevel`, and `OpsResult` vocabulary shapes the tool schemas and result envelopes that capability packages publish; the model sees those fields only where a capability package includes them.

#### Token effect

None directly.

#### KV Cache effect

None directly.

## Known Limitations and Deferred Work

- **Container, cluster, and database identities are absent** — only `ServerId` exists today; later capabilities add their own branded ids here rather than inventing one per package.
- No runtime invariant companion is published because this package declares shared types and one branding helper, so it owns no runtime relation to check.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above and the package code.

The vocabulary here grows only when a second capability needs the same term. Container, cluster, and database work will decide the next additions; this package does not pre-declare identities nothing consumes yet.

</details>
