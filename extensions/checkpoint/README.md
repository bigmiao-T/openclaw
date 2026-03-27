# OpenClaw Checkpoint Plugin

Automatic workspace state snapshots and rollback for OpenClaw agent sessions.

## Overview

The Checkpoint plugin captures workspace state at each agent tool execution step, creating a chain of recoverable snapshots. When something goes wrong, you can roll back to any previous checkpoint — restoring both files and conversation history.

**Key features:**

- Automatic checkpoints after every mutating tool call (edit, write, bash, etc.)
- Manual checkpoint creation via the agent tool
- Selective rollback: files only, transcript only, or both
- Timeline visualization UI in the browser
- NFS-compatible storage for persistent checkpoint data
- Zero modifications to OpenClaw core

## Quick Start

### 1. Enable the Plugin

Add the checkpoint plugin to your OpenClaw config (`~/.openclaw/config.json`):

```json
{
  "plugins": {
    "checkpoint": {
      "enabled": true
    }
  }
}
```

### 2. (Optional) Configure NFS Storage

By default, checkpoints are stored at `~/.openclaw/checkpoints/`. To use an NFS mount:

```json
{
  "plugins": {
    "checkpoint": {
      "enabled": true,
      "storagePath": "/mnt/nfs/openclaw/checkpoints"
    }
  }
}
```

### 3. Run Your Agent

Checkpoints are created automatically. No changes to your workflow needed.

## Configuration Reference

| Option                     | Type     | Default                                               | Description                                 |
| -------------------------- | -------- | ----------------------------------------------------- | ------------------------------------------- |
| `enabled`                  | boolean  | `true`                                                | Enable or disable the plugin                |
| `storagePath`              | string   | `~/.openclaw/checkpoints/`                            | Directory for checkpoint metadata           |
| `triggerOn`                | string   | `"mutating_tools"`                                    | When to auto-create checkpoints             |
| `excludeTools`             | string[] | `["read","glob","grep","memory_search","memory_get"]` | Tools that skip checkpoint creation         |
| `maxCheckpointsPerSession` | number   | `200`                                                 | Max checkpoints per session (oldest pruned) |
| `retentionDays`            | number   | `30`                                                  | Days to keep checkpoint data                |
| `restoreDefaultScope`      | string   | `"all"`                                               | Default restore scope                       |

### `triggerOn` Modes

- **`mutating_tools`** (default) — Checkpoint after tool calls that modify files (skips read-only tools in `excludeTools`)
- **`all_tools`** — Checkpoint after every tool call
- **`manual`** — Only create checkpoints when explicitly requested via the agent tool

## Using the Agent Tool

The plugin registers a `checkpoint` tool that the agent can call directly.

### List Checkpoints

```
Agent: I'll check the current checkpoints.
→ calls checkpoint tool with action: "list"

Checkpoints (3):
- 01JQXYZ... | 2026-03-27T10:15:00Z [edit] | 2 files changed
- 01JQXYA... | 2026-03-27T10:14:30Z [write] | 1 files changed
- 01JQXYB... | 2026-03-27T10:14:00Z [session_start] | 5 files changed
```

### Create Manual Checkpoint

```
Agent: Let me save a checkpoint before this risky operation.
→ calls checkpoint tool with action: "create"

Checkpoint created: 01JQXYZ... (3 files, 1 file changed, 2 insertions(+))
```

### Restore to a Checkpoint

```
Agent: That didn't work. Let me restore to the previous checkpoint.
→ calls checkpoint tool with action: "restore", checkpoint_id: "01JQXYZ..."

Restored to checkpoint 01JQXYZ... (scope: all, files: true, transcript: true)
```

### Restore Scopes

The `scope` parameter controls what gets restored:

| Scope          | Files | Transcript | Use Case                                        |
| -------------- | ----- | ---------- | ----------------------------------------------- |
| `"files"`      | Yes   | No         | Undo file changes but keep conversation context |
| `"transcript"` | No    | Yes        | Reset conversation but keep current files       |
| `"all"`        | Yes   | Yes        | Full rollback to checkpoint state               |

## Visualization UI

When the OpenClaw gateway is running, access the checkpoint timeline at:

```
http://localhost:<gateway-port>/plugins/checkpoint/
```

The UI provides:

- **Session selector** — Browse checkpoint sessions across agents
- **Timeline view** — Vertical timeline of all checkpoints, newest first
- **Checkpoint nodes** showing:
  - Tool name and timestamp
  - Number of files changed
  - Success/error status (red dot for errors)
  - Manual checkpoints highlighted in blue
- **Detail panel** — Click any checkpoint to see:
  - Full metadata (trigger, run ID, duration)
  - List of changed files
  - Git commit info and diff stats
  - **Restore button** — Roll back to that checkpoint

### REST API

The visualization UI is backed by a REST API:

```
GET  /plugins/checkpoint/api/sessions                         # List all sessions
GET  /plugins/checkpoint/api/sessions/:id?agentId=...         # List checkpoints
GET  /plugins/checkpoint/api/checkpoints/:id?agentId=...&sessionId=...  # Detail
GET  /plugins/checkpoint/api/checkpoints/:id/diff?...         # Git diff
POST /plugins/checkpoint/api/checkpoints/:id/restore          # Restore
```

## NFS Mount Setup

### Recommended Directory Structure

```
/mnt/nfs/openclaw/
  workspaces/<agent-id>/          # Agent workspace (git repo)
  checkpoints/<agent-id>/         # Checkpoint metadata (plugin storagePath)
    <session-id>/
      manifest.json               # Checkpoint chain index
      <checkpoint-id>/
        meta.json                 # Checkpoint metadata
  sessions/<agent-id>/            # Session transcripts
  logs/                           # Logs
```

### Mount Configuration

1. Mount your NFS share:

```bash
sudo mount -t nfs <nfs-server>:/export/openclaw /mnt/nfs/openclaw
```

2. Configure OpenClaw to use the mount for workspaces:

```json
{
  "plugins": {
    "checkpoint": {
      "storagePath": "/mnt/nfs/openclaw/checkpoints"
    }
  }
}
```

3. Point your agent workspace to the NFS mount (if desired):

```bash
openclaw config set workspace.dir /mnt/nfs/openclaw/workspaces
```

## How It Works

### Checkpoint Creation

1. Agent calls a tool (e.g., `edit`, `write`, `bash`)
2. The `after_tool_call` hook fires
3. Plugin checks if the tool is in the exclude list → skip if read-only
4. Git snapshot:
   - `git add -A` → stage all changes
   - `git write-tree` → create tree object
   - `git commit-tree` → create detached commit (no branch, no HEAD change)
   - `git reset` → unstage
5. Save checkpoint metadata (ID, commit SHA, files changed, transcript offset)
6. Prune oldest checkpoints if over `maxCheckpointsPerSession`

### Checkpoint Restore

1. Load checkpoint metadata by ID
2. **File restore:** `git read-tree` + `git checkout-index` + `git clean`
3. **Transcript restore:** Truncate session JSONL to recorded byte offset
4. Update manifest to point to restored checkpoint
5. Remove checkpoints after the restored point (branch the timeline)

### Why Git commit-tree?

The plugin uses `git commit-tree` instead of regular commits or branches because:

- **No branch switching** — Doesn't touch HEAD or any branch
- **No conflicts** — Works alongside normal git workflow
- **Concurrent safe** — Multiple agents can create checkpoints simultaneously
- **Space efficient** — Git deduplicates unchanged files automatically
- **NFS compatible** — No lock contention on branch refs

## Troubleshooting

### Checkpoints not being created

1. Verify the plugin is enabled: check `plugins.checkpoint.enabled` in config
2. Check `triggerOn` mode — if set to `"manual"`, auto-creation is disabled
3. Check `excludeTools` — your tool may be in the exclusion list
4. Check logs for `Failed to create checkpoint` warnings

### Workspace is not a git repo

The plugin auto-initializes a git repo (`git init`) if one doesn't exist. If this fails, ensure the workspace directory is writable.

### NFS performance

Git operations over NFS can be slow for large workspaces. Mitigations:

- Use `triggerOn: "mutating_tools"` to skip read-only tools
- Add large/generated directories to `.gitignore`
- Reduce `maxCheckpointsPerSession` to limit stored snapshots

### Restore fails

- Ensure the workspace directory matches the checkpoint's original workspace
- Check that the git objects still exist (they can be garbage-collected if `git gc` runs)
- For transcript restore, ensure the session JSONL file path is accessible

## Iteration 2 Roadmap

- Multi-agent parallel checkpoint chains
- COW (copy-on-write) storage backend for NFS-optimized performance
- Multi-lane timeline visualization for parallel agent execution
- Sandbox isolation with per-agent NFS subdirectories
- Cross-agent group checkpoints at coordination points
