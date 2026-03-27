# OpenClaw 沙箱模式文件目录映射挂载分析

## 概述

OpenClaw 沙箱模式通过 Docker 容器隔离 agent 的工具执行环境。文件系统通过 Docker bind mount 实现宿主机与容器之间的目录映射。

## 架构层次

```
用户配置 (openclaw.json)
    ↓
resolveSandboxConfigForAgent()  [sandbox/config.ts]
    ↓
resolveSandboxContext()          [sandbox/context.ts]
    ↓
ensureSandboxContainer()         [sandbox/docker.ts]  → docker create -v ...
    ↓
createSandboxFsBridge()          [sandbox/fs-bridge.ts]  → 运行时文件读写
```

## 1. 目录映射机制

### 1.1 核心挂载 (workspace-mounts.ts)

`appendWorkspaceMountArgs()` 构建 Docker `-v` 参数：

| 挂载 | 宿主机路径 | 容器路径 | 权限 |
|------|-----------|---------|------|
| 主工作区 | `workspaceDir` | `/workspace` (默认 workdir) | 由 `workspaceAccess` 决定 |
| Agent 工作区 | `agentWorkspaceDir` | `/agent` (常量) | rw（除非 access=ro） |

**权限逻辑：**
- `workspaceAccess = "rw"` → 主工作区可写，使用真实 agent 工作区目录
- `workspaceAccess = "ro"` → 主工作区只读，agent 挂载只读
- `workspaceAccess = "none"` → 只挂载沙箱专用工作区，不挂载 agent 工作区

### 1.2 工作区目录解析 (context.ts → ensureSandboxWorkspaceLayout)

```
workspaceAccess = "rw"  → workspaceDir = agentWorkspaceDir (真实目录)
workspaceAccess ≠ "rw"  → workspaceDir = sandboxWorkspaceDir (隔离副本)
                           sandboxWorkspaceDir = ~/.openclaw/sandboxes/<scope-slug>/
```

### 1.3 自定义 bind 挂载 (config.ts → docker.binds)

用户可通过配置 `agents.defaults.sandbox.docker.binds` 添加额外挂载：
- 全局 binds + agent 级 binds 合并
- 格式: `source:target[:options]`（如 `/host/path:/container/path:ro`）

### 1.4 挂载解析流程 (fs-paths.ts → buildSandboxFsMounts)

运行时构建挂载映射表：
1. **workspace 挂载** → `workspaceDir` ↔ `containerWorkdir`
2. **agent 挂载**（如果 access≠none 且路径不同）→ `agentWorkspaceDir` ↔ `/agent`
3. **自定义 bind 挂载** → 解析 `docker.binds` 配置

优先级：bind > agent > workspace（容器路径冲突时）

## 2. 安全验证 (validate-sandbox-security.ts)

### 2.1 被阻止的宿主机路径
```
/etc, /private/etc, /proc, /sys, /dev, /root, /boot,
/run, /var/run, /private/var/run,
/var/run/docker.sock, /private/var/run/docker.sock, /run/docker.sock
```

### 2.2 验证规则
- **绝对路径检查**：bind 源路径必须为绝对 POSIX 路径
- **黑名单检查**：源路径不能是/在被阻止路径下
- **根目录检查**：不能挂载 `/`
- **允许根检查**：源路径必须在 `allowedSourceRoots`（默认=workspace 目录）内
- **保留目标检查**：容器内 `/workspace` 和 `/agent` 是保留路径
- **符号链接逃逸**：通过 `resolveSandboxHostPathViaExistingAncestor()` 解析真实路径，防止符号链接绕过
- **网络模式**：阻止 `host` 和 `container:*` 模式
- **安全配置文件**：阻止 `unconfined` seccomp/apparmor 配置

### 2.3 危险覆盖选项
- `dangerouslyAllowExternalBindSources` → 允许 workspace 外的源路径
- `dangerouslyAllowReservedContainerTargets` → 允许覆盖 /workspace、/agent
- `dangerouslyAllowContainerNamespaceJoin` → 允许 container:* 网络模式

## 3. Docker 容器创建参数 (docker.ts → buildSandboxCreateArgs)

默认安全加固：
- `--read-only` 根文件系统
- `--tmpfs /tmp,/var/tmp,/run`
- `--network none`（默认断网）
- `--cap-drop ALL`
- `--security-opt no-new-privileges`
- 环境变量敏感值过滤（sanitizeEnvVars）
- 可选: pids-limit, memory, cpus, ulimits

## 4. 运行时文件桥接 (fs-bridge.ts → SandboxFsBridgeImpl)

Agent 的文件操作通过 `SandboxFsBridge` 接口：

| 操作 | 实现方式 |
|------|---------|
| `readFile` | 通过宿主机路径直接读取（`openReadableFile` → `fd`），利用 host mount 映射 |
| `writeFile` | 通过 `docker exec` 在容器内执行 shell 写入 |
| `mkdirp` | 通过 `docker exec` 执行 mkdir |
| `remove` | 通过 `docker exec` 执行 rm |
| `rename` | 通过 `docker exec` 执行 mv |
| `stat` | 通过 `docker exec` 执行 stat |

**关键安全层：`SandboxFsPathGuard`**
- 路径解析：容器路径 ↔ 宿主机路径映射
- 写入检查：`workspaceAccess` 必须为 `rw` 且挂载点可写
- 路径逃逸保护：确保操作不超出挂载边界

## 5. Docker-setup.sh 中的沙箱配置

当 `OPENCLAW_SANDBOX=1` 时：
1. 构建沙箱镜像 `openclaw-sandbox:bookworm-slim`（从 Dockerfile.sandbox）
2. 验证容器内有 Docker CLI（用于嵌套容器管理）
3. 挂载 Docker socket 到 gateway 容器
4. 设置配置：`sandbox.mode=non-main`, `scope=agent`, `workspaceAccess=none`
5. 失败时回滚至 `sandbox.mode=off`

## 6. 总结流程图

```
宿主机                          Docker 容器 (sandbox)
─────────                       ─────────────────────
~/.openclaw/sandboxes/<slug>/  ──mount──→  /workspace (ro 或 rw)
~/.openclaw/workspace/         ──mount──→  /agent     (条件挂载)
自定义 binds                    ──mount──→  自定义路径

Agent 读文件 → fsBridge.readFile()
  → 解析容器路径到宿主机路径 (fs-paths.ts)
  → 安全检查 (path guard)
  → 直接从宿主机 fd 读取

Agent 写文件 → fsBridge.writeFile()
  → 解析路径 + 写权限检查
  → docker exec 容器内写入
```

## 关键文件列表

| 文件 | 功能 |
|------|------|
| `src/agents/sandbox/config.ts` | 沙箱配置解析与合并 |
| `src/agents/sandbox/context.ts` | 沙箱上下文创建入口 |
| `src/agents/sandbox/docker.ts` | Docker 容器创建与管理 |
| `src/agents/sandbox/workspace-mounts.ts` | 工作区挂载参数构建 |
| `src/agents/sandbox/fs-bridge.ts` | 文件操作桥接层 |
| `src/agents/sandbox/fs-paths.ts` | 挂载映射表与路径解析 |
| `src/agents/sandbox/validate-sandbox-security.ts` | 安全验证 |
| `src/agents/sandbox/host-paths.ts` | 宿主机路径规范化 |
| `src/agents/sandbox/bind-spec.ts` | bind mount 格式解析 |
| `src/agents/sandbox/constants.ts` | 默认值常量 |
| `src/agents/sandbox/types.ts` | 类型定义 |
| `Dockerfile.sandbox` | 沙箱容器镜像 |
| `docker-setup.sh` | Docker 安装脚本（含沙箱配置） |
