# Agent Checkpoint — Design Document

> Automatic checkpoint and rollback for long-running agent tasks.
> OpenClaw Plugin · Phase 1 · 2026-04-07

---

## 1. Problem

Long-running agent tasks (code generation, multi-step refactoring, data processing) can fail midway or produce undesirable results. Without checkpoints, the only recovery path is starting over. Agents need the ability to:

- Snapshot workspace state at key moments
- Roll back to a known-good state when things go wrong
- Inspect the history of changes across a session

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   OpenClaw Plugin SDK                │
│  hooks: after_tool_call, session_start               │
│  tool: checkpoint (list / create / restore)          │
│  command: /checkpoint (list / create / restore /     │
│           timeline / timeline-stop)                  │
│  service: pruning (background, every 6h)             │
└──────────────┬──────────────────────┬───────────────┘
               │                      │
        ┌──────▼──────┐        ┌──────▼──────┐
        │   Engine    │        │  Timeline   │
        │ (orchestr.) │        │  Server     │
        └──┬──────┬───┘        │  (HTTP UI)  │
           │      │            └─────────────┘
    ┌──────▼──┐ ┌─▼────────┐
    │  Store  │ │ Snapshot  │
    │ (meta)  │ │ Backend   │
    └─────────┘ └───────────┘
```

### Module Responsibilities

| Module | Responsibility | Depth |
|--------|---------------|-------|
| `snapshot-backend.ts` | Interface definition + factory | Deep — 4-method interface hides all physical snapshot mechanics |
| `copy-backend.ts` | Phase 1 implementation: `fs.cp` with atomic writes | Deep — exclude patterns, tmp+rename atomicity, recursive diff |
| `store.ts` | Checkpoint metadata persistence (JSON on disk) | Deep — manifest management, session queries, coordinated pruning |
| `engine.ts` | Orchestration of backend + store operations | Medium — coordinates create/restore/prune, manages parent chain |
| `hooks.ts` | Auto-checkpoint on tool calls and session start | Thin — glue between SDK events and engine |
| `tool.ts` | Agent-facing tool (list/create/restore) | Thin — input validation + engine dispatch |
| `command.ts` | `/checkpoint` slash command | Thin — CLI-style interface to engine + timeline server |
| `config.ts` | Configuration parsing with safe defaults | Medium — validates and normalizes all user config |
| `timeline-server.ts` | HTTP server + inline SPA for checkpoint visualization | Deep — REST API + full dark-themed timeline UI |
| `pruning-service.ts` | Background cleanup of expired checkpoints | Shallow — wraps setInterval for SDK service contract |
| `types.ts` | Shared type definitions | N/A — pure types |

## 3. Key Design Decisions

### 3.1 SnapshotBackend Interface — Decoupled from Implementation

The core abstraction. All snapshot operations go through 4 methods:

```typescript
interface SnapshotBackend {
  createSnapshot(params)  → SnapshotResult
  restoreSnapshot(params) → void
  diffSnapshot(params)    → string
  deleteSnapshot(ref)     → void
}
```

**Why:** Phase 1 uses `fs.cp` (simple file copy). Future phases can swap in btrfs snapshots, ZFS, or remote storage without changing any other module. The `snapshotRef` return value is an opaque string — only the backend knows how to interpret it.

**Trade-off:** The factory currently uses dynamic `import()` for the backend module. This is intentional — it allows future backends to be loaded lazily without bundling unused code.

### 3.2 excludePatterns — Backend-Private, Not Global Config

Exclude patterns (`.git`, `node_modules`, `.DS_Store`) are `CopyBackend` constructor parameters, not part of the global plugin config. Global config only has `backendType` + `backendConfig: Record<string, unknown>`.

**Why:** Different backends have fundamentally different exclusion semantics. A btrfs backend might exclude by subvolume mount points. A remote backend might use `.gitignore`-style rules server-side. Making this a backend-private parameter prevents information leakage.

### 3.3 Engine Only Orchestrates

The Engine does NOT own queries. `store.listCheckpoints()` and `store.listSessions()` are called directly by tool/command/timeline-server.

Engine only owns operations that require **coordination between backend and store**:
- `createCheckpoint` — snapshot + metadata + parent chain + prune
- `restoreCheckpoint` — restore files + truncate transcript + trim manifest
- `getCheckpointDiff` — resolve parent from store, delegate diff to backend
- `pruneOld` — iterate store, delete from both store and backend

**Why:** Routing pure reads through Engine would make it a pass-through layer (Red Flag: pass-through method). Callers that only need metadata should not depend on the snapshot backend.

### 3.4 Workspace Directory Cache

The SDK's `PluginHookToolContext` does not expose `workspaceDir`. The tool factory context does. Solution: cache `workspaceDir` by `agentId` in a module-level `Map` when the tool is instantiated, then read it from hooks.

```typescript
// hooks.ts
const workspaceDirs = new Map<string, string>();
export function cacheWorkspaceDir(ctx) { ... }
export function getCachedWorkspaceDir(agentId) { ... }
```

**Why:** This is a workaround for an SDK limitation. The cache is scoped to the plugin process lifetime, which matches agent session lifetime. If the SDK adds `workspaceDir` to hook contexts in the future, this cache can be removed.

### 3.5 Error Handling — Define Errors Out of Existence

Following Ousterhout's principle:

- `deleteSnapshot` is **idempotent** — deleting a nonexistent snapshot silently succeeds
- `resolveConfig` **never throws** — invalid config values fall back to safe defaults
- Hook failures are **caught and logged** — a checkpoint failure should never crash the agent
- `restoreSnapshot` **does throw** for missing snapshots — the caller needs to know the restore failed

### 3.6 Metadata Layout

```
<storagePath>/
├── meta/<agentId>/<sessionId>/           # CheckpointStore
│   ├── manifest.json                     # ordered checkpoint list + currentHead
│   └── <checkpointId>/meta.json          # full CheckpointMeta
└── snapshots/<checkpointId>/             # CopyBackend
    └── (full workspace copy)
```

Metadata and snapshots are deliberately stored in separate directory trees. This allows a future backend to store snapshots remotely while metadata stays local.

## 4. Data Model

```typescript
type CheckpointMeta = {
  id: CheckpointId;              // ULID — sortable, unique
  parentId: CheckpointId | null; // links to previous checkpoint
  sessionId: string;
  agentId: string;
  runId: string;
  trigger: {
    type: "after_tool_call" | "manual" | "session_start";
    toolName?: string;
    toolCallId?: string;
  };
  snapshot: {
    backendType: string;         // "copy" (Phase 1)
    snapshotRef: string;         // opaque backend reference
    filesChanged: string[];      // relative paths
    changeSummary?: string;
  };
  transcript: {
    messageCount: number;
    byteOffset: number;          // for transcript truncation on restore
  };
  createdAt: string;             // ISO 8601
  toolDurationMs?: number;
  toolResult?: { success: boolean; errorMessage?: string };
};
```

## 5. User Interface

### 5.1 Agent Tool

The `checkpoint` tool is exposed to agents with three actions:

| Action | Parameters | Description |
|--------|-----------|-------------|
| `list` | — | Show all checkpoints in the current session |
| `create` | — | Create a manual checkpoint |
| `restore` | `checkpoint_id`, `scope?` | Restore to a checkpoint (scope: files, transcript, all) |

### 5.2 Slash Command

```
/checkpoint list                          # list checkpoints
/checkpoint create [label]                # manual checkpoint with optional label
/checkpoint restore <id> [scope]          # restore to checkpoint
/checkpoint timeline [port]               # start HTTP timeline viewer
/checkpoint timeline-stop                 # stop timeline viewer
```

### 5.3 Timeline Viewer

A local HTTP server serving a single-page dark-themed UI:

- **Session selector** — browse all agent sessions
- **Timeline** — vertical timeline with color-coded nodes (tool call / manual / session start / error)
- **Detail panel** — checkpoint metadata, file change list, and diff view
- **Responsive** — works on desktop and mobile

API endpoints:
- `GET /api/sessions` — list all sessions
- `GET /api/sessions/:agentId/:sessionId/checkpoints` — list checkpoints
- `GET /api/sessions/:agentId/:sessionId/checkpoints/:id/diff` — get diff

## 6. Auto-Checkpoint Behavior

| Event | Behavior |
|-------|----------|
| `session_start` | Create baseline checkpoint (if workspace cached) |
| `after_tool_call` | Create checkpoint unless tool is in `excludeTools` list |
| Manual `/checkpoint create` | Always creates checkpoint |

Default excluded tools: `read`, `glob`, `grep`, `memory_search`, `memory_get` (read-only tools that don't modify workspace).

## 7. Configuration

```jsonc
// openclaw.plugin.json → pluginConfig, or user config
{
  "enabled": true,
  "storagePath": "~/.openclaw/checkpoints",
  "backendType": "copy",
  "backendConfig": {
    "excludePatterns": [".git", "node_modules", ".DS_Store"]
  },
  "triggerOn": "mutating_tools",     // "all_tools" | "mutating_tools" | "manual"
  "excludeTools": ["read", "glob", "grep"],
  "maxCheckpointsPerSession": 200,
  "retentionDays": 30,
  "restoreDefaultScope": "all"       // "files" | "transcript" | "all"
}
```

All fields are optional. Invalid values fall back to safe defaults.

## 8. Known Limitations & Future Work

### Phase 1 Limitations
- **Full copy per checkpoint** — disk usage grows linearly. No deduplication.
- **No incremental snapshots** — every checkpoint copies the entire workspace.
- **File-level diff only** — no content-level diff (just lists changed files by size/mtime).

### Planned Improvements
- **Phase 2: Incremental backend** — btrfs/ZFS snapshots or content-addressable storage
- **Phase 2: Remote backend** — store snapshots on a remote server for cross-machine restore
- **Timeline viewer enhancements** — restore button in UI, real-time auto-refresh, content diff view

### Design Debt (from Ousterhout review)
1. `snapshotRef` opacity could be stronger (prefix with backend type)
2. `createCheckpoint` couples creation with pruning — could decouple
3. Hooks repeat parameter extraction — could extract shared helper
4. `pruning-service.ts` is a shallow module — could inline

These are minor and tracked for future refactoring.

## 9. Testing

41 integration tests using real filesystem operations:

| Suite | Tests | Coverage |
|-------|-------|----------|
| CopyBackend | 12 | create, exclude, parent diff, restore, preserve excluded, idempotent delete |
| CheckpointStore | 11 | manifest CRUD, checkpoint save/get/list/delete, session queries |
| CheckpointEngine | 8 | orchestration, parent chain, tool filtering, restore + manifest trim, prune |
| TimelineServer | 5 | HTML serving, REST API endpoints, error handling |

Run: `npx vitest run --config vitest.extension-agent-checkpoint.config.ts`
