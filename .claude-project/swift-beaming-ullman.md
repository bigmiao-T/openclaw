# OpenClaw 容器沙箱存储交互研究 — 执行计划

## Context

研究 OpenClaw 沙箱存储架构。源码分析已完成，需要启动 Docker 后逐阶段实验并记录结果到研究报告。

**研究报告输出**: `/Users/xinlingtao/openclaw-sandbox-research/report.md`
**实验数据目录**: `/Users/xinlingtao/openclaw-sandbox-research/data/`

---

## 当前状态

- [x] Docker CLI v29.2.1 已安装
- [ ] **Docker Desktop 未运行** — 需要用户手动启动
- [x] OpenClaw 2026.3.14 (d230bd9) 已确认
- [x] 源码分析完成（9 个关键文件已读取）
- [x] 基线状态：干净（无 sandbox 目录、无 containers.json）

---

## 执行步骤

### 步骤 0: 前置准备

1. **安装 Docker Desktop**: 通过 Homebrew Cask 安装 (`brew install --cask docker`)，然后 `open -a Docker` 启动，等待 `docker info` 可用
2. 创建研究报告目录和报告文件框架
3. 记录基线状态到报告

### 步骤 1: 阶段一 — 基础沙箱启用与工作区挂载

**修改文件**: `~/.openclaw/openclaw.json`（添加 sandbox 配置）

1. 备份当前 openclaw.json
2. 在 `agents.defaults` 中添加 `sandbox: { mode: "all", workspaceAccess: "ro", scope: "session" }`
3. 通过 `openclaw agent` 启动一个会话触发沙箱创建
4. 记录观察项到报告:
   - `~/.openclaw/sandbox/containers.json` 内容
   - `~/.openclaw/sandboxes/` 目录结构
   - `docker inspect <container> --format '{{json .Mounts}}'` 输出
   - `docker inspect <container> --format '{{json .HostConfig}}'` 中的只读根文件系统和 tmpfs
5. 对比三种 workspaceAccess 模式 (none/ro/rw)，每次修改后重启会话并记录挂载差异

### 步骤 2: 阶段二 — FS Bridge 路径解析与 I/O 机制

1. 在沙箱工作区放置测试文件 `test.txt`
2. 通过 agent 会话请求读取 `/workspace/test.txt`，观察 FS bridge 是否直接走主机 fs
3. 通过 agent 会话请求写入文件，观察是否走 `docker exec`
4. 验证 `workspaceAccess: "ro"` 下的双挂载 (`/workspace` + `/agent`)
5. 记录路径解析日志和挂载点到报告

### 步骤 3: 阶段三 — 安全边界验证

1. 测试绑定挂载 `/etc` → 预期被拒绝，记录错误信息
2. 测试工作区外路径绑定（不带/带 `dangerouslyAllowExternalBindSources`）
3. 测试符号链接逃逸防护
4. 所有安全测试结果记录到报告

### 步骤 4: 阶段四 — 作用域模式与存储隔离

1. 分别测试 session/agent/shared 三种 scope
2. 每种模式启动两个会话，检查文件可见性和容器复用
3. 记录 `containers.json` 中的条目变化和目录结构

### 步骤 5: 阶段五 — 容器生命周期与配置哈希

1. 修改 docker 配置（如添加 env），观察 configHash 变化
2. 测试热窗口期 (5min) 内的配置变更行为
3. 设置 `prune.idleHours: 1` 测试自动清理（可缩短等待，仅验证机制）
4. 记录容器标签上的 `openclaw.configHash` 值变化

### 步骤 6: 阶段六 — macOS 性能测试

1. 生成 1MB 测试文件
2. 对比: 主机直读 vs FS bridge 读 vs docker exec 读
3. 对比: VirtioFS 写 vs tmpfs 写 (容器内 `dd`)
4. 结果整理为表格记录到报告

### 步骤 7: 阶段七 — 代理网络配置

1. 在 sandbox docker config 中添加 ClashX 代理环境变量
2. 验证容器内网络连通性
3. 记录验证结果

---

## 关键文件

| 文件 | 路径 |
|------|------|
| 沙箱初始化 | `src/agents/sandbox/context.ts` |
| 容器生命周期 | `src/agents/sandbox/docker.ts` |
| FS Bridge | `src/agents/sandbox/fs-bridge.ts` |
| 路径转译 | `src/agents/sandbox/fs-paths.ts` |
| 挂载构造 | `src/agents/sandbox/workspace-mounts.ts` |
| 安全验证 | `src/agents/sandbox/validate-sandbox-security.ts` |
| 容器注册表 | `src/agents/sandbox/registry.ts` |
| 配置类型 | `src/config/types.sandbox.ts` |
| 常量定义 | `src/agents/sandbox/constants.ts` |
| 配置哈希 | `src/agents/sandbox/config-hash.ts` |
| 路径安全 | `src/agents/sandbox/fs-bridge-path-safety.ts` |
| 清理逻辑 | `src/agents/sandbox/prune.ts` |
| 作用域工具 | `src/agents/sandbox/shared.ts` |

---

## 验证方法

每个阶段完成后:
1. `docker inspect` 检查容器挂载和标签
2. `docker ps -a --filter "label=openclaw.sandbox=1"` 检查容器状态
3. `cat ~/.openclaw/sandbox/containers.json | jq .` 检查注册表
4. `ls -la ~/.openclaw/sandboxes/` 检查工作区目录
5. 关键输出保存到 `data/` 目录下对应阶段的文件中

---

## 报告结构

```
openclaw-sandbox-research/
├── report.md              # 主研究报告
├── data/
│   ├── phase0-baseline/   # 基线状态
│   ├── phase1-mounts/     # 挂载实验数据
│   ├── phase2-fsbridge/   # FS bridge 实验数据
│   ├── phase3-security/   # 安全边界测试数据
│   ├── phase4-scope/      # 作用域隔离数据
│   ├── phase5-lifecycle/  # 生命周期数据
│   ├── phase6-perf/       # 性能测试数据
│   └── phase7-proxy/      # 代理网络数据
└── config-backups/        # 配置文件备份
```
