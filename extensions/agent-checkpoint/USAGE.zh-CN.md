# Agent Checkpoint — 使用指南

## 自动模式（零配置）

安装启用后，插件自动工作：

- **会话开始时** — 自动创建基线检查点
- **每次工具调用后** — 自动创建检查点（只读工具如 read/glob/grep 除外）

不需要做任何事情，检查点在后台静默创建。

---

## 手动操作（通过 /checkpoint 命令）

### 查看检查点列表

```
/checkpoint list
```

输出示例：

```
Checkpoints (3)
`01JRX...ABC` 2026-04-07T10:30:15Z [Write] — 3 files
`01JRX...DEF` 2026-04-07T10:31:02Z [Bash] — 1 files
`01JRX...GHI` 2026-04-07T10:32:45Z [Edit] ❌ — 2 files
```

### 手动创建检查点

```
/checkpoint create
/checkpoint create 重构前备份
```

### 回滚到某个检查点

```
/checkpoint restore 01JRX...ABC              # 恢复文件+对话（默认 scope=all）
/checkpoint restore 01JRX...ABC files        # 只恢复文件
/checkpoint restore 01JRX...ABC transcript   # 只回滚对话记录
```

### 启动时间线查看器

```
/checkpoint timeline           # 随机端口
/checkpoint timeline 3000      # 指定端口
```

浏览器打开输出的 URL，可以可视化浏览所有检查点。

### 停止查看器

```
/checkpoint timeline-stop
```

---

## Agent 自主使用（工具调用）

Agent 可以通过 `checkpoint` 工具自主管理检查点：

```
Agent: 我要开始一个大规模重构，先创建检查点
→ 调用 checkpoint tool: { action: "create" }

Agent: 重构出了问题，回滚
→ 调用 checkpoint tool: { action: "restore", checkpoint_id: "01JRX...ABC" }

Agent: 看看有哪些检查点可以回滚
→ 调用 checkpoint tool: { action: "list" }
```

---

## 典型使用场景

| 场景 | 操作 |
|------|------|
| Agent 执行 Bash 命令失败了 | 自动有检查点，`/checkpoint restore <id>` 回滚 |
| 准备做危险操作（删文件、大重构） | `/checkpoint create` 手动创建保险点 |
| 想对比某个工具前后的变化 | `/checkpoint timeline` 打开可视化，点击查看 diff |
| 发现 Agent 写的代码全部不对 | `/checkpoint list` 找到正确的点，`restore` 回滚 |
| 磁盘空间不够了 | 调小 `retentionDays` 或 `maxCheckpointsPerSession` |

---

## 恢复范围（scope）说明

| Scope | 效果 |
|-------|------|
| `files` | 工作区文件恢复到检查点状态，对话记录保留（Agent 记得做过什么） |
| `transcript` | 对话记录截断到检查点时刻，文件不变 |
| `all` | 文件和对话都恢复（完全回到那个时刻） |

---

## 配置

所有字段均为可选。无效值自动降级为安全默认值。

```jsonc
{
  "enabled": true,                          // 总开关
  "storagePath": "~/.openclaw/checkpoints", // 存储目录
  "backendType": "copy",                    // 快照后端（Phase 1: 文件复制）
  "backendConfig": {                        // 后端私有参数
    "excludePatterns": [".git", "node_modules", ".DS_Store"]
  },
  "triggerOn": "mutating_tools",            // "all_tools" | "mutating_tools" | "manual"
  "excludeTools": ["read", "glob", "grep"], // 不触发检查点的工具
  "maxCheckpointsPerSession": 200,          // 每会话最大检查点数（1-1000）
  "retentionDays": 30,                      // 自动清理天数（1-365）
  "restoreDefaultScope": "all"              // "files" | "transcript" | "all"
}
```

---

## 安装

### 从本地目录安装（开发/测试）

```bash
git clone https://github.com/bigmiao-T/openclaw.git
cd openclaw && git checkout feat/agent-checkpoint
openclaw plugins install ./extensions/agent-checkpoint
```

### 发布到 npm 后安装

```bash
openclaw plugins install @openclaw/agent-checkpoint
```

安装后重启 gateway 即可。插件默认启用。
