---
name: Checkpoint Plugin Feature
description: OpenClaw checkpoint plugin for workspace state snapshots and rollback, integrated with NFS storage system research
type: project
---

OpenClaw checkpoint feature implemented as `extensions/checkpoint/` plugin (iteration 1, local single-agent).

**Why:** User is doing a storage system + OpenClaw integration research project. NFS-mounted storage provides persistence, checkpoint plugin saves agent workspace state at each tool execution step, enabling rollback on errors.

**How to apply:**
- Iteration 2 planned: multi-agent sandbox support, COW storage backend, multi-lane timeline visualization
- The plugin is fully decoupled from OpenClaw core (zero core modifications), uses hooks + tool registration
- WorkspaceResolver pattern bridges tool context (has workspaceDir) and hook context (doesn't)
- Git commit-tree approach creates detached commits without branch switching
- Restore supports `--scope files|transcript|all`
- 42 tests across 4 test files, build and format verified
