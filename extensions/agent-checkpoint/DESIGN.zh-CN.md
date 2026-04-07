# Agent Checkpoint — 设计文档

> 为长时间运行的 Agent 任务提供自动检查点与回滚能力。
> OpenClaw 插件 · Phase 1 · 2026-04-07

---

## 1. 问题背景

长时间运行的 Agent 任务（代码生成、多步骤重构、数据处理）可能在中途失败或产生不理想的结果。没有检查点机制时，唯一的恢复方式就是从头开始。Agent 需要：

- 在关键时刻快照工作区状态
- 出错时回滚到已知的正确状态
- 查看一次会话中的完整变更历史

## 2. 架构总览

```
┌─────────────────────────────────────────────────────┐
│                   OpenClaw Plugin SDK                │
│  hooks: after_tool_call, session_start               │
│  tool: checkpoint (list / create / restore)          │
│  command: /checkpoint (list / create / restore /     │
│           timeline / timeline-stop)                  │
│  service: pruning (后台定时清理, 每 6 小时)            │
└──────────────┬──────────────────────┬───────────────┘
               │                      │
        ┌──────▼──────┐        ┌──────▼──────┐
        │   Engine    │        │  Timeline   │
        │  (编排层)    │        │  Server     │
        └──┬──────┬───┘        │ (HTTP 可视化)│
           │      │            └─────────────┘
    ┌──────▼──┐ ┌─▼────────┐
    │  Store  │ │ Snapshot  │
    │ (元数据) │ │ Backend   │
    └─────────┘ │ (快照后端) │
                └───────────┘
```

### 模块职责

| 模块 | 职责 | 深度评估 |
|------|------|---------|
| `snapshot-backend.ts` | 快照后端接口定义 + 工厂 | 深模块 — 4 个方法的接口隐藏了全部物理快照机制 |
| `copy-backend.ts` | Phase 1 实现：基于 `fs.cp` 的原子写入 | 深模块 — 排除模式、tmp+rename 原子性、递归 diff |
| `store.ts` | 检查点元数据持久化（磁盘 JSON） | 深模块 — manifest 管理、会话查询、协调清理 |
| `engine.ts` | 编排 backend + store 操作 | 中等 — 协调 create/restore/prune，管理 parent 链 |
| `hooks.ts` | 工具调用后与会话启动时自动创建检查点 | 薄层 — SDK 事件到 engine 的粘合层 |
| `tool.ts` | Agent 侧工具（list/create/restore） | 薄层 — 输入验证 + engine 调度 |
| `command.ts` | `/checkpoint` 斜杠命令 | 薄层 — CLI 风格的 engine + timeline 入口 |
| `config.ts` | 配置解析，带安全默认值 | 中等 — 校验并规范化所有用户配置 |
| `timeline-server.ts` | HTTP 服务器 + 内联 SPA 检查点可视化 | 深模块 — REST API + 完整暗色主题时间线 UI |
| `pruning-service.ts` | 过期检查点的后台清理 | 浅模块 — 为 SDK 的 registerService 契约包装 setInterval |
| `types.ts` | 共享类型定义 | N/A — 纯类型 |

## 3. 关键设计决策

### 3.1 SnapshotBackend 接口 — 与实现解耦

这是整个项目的核心抽象。所有快照操作通过 4 个方法完成：

```typescript
interface SnapshotBackend {
  createSnapshot(params)  → SnapshotResult   // 创建快照
  restoreSnapshot(params) → void             // 恢复快照
  diffSnapshot(params)    → string           // 对比差异
  deleteSnapshot(ref)     → void             // 删除快照
}
```

**为什么这样设计：** Phase 1 使用 `fs.cp`（简单文件复制）。未来可以替换为 btrfs 快照、ZFS 或远程存储，无需修改其他任何模块。返回的 `snapshotRef` 是不透明字符串——只有 backend 自己知道如何解释它。

**设计原则：** 深模块（Ousterhout）。简洁的接口背后隐藏丰富的实现——原子写入、排除模式过滤、递归目录对比、清理逻辑。类似 Unix 文件 I/O 用 5 个系统调用暴露整个文件系统的设计哲学。

### 3.2 excludePatterns — 后端私有参数，不放全局配置

排除模式（`.git`、`node_modules`、`.DS_Store`）是 `CopyBackend` 的构造参数，不在全局插件配置中。全局配置只有 `backendType` + `backendConfig: Record<string, unknown>`。

**为什么这样设计：** 不同后端有完全不同的排除语义。btrfs 后端可能按子卷挂载点排除；远程后端可能在服务端使用 `.gitignore` 风格的规则。把排除模式作为后端私有参数，防止了信息泄漏（Information Leakage）。

### 3.3 Engine 只做编排

Engine **不拥有**查询操作。`store.listCheckpoints()` 和 `store.listSessions()` 由 tool/command/timeline-server 直接调用。

Engine 只拥有需要 **协调 backend 和 store** 的操作：
- `createCheckpoint` — 快照 + 元数据 + parent 链 + 清理
- `restoreCheckpoint` — 恢复文件 + 截断对话记录 + 裁剪 manifest
- `getCheckpointDiff` — 从 store 解析 parent，委托 backend 做 diff
- `pruneOld` — 遍历 store，同时删除 store 和 backend 数据

**为什么这样设计：** 将纯读操作路由到 Engine 会使其成为直通层（Pass-Through Method，Ousterhout 的 Red Flag）。只需要元数据的调用者不应该依赖快照后端。

### 3.4 工作区目录缓存

SDK 的 `PluginHookToolContext` 不暴露 `workspaceDir`，但工具工厂的上下文有。解决方案：工具实例化时按 `agentId` 缓存 `workspaceDir` 到模块级 `Map`，hooks 从缓存中读取。

```typescript
// hooks.ts
const workspaceDirs = new Map<string, string>();
export function cacheWorkspaceDir(ctx) { ... }
export function getCachedWorkspaceDir(agentId) { ... }
```

**为什么这样设计：** 这是对 SDK 限制的 workaround。缓存的生命周期与插件进程一致，符合 Agent 会话生命周期。如果 SDK 未来在 hook 上下文中添加 `workspaceDir`，可以直接删除这个缓存。

### 3.5 错误处理 — 把错误定义掉

遵循 Ousterhout 的 "Define Errors Out of Existence" 原则：

| 场景 | 策略 | 原因 |
|------|------|------|
| `deleteSnapshot` 删除不存在的快照 | **幂等**，静默成功 | 调用者无需 "先检查再删除" |
| `resolveConfig` 收到无效配置 | **降级**到安全默认值，不抛异常 | 配置错误不应阻止插件启动 |
| Hook 中创建检查点失败 | **捕获并记录日志** | 检查点失败不应导致 Agent 崩溃 |
| `restoreSnapshot` 快照不存在 | **抛异常** | 调用者需要知道恢复失败了 |

### 3.6 元数据存储布局

```
<storagePath>/
├── meta/<agentId>/<sessionId>/           # CheckpointStore
│   ├── manifest.json                     # 有序检查点列表 + currentHead
│   └── <checkpointId>/meta.json          # 完整 CheckpointMeta
└── snapshots/<checkpointId>/             # CopyBackend
    └── (完整工作区副本)
```

元数据和快照故意存储在不同的目录树中。这使得未来可以将快照存储到远程服务器，而元数据保持在本地。

## 4. 数据模型

```typescript
type CheckpointMeta = {
  id: CheckpointId;              // ULID — 可排序、全局唯一
  parentId: CheckpointId | null; // 指向前一个检查点
  sessionId: string;
  agentId: string;
  runId: string;
  trigger: {
    type: "after_tool_call" | "manual" | "session_start";
    toolName?: string;           // 触发检查点的工具名称
    toolCallId?: string;
  };
  snapshot: {
    backendType: string;         // "copy" (Phase 1)
    snapshotRef: string;         // 后端不透明引用
    filesChanged: string[];      // 相对路径
    changeSummary?: string;      // 人类可读的变更摘要
  };
  transcript: {
    messageCount: number;        // 对话消息数
    byteOffset: number;          // 用于恢复时截断对话记录
  };
  createdAt: string;             // ISO 8601
  toolDurationMs?: number;       // 工具执行耗时
  toolResult?: {
    success: boolean;
    errorMessage?: string;
  };
};
```

## 5. 用户界面

### 5.1 Agent 工具

`checkpoint` 工具暴露给 Agent，支持三个操作：

| 操作 | 参数 | 说明 |
|------|------|------|
| `list` | — | 显示当前会话的所有检查点 |
| `create` | — | 手动创建检查点 |
| `restore` | `checkpoint_id`, `scope?` | 恢复到检查点（scope: files / transcript / all） |

### 5.2 斜杠命令

```
/checkpoint list                          # 列出检查点
/checkpoint create [label]                # 手动创建检查点，可带标签
/checkpoint restore <id> [scope]          # 恢复到指定检查点
/checkpoint timeline [port]               # 启动 HTTP 时间线查看器
/checkpoint timeline-stop                 # 停止时间线查看器
```

### 5.3 时间线查看器

本地 HTTP 服务器，提供单页暗色主题 UI：

- **会话选择器** — 浏览所有 Agent 会话
- **时间线** — 纵向时间线，用不同颜色节点区分类型（工具调用 / 手动 / 会话启动 / 错误）
- **详情面板** — 检查点元数据、文件变更列表、diff 视图
- **响应式布局** — 适配桌面和手机

API 端点：
- `GET /api/sessions` — 列出所有会话
- `GET /api/sessions/:agentId/:sessionId/checkpoints` — 列出检查点
- `GET /api/sessions/:agentId/:sessionId/checkpoints/:id/diff` — 获取 diff

## 6. 自动检查点行为

| 事件 | 行为 |
|------|------|
| `session_start` | 创建基线检查点（前提：工作区已缓存） |
| `after_tool_call` | 创建检查点，除非工具在 `excludeTools` 列表中 |
| 手动 `/checkpoint create` | 始终创建检查点 |

默认排除的工具：`read`、`glob`、`grep`、`memory_search`、`memory_get`（只读工具，不修改工作区）。

## 7. 配置

```jsonc
// openclaw.plugin.json → pluginConfig，或用户配置
{
  "enabled": true,                              // 是否启用
  "storagePath": "~/.openclaw/checkpoints",     // 存储路径
  "backendType": "copy",                        // 快照后端类型
  "backendConfig": {                            // 透传给后端的参数
    "excludePatterns": [".git", "node_modules", ".DS_Store"]
  },
  "triggerOn": "mutating_tools",                // "all_tools" | "mutating_tools" | "manual"
  "excludeTools": ["read", "glob", "grep"],     // 不触发检查点的工具
  "maxCheckpointsPerSession": 200,              // 每会话最大检查点数
  "retentionDays": 30,                          // 保留天数
  "restoreDefaultScope": "all"                  // "files" | "transcript" | "all"
}
```

所有字段均为可选。无效值自动降级为安全默认值。

## 8. 已知限制与未来规划

### Phase 1 限制
- **每次全量复制** — 磁盘使用量线性增长，无去重机制
- **无增量快照** — 每个检查点复制整个工作区
- **仅文件级 diff** — 只根据文件大小和修改时间判断变更，不做内容级对比

### 未来改进
- **Phase 2: 增量后端** — btrfs/ZFS 快照或内容寻址存储
- **Phase 2: 远程后端** — 将快照存储到远程服务器，支持跨机器恢复
- **时间线查看器增强** — UI 中的恢复按钮、实时自动刷新、内容级 diff 展示

### 设计债务（来自 Ousterhout 审查）

| # | 问题 | 严重度 | 涉及文件 |
|---|------|--------|---------|
| 1 | `snapshotRef` 不透明性不够强（值等于 checkpointId） | 轻微 | `copy-backend.ts` |
| 2 | `createCheckpoint` 耦合了创建与清理操作 | 轻微 | `engine.ts` |
| 3 | 两个 Hook 重复了参数提取逻辑 | 轻微 | `hooks.ts` |
| 4 | `pruning-service.ts` 是浅模块 | 轻微 | `pruning-service.ts` |
| 5 | `tool.ts` 的 switch 混合了验证、编排、格式化 | 轻微 | `tool.ts` |
| 6 | workspaceDir 作为 pass-through variable 贯穿 5 层 | 轻微（SDK 限制） | `hooks.ts` |

以上均为 minor 问题，不影响当前功能，待后续重构时处理。

## 9. 测试

41 个集成测试，使用真实文件系统操作：

| 测试套件 | 测试数 | 覆盖范围 |
|---------|--------|---------|
| CopyBackend | 12 | 创建、排除模式、parent diff、恢复、保留排除目录、幂等删除 |
| CheckpointStore | 11 | manifest 增删改查、检查点存取列表删除、会话查询 |
| CheckpointEngine | 8 | 编排创建/恢复、parent 链、工具过滤、恢复后 manifest 裁剪、过期清理 |
| TimelineServer | 5 | HTML 页面、REST API 端点、错误处理 |

运行命令：`npx vitest run --config vitest.extension-agent-checkpoint.config.ts`
