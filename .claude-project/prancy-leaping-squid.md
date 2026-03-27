# OpenClaw 沙箱 Agent 文件读写 I/O 路径分析

## Context

用户想了解 OpenClaw agent 在 Docker 沙箱模式下读写宿主机文件时，经过了哪些组件/模块，以及性能损失情况。

---

## 架构总览

OpenClaw 采用 **混合 I/O 模型**：读操作直接走宿主机文件系统（零 Docker 开销），写操作通过 `docker exec` 在容器内执行（保证原子性和安全性）。

```
┌─────────────────────────────────────────────────────────────┐
│  LLM 返回 tool_use (read/write/edit/bash)                    │
└──────────────────────┬──────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Gateway 工具分发层 (src/gateway/tools-invoke-http.ts)        │
│  → 查找工具 → 应用策略(allow/deny) → 调用 tool.execute()      │
└──────────────────────┬──────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  沙箱文件桥接 (src/agents/sandbox/fs-bridge.ts)               │
│  → 路径映射: 容器路径 ↔ 宿主机路径                              │
│  → 安全检查: 防止符号链接逃逸、边界越权                          │
└───────┬─────────────────────────────────┬───────────────────┘
        │                                 │
   读操作 (read)                      写操作 (write/edit)
        ▼                                 ▼
┌───────────────────┐     ┌───────────────────────────────────┐
│ 直接宿主机 FS      │     │ docker exec -i <container>         │
│ fs.openSync()     │     │   sh -c <python-mutation-script>   │
│ fs.readFileSync() │     │   stdin ← 文件内容                  │
│ (无 Docker 参与)   │     │   → 原子写: tmpfile → fsync → rename│
└───────────────────┘     └───────────────────────────────────┘
```

---

## 各组件详解

### 1. 工作区挂载方式：Docker bind mount（非 virtiofs）

**文件**: `src/agents/sandbox/workspace-mounts.ts`

```
宿主机: ~/.openclaw/sandboxes/${sessionKey}/
   ↓  docker -v bind mount
容器:  /workspace/   (主工作区，可 :ro 或 :rw)
容器:  /agent/       (agent 专属工作区，可选)
```

- 使用标准 Docker `-v` 参数做 bind mount
- **不是** virtiofs、FUSE、overlayfs 或 volume
- macOS 上 Docker Desktop 内部会通过 **VirtioFS**（或 gRPC-FUSE，取决于 Docker Desktop 设置）将 bind mount 传递到 Linux VM 中

### 2. 文件读取路径（快路径）

**文件**: `src/agents/sandbox/fs-bridge.ts:271-277`, `src/infra/boundary-file-read.ts`

```
Agent tool_use: read → fs-bridge.readPinnedFile()
  → pathGuard.openReadableFile()  // 安全边界检查
  → fs.openSync(hostPath)         // 直接打开宿主机文件
  → fs.readFileSync(fd)           // 直接读取
  → fs.closeSync(fd)
```

**关键发现：读操作完全绕过 Docker**，直接在宿主机进程中用 Node.js fs API 读取。没有 `docker exec`，没有容器内操作。

### 3. 文件写入路径（安全路径）

**文件**: `src/agents/sandbox/fs-bridge.ts:248-269`, `fs-bridge-mutation-helper.ts`

```
Agent tool_use: write → fs-bridge.writeFile()
  → pathGuard.assertPathSafety()       // 安全检查
  → buildPinnedWritePlan()             // 构建写入计划
  → runCheckedCommand()
    → runCommand()
      → execDockerRaw(['docker', 'exec', '-i', containerName, 'sh', '-c', script])
        → Node.js child_process.spawn('docker', [...])
          → Docker 执行 shell 命令
            → Python 脚本执行原子写入
              → tmpfile → write → fsync → rename
```

组件链：**Node.js → spawn → docker CLI → Docker daemon → container sh → Python script → bind mount → 宿主机 FS**

### 4. Bash/Shell 命令执行路径

**文件**: `src/agents/bash-tools.exec-runtime.ts:402-417`, `bash-tools.shared.ts`

```
Agent tool_use: bash "ls -la" →
  → spawn('docker', ['exec', '-i', '-w', '/workspace', containerName, '/bin/sh', '-lc', 'ls -la'])
```

组件链：**Node.js → spawn → docker CLI → Docker daemon → container /bin/sh → 命令执行 → 结果通过 stdout/stderr 返回**

### 5. 宿主机与容器间通信方式

**没有 RPC/gRPC/WebSocket/IPC 层**。所有通信通过：
- `child_process.spawn('docker', [...])` 调用 Docker CLI
- stdin 传入数据（如文件内容）
- stdout/stderr 捕获结果
- 纯 Buffer 传输，无 base64 编码

### 6. 安全层

**文件**: `src/agents/sandbox/fs-bridge-path-safety.ts`

- 挂载边界验证：路径不能逃出定义的挂载点
- 符号链接防护：使用 `O_NOFOLLOW` 标志，防止跟随符号链接
- 写入前路径锁定（pin）：防止 TOCTTOU 竞态条件
- 读写权限强制检查（ro/rw）

---

## 性能分析

### 读操作：几乎零损失

| 层 | 开销 |
|----|------|
| 路径映射 + 安全检查 | 微秒级，纯内存操作 |
| fs.openSync / readFileSync | 原生 Node.js 调用，与非沙箱模式相同 |
| **总计** | **≈ 0% 额外开销** |

### 写操作：主要开销在 docker exec

| 层 | 开销 |
|----|------|
| 路径安全检查 | 微秒级 |
| `spawn('docker', ...)` | ~5-20ms（进程创建） |
| Docker CLI → daemon 通信 | ~5-10ms（Unix socket） |
| 容器内 sh + Python 启动 | ~10-30ms |
| 实际文件写入（通过 bind mount） | 与直接写入相同 |
| **macOS bind mount 额外开销** | Docker Desktop VirtioFS 层 ~5-20% 吞吐量损失 |
| **总计** | **单次写入 ~20-60ms 固定开销 + VirtioFS 吞吐量损失** |

### Bash 命令：与写操作类似

| 层 | 开销 |
|----|------|
| `spawn → docker exec` | ~20-50ms 固定开销 |
| 容器内 `/bin/sh -lc` | 登录 shell 初始化 ~10-20ms |
| 命令本身 | 与宿主机执行相同 |
| **总计** | **每次命令 ~30-70ms 额外延迟** |

### macOS 特有：Docker Desktop 的隐藏层

在 macOS 上，Docker 实际运行在 Linux VM 中：
```
宿主机 macOS FS → Docker Desktop VirtioFS → Linux VM → container bind mount
```
这个 VirtioFS 层是 macOS 上最大的性能瓶颈，大文件 I/O 吞吐量可降低 20-50%。

### 总结

| 操作 | 非沙箱 | 沙箱 | 性能差异 |
|------|--------|------|----------|
| 文件读取 | 直接 FS | 直接 FS（绕过 Docker） | **无差异** |
| 文件写入 | 直接 FS | docker exec + Python 原子写入 | **+20-60ms/次** |
| Bash 命令 | 直接 shell | docker exec + sh -lc | **+30-70ms/次** |
| 大文件吞吐 (macOS) | 原生 | 经过 VirtioFS | **-20-50%** |

对于 LLM agent 的典型使用场景（小文件读写、命令执行），每次操作增加的 20-70ms 延迟相对于 LLM 推理时间（通常数秒）来说可以忽略不计。

---

## 关键源码文件

| 文件 | 职责 |
|------|------|
| `src/agents/sandbox/fs-bridge.ts` | 文件读写桥接，核心 I/O 逻辑 |
| `src/agents/sandbox/fs-bridge-path-safety.ts` | 路径安全检查、符号链接防护 |
| `src/agents/sandbox/fs-bridge-mutation-helper.ts` | 容器内原子写入的 Python 脚本 |
| `src/agents/sandbox/workspace-mounts.ts` | Docker bind mount 参数构建 |
| `src/agents/sandbox/docker.ts` | 容器创建、docker exec 封装 |
| `src/agents/bash-tools.shared.ts` | Bash 工具的 docker exec 参数构建 |
| `src/agents/bash-tools.exec-runtime.ts` | Bash 执行运行时（沙箱/非沙箱分支） |
| `src/infra/boundary-file-read.ts` | 宿主机直接文件读取（安全边界） |
| `src/agents/pi-tools.ts` | 工具创建工厂，沙箱检测与工具替换 |
| `Dockerfile.sandbox` | 沙箱容器镜像定义 |
