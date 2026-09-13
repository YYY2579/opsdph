---
description: "Managed-server inventory and the model-facing server_list tool of the DeepSeek Harness ops capability, for users and maintainers."
kind: "package-reference"
---

# @deepseek-ai/dsh-ops-server

English | [中文](README.zh.md)

## Summary

`dsh-ops-server` gives the agent a named inventory of the servers this deployment manages, so operations address a stable id instead of a hostname the model guessed. The inventory is deployment configuration: each entry declares where the server is, who logs in, which credential reference to resolve, and which environment it belongs to. The package ships only read-only tools; anything that changes a target arrives later and behind approval.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin with the servers it should manage; the tool registry then exposes `server_list`.

```yaml
- name: '@deepseek-ai/dsh-ops-server'
  config:
    servers:
      - id: prod-web-01
        name: Production web 01
        host: 203.0.113.10
        username: deploy
        keyRef: prod-web-01-key
        environment: prod
        tags: [nginx, edge]
```

| Field | Default | Meaning |
|---|---|---|
| `servers` | required | The managed servers this deployment exposes |
| `servers[].port` | `22` | SSH port |
| `servers[].keyRef` | required | Credential reference resolved at connect time; never the secret itself |
| `servers[].tags` | `[]` | Free-form grouping labels |

## Model Experience

### `server_list` results

#### What the model sees

The tool schema and every result field are this package's contribution: `id`, `name`, `host`, `port`, `username`, `environment`, and `tags` for each managed server. The credential reference stays out of the model-facing projection.

#### Token effect

Direct, proportional to the number of managed servers in the result.

#### KV Cache effect

Independent: the tool description is a stable prefix, and results arrive in the request history.

## Known Limitations and Deferred Work

- **Read-only listing only** — connecting to a server, reading facts, reading files, and running commands arrive with the transport package.
- **No inventory persistence** — the inventory is composition configuration; a stored inventory is deferred until a second consumer needs it.
- No runtime invariant companion is published because the inventory is composition configuration resolved once at activation; the package owns no mutable cross-event state to check.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above and the package code.

Remote transport runs through the host's OpenSSH client rather than a JavaScript SSH implementation, because the workspace denies unreviewed dependency build scripts and the host client already holds the user's identities and `known_hosts`. Mutation tools arrive only with the approval path, not before it.

</details>
