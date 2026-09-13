---
description: "The ops group map: managed-target inventory and the model-facing operations tools of the DeepSeek Harness fork, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/ops

English | [中文](README.zh.md)

## Summary

The ops group adds operations capability to the harness: a managed-target inventory (servers first, later containers, clusters, and databases) plus the model-facing tools that act on those targets with explicit risk classification and approval. Targets are deployment configuration, and every operation addresses one target by its stable id, so the model never guesses which machine it acts on. The group adds capability packages only and leaves every core package untouched.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`common`](common/README.md) | Shared ops domain types: target identity, environment, risk level, and result envelopes | — |
| [`server`](server/README.md) | Managed-server inventory and the model-facing `server_list` tool | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Ops development document](../../ops/DEVELOPMENT.md) — version freeze, repository constraints, development order, and acceptance criteria.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This group is a fork-local addition and is not part of upstream DeepSeek Harness.

</details>
