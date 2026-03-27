# OpenClaw Checkpoint Feature - Implementation Plan

## Context

This feature adds a checkpoint system to OpenClaw, enabling automatic state snapshots at each agent tool execution step. The motivation is a storage system research project: NFS-mounted storage provides the persistence layer, OpenClaw provides the agent runtime. Checkpoints allow rollback to any previous step on errors, then resume from that point.

**Industry context**: Cursor auto-creates checkpoints before every AI edit (stored locally, separate from git). Codex CLI is developing a `/rewind` feature. LangGraph saves state at every step with time-travel debugging. VastData AgentEngine provides stateful scratch space with Kafka-backed durability.

---

## Architecture Decision

### Trigger: Option A+B Hybrid (Plugin with Hooks) - Recommended

Create a checkpoint **extension plugin** (`extensions/checkpoint/`) that registers hooks into OpenClaw's existing hook infrastructure. This requires **zero modifications to OpenClaw core**, following the `extensions/diffs/` pattern.

**Why not Option C (core mod)?** CLAUDE.md explicitly requires decoupling. The plugin hook system already provides `after_tool_call`, `before_tool_call`, `session_start`, `session_end` with full context (agentId, sessionId, runId, toolCallId, workspaceDir).

### Storage: Option 2 (Git-based) for Iteration 1

Use `git commit-tree` to create detached commit objects capturing workspace state at each checkpoint. No branch switching needed, safe for concurrent use.

**Why not Option 1 (full copy)?** Too much disk waste. **Why not Option 3 (custom COW)?** Too complex for iteration 1; can be added in iteration 2 for NFS-optimized performance.

---

## Iteration 1 Scope (Local Single-Agent)

### NFS Mount Directory Structure

```
<mount-root>/                              # NFS mount point (configurable)
  openclaw/
    workspaces/<agent-id>/                 # Agent workspace (git repo)
    checkpoints/<agent-id>/<session-id>/
      manifest.json                        # Checkpoint chain for this session
      <checkpoint-id>/
        meta.json                          # Checkpoint metadata
        files-changed.json                 # Files modified at this step
    sessions/<agent-id>/
      <session-id>.jsonl                   # Session transcript mirror
    logs/
      checkpoint-plugin.log
```

OpenClaw config points `workspaceDir` and session paths to the NFS mount. The checkpoint plugin stores its metadata alongside.

### Checkpoint Data Model

```typescript
// extensions/checkpoint/src/types.ts
type CheckpointMeta = {
  id: string;                    // ULID (sortable)
  parentId: string | null;
  sessionId: string;
  agentId: string;
  runId: string;
  trigger: {
    type: "after_tool_call" | "manual" | "session_start";
    toolName?: string;
    toolCallId?: string;
  };
  git: {
    commitSha: string;           // Detached commit via git commit-tree
    treeSha: string;             // Tree object SHA
    filesChanged: string[];
    diffStat?: string;
  };
  transcript: {
    messageCount: number;
    byteOffset: number;          // JSONL byte offset for fast restore
  };
  createdAt: string;             // ISO 8601
  toolDurationMs?: number;
  toolResult?: { success: boolean; errorMessage?: string; };
};

type CheckpointManifest = {
  sessionId: string;
  agentId: string;
  checkpoints: string[];         // Ordered checkpoint IDs
  currentHead: string;
};
```

### Plugin File Structure

```
extensions/checkpoint/
  openclaw.plugin.json            # Plugin manifest + config schema
  package.json
  api.ts                          # Barrel: re-export from openclaw/plugin-sdk/checkpoint
  index.ts                        # definePluginEntry - main registration
  src/
    types.ts                      # CheckpointMeta, CheckpointManifest
    config.ts                     # Config schema + defaults
    store.ts                      # CheckpointStore: read/write metadata to disk
    git-backend.ts                # Git operations: commit-tree, read-tree, diff
    checkpoint-engine.ts          # Core logic: create, restore, list, prune
    hooks.ts                      # Hook registrations (after_tool_call, session_start)
    tool.ts                       # Agent-facing checkpoint tool
    http.ts                       # HTTP handler for visualization API + static assets
    prune.ts                      # Retention/cleanup policy
    viewer/
      index.html                  # Timeline visualization SPA
      app.ts                      # Timeline UI logic
      styles.css
    *.test.ts                     # Colocated tests
```

### Key Reference Files (existing code to follow)

| File | Why |
|------|-----|
| `extensions/diffs/index.ts` | Reference plugin pattern: definePluginEntry, registerTool, registerHttpRoute, on() hooks |
| `extensions/diffs/openclaw.plugin.json` | Plugin manifest schema reference |
| `extensions/diffs/src/store.ts` | Artifact store pattern to follow |
| `extensions/diffs/src/http.ts` | HTTP handler + static viewer pattern |
| `src/plugins/types.ts:1402-1492` | Hook names, `PluginHookAgentContext` (has workspaceDir) |
| `src/agents/pi-embedded-subscribe.handlers.tools.ts` | Where `after_tool_call` fires with event data |
| `src/plugin-sdk/plugin-entry.ts` | `definePluginEntry` API |

### Checkpoint Creation Flow

1. **`session_start` hook** fires -> create initial checkpoint (baseline state)
2. **`after_tool_call` hook** fires with `{ toolName, params, result, error, durationMs }` + context `{ agentId, sessionId, runId, workspaceDir }`
3. **Filter**: Skip read-only tools (configurable `excludeTools` list; default skip: `read`, `glob`, `grep`, `memory_search`)
4. **Git snapshot**:
   ```bash
   git add -A
   TREE=$(git write-tree)
   PARENT=$(cat .openclaw-checkpoint-parent || git rev-parse HEAD)
   COMMIT=$(git commit-tree $TREE -p $PARENT -m "ckpt:<id> after <tool>")
   echo $COMMIT > .openclaw-checkpoint-parent
   git reset  # unstage without touching working tree
   ```
   This creates a chain of detached commits without affecting HEAD or branches.
5. **Metadata write**: Save `meta.json` + update `manifest.json`
6. **Transcript offset**: Record current JSONL file size as byte offset

### Restore/Rollback Flow

Restore 支持可选策略，通过 `--scope` 参数控制：

- `--scope files` — 仅回滚工作区文件
- `--scope transcript` — 仅回滚对话历史
- `--scope all` (默认) — 文件 + 对话历史都回滚

**Steps:**
1. Load target checkpoint's `meta.json`
2. **文件回滚** (if scope includes files): `git read-tree <commit-sha> && git checkout-index -a -f && git clean -fd`
3. **对话回滚** (if scope includes transcript): Truncate session JSONL to recorded byte offset
4. Update manifest's `currentHead`
5. Log restoration event

### Visualization UI

HTTP routes served at `/plugins/checkpoint/`:

```
GET  /api/sessions                     # List sessions with checkpoints
GET  /api/sessions/:sessionId          # List checkpoints for a session
GET  /api/checkpoints/:id              # Checkpoint detail
GET  /api/checkpoints/:id/diff         # Git diff at this checkpoint
POST /api/checkpoints/:id/restore      # Trigger restore
GET  /                                 # Serve HTML viewer
```

**UI**: Vertical timeline with checkpoint nodes showing:
- Timestamp + tool name
- Files changed count + diff stat
- Success/error indicator
- Click to expand: full diff, transcript excerpt, "Restore" button

### Plugin Config Schema

NFS 路径通过插件 config 的 `storagePath` 字段指定。

```json
{
  "enabled": true,
  "storagePath": "/mnt/nfs/openclaw/checkpoints",
  "triggerOn": "mutating_tools",
  "excludeTools": ["read", "glob", "grep", "memory_search", "memory_get"],
  "maxCheckpointsPerSession": 200,
  "retentionDays": 30,
  "restoreDefaultScope": "all"
}
```

---

## Iteration 2 Scope (Multi-Agent Sandbox)

- Each sub-agent gets own checkpoint chain keyed by `(agentId, sessionId)`
- Hook into `subagent_spawning`, `subagent_ended` for lifecycle awareness
- "Group checkpoint": snapshot of all agents' latest checkpoint IDs at coordination points
- COW storage backend (using `COPYFILE_FICLONE` for reflink-capable FS)
- Multi-lane timeline visualization for parallel agent execution
- Sandbox isolation: each agent's workspace as separate NFS subdirectory

---

## Implementation Steps (Iteration 1)

### Step 1: Scaffold the plugin
- Create `extensions/checkpoint/` directory structure
- Write `openclaw.plugin.json`, `package.json`, `api.ts`, `index.ts`
- Follow `extensions/diffs/` pattern exactly

### Step 2: Core engine
- Implement `types.ts`, `config.ts`
- Implement `store.ts` (metadata CRUD to filesystem)
- Implement `git-backend.ts` (commit-tree, read-tree, diff)
- Implement `checkpoint-engine.ts` (create, restore, list, prune orchestration)
- Write unit tests for each module

### Step 3: Hook integration
- Implement `hooks.ts`: register `after_tool_call` and `session_start` hooks
- Wire filtering logic (tool name exclusion, `triggerOn` mode)
- Test hook triggering with mock hook runner

### Step 4: Agent tool + CLI
- Implement `tool.ts`: agent can call `checkpoint list`, `checkpoint restore <id>`
- Implement CLI subcommands (if plugin CLI registration is supported)

### Step 5: Visualization UI
- Implement `http.ts` with API endpoints
- Build `viewer/` static SPA (vanilla JS or Preact)
- Timeline rendering, checkpoint detail panel, restore button

### Step 6: NFS integration + testing
- Document NFS mount setup and OpenClaw config
- Integration test: full flow in temp git repo
- Test on NFS-mounted directory

---

## Verification Plan

1. **Unit tests**: `pnpm test -- extensions/checkpoint/`
2. **Integration test**: Create temp git repo, register plugin, simulate tool calls, verify checkpoint chain, restore to earlier checkpoint, verify file state matches
3. **Manual test**: Enable plugin in local OpenClaw, run an agent task, browse checkpoints via web UI, restore to a checkpoint mid-session
4. **NFS test**: Mount NFS directory, configure `storagePath`, verify checkpoints persist and are readable from another machine
5. **Build check**: `pnpm build` must pass (plugin follows standard extension build)

---

## Design Decisions (Confirmed)

1. **回滚范围**: 可选策略 — restore 命令支持 `--scope files|transcript|all` 参数
2. **可视化 UI**: 插件内置 HTTP 路由 (`/plugins/checkpoint/`)，跟随 diffs 插件模式
3. **触发方式**: 自动 (after_tool_call hook) + 手动 (agent tool) 都支持
4. **NFS 配置**: 通过插件 config `storagePath` 字段指定路径
