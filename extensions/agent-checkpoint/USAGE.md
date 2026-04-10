# Agent Checkpoint — Usage Guide

## Automatic Mode (Zero Config)

Once installed and enabled, the plugin works automatically:

- **Session start** — creates a baseline checkpoint
- **After each tool call** — creates a checkpoint (read-only tools like read/glob/grep are skipped)

No manual action needed. Checkpoints are created silently in the background.

---

## Manual Operations (via /checkpoint command)

### List sessions

```
/checkpoint sessions
```

Example output:

```
Sessions (2)
`main` / `coding-task-2026-04-08` — 12 checkpoints
`main` / `subagent:review-abc` — 3 checkpoints ← main/coding-task-2026-04-08
```

### List checkpoints

```
/checkpoint list main coding-task-2026-04-08
```

Example output:

```
Checkpoints (3)
`main-coding-001-start` 2026-04-07T10:30:15Z [Write] — 3 files
`main-coding-002-write` 2026-04-07T10:31:02Z [Bash] — 1 files
`main-coding-003-exec`  2026-04-07T10:32:45Z [Edit] ❌ — 2 files
```

### Create a manual checkpoint

```
/checkpoint create
/checkpoint create pre-refactor backup
```

### Restore to a checkpoint

```
/checkpoint restore 01JRX...ABC              # restore files + transcript (default scope=all)
/checkpoint restore 01JRX...ABC files        # restore files only
/checkpoint restore 01JRX...ABC transcript   # rollback transcript only
```

### Start the timeline viewer

```
/checkpoint timeline           # random port
/checkpoint timeline 3000      # specific port
```

Open the printed URL in a browser to visually browse all checkpoints.

In the timeline viewer you can:
- **Restore Files** — click the orange button on any checkpoint to roll back workspace files to that point
- **Restore & Continue** — click the green button to restore and immediately resume agent execution from that checkpoint, with real-time progress streaming

### Stop the timeline viewer

```
/checkpoint timeline-stop
```

---

## Agent-Initiated Usage (Tool Calls)

Agents can manage checkpoints autonomously via the `checkpoint` tool:

```
Agent: I'm about to do a large refactor, let me create a checkpoint first
→ calls checkpoint tool: { action: "create" }

Agent: The refactor went wrong, rolling back
→ calls checkpoint tool: { action: "restore", checkpoint_id: "01JRX...ABC" }

Agent: Let me check available checkpoints
→ calls checkpoint tool: { action: "list" }
```

---

## Common Scenarios

| Scenario | Action |
|----------|--------|
| Agent's Bash command failed | Auto-checkpoint exists; `/checkpoint restore <id>` to rollback |
| About to do something risky (delete files, large refactor) | `/checkpoint create` to create a safety point |
| Want to compare changes before/after a tool call | `/checkpoint timeline` to open the visual UI, click to view diff |
| Agent wrote completely wrong code | `/checkpoint list` to find the right point, then `restore` |
| Running low on disk space | Reduce `retentionDays` or `maxCheckpointsPerSession` in config |

---

## Restore Scope Explained

| Scope | Effect |
|-------|--------|
| `files` | Workspace files restored to checkpoint state; transcript preserved (agent remembers what happened) |
| `transcript` | Transcript restored from checkpoint snapshot to a new session file; files unchanged |
| `all` | Both files and transcript restored (fully return to that point in time) |

---

## Configuration

All fields are optional. Invalid values fall back to safe defaults.

```jsonc
{
  "enabled": true,                          // master switch
  "storagePath": "~/.openclaw/checkpoints", // storage directory
  "backendType": "copy",                    // snapshot backend (Phase 1: file copy)
  "backendConfig": {                        // backend-specific params
    "excludePatterns": [".git", "node_modules", ".DS_Store"]
  },
  "triggerOn": "auto",                      // "auto" | "manual"
  "excludeTools": ["read", "glob", "grep"], // tools that don't trigger checkpoints
  "maxCheckpointsPerSession": 200,          // max checkpoints per session (1-1000)
  "retentionDays": 30,                      // auto-prune after N days (1-365)
  "restoreDefaultScope": "all"              // "files" | "transcript" | "all"
}
```

---

## Installation

### From local directory (development)

```bash
git clone https://github.com/bigmiao-T/openclaw.git
cd openclaw && git checkout feat/agent-checkpoint
openclaw plugins install ./extensions/agent-checkpoint
```

### After npm publish

```bash
openclaw plugins install @openclaw/agent-checkpoint
```

Then restart the gateway. The plugin is enabled by default.
