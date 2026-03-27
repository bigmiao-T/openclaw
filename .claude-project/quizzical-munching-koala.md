# 研究计划：LangGraph Checkpoint 机制 + OpenClaw 对接 + 文件读写性能测试 Agent

## Context

用户需要研究 LangGraph 的 checkpoint 机制，并探索如何将其与 OpenClaw 对接，最终创建一个 LangGraph agent 来测试 checkpoint 对文件读写速度的影响。项目 `openclaw-storage` 下已有 LangGraph 源码（`langgraph/` 目录）和 OpenClaw 源码（`openclaw/` 目录）。

## 第一部分：LangGraph Checkpoint 机制研究报告

在项目根目录创建 `docs/langgraph-checkpoint-research.md`，内容包括：

### 核心概念总结
- **BaseCheckpointSaver**：基类，定义 `get_tuple`/`put`/`put_writes`/`list` 等接口
  - 源码：`langgraph/libs/checkpoint/langgraph/checkpoint/base/__init__.py`
- **Checkpoint TypedDict**：状态快照结构（`v`, `id`, `ts`, `channel_values`, `channel_versions`, `versions_seen`）
- **CheckpointTuple**：包含 config、checkpoint、metadata、parent_config、pending_writes
- **thread_id**：checkpoint 的主键，通过 `config["configurable"]["thread_id"]` 传入
- **序列化**：默认使用 `JsonPlusSerializer`（msgpack），支持 `EncryptedSerializer`

### 三种内置实现
1. **InMemorySaver**（`langgraph/libs/checkpoint/langgraph/checkpoint/memory/__init__.py`）—— 内存存储，测试用
2. **SqliteSaver**（`langgraph/libs/checkpoint-sqlite/`）—— SQLite 持久化
3. **PostgresSaver**（`langgraph/libs/checkpoint-postgres/`）—— Postgres 持久化

### 工作流程
- `StateGraph.compile(checkpointer=saver)` 编译时注入 checkpointer
- 每个 step 执行后，pregel loop 调用 `create_checkpoint()` 创建快照，再调用 `saver.put()` 持久化
- 恢复时通过 `saver.get_tuple(config)` 按 thread_id + checkpoint_id 加载

## 第二部分：OpenClaw 对接方案

### 架构设计

```
OpenClaw (TypeScript)                    Python 独立服务
┌─────────────────┐                    ┌──────────────────────┐
│  agent-command   │ ── HTTP/子进程 ──> │  FastAPI Server      │
│  (TypeScript)    │ <── JSON 响应 ──── │  ├─ LangGraph Agent  │
└─────────────────┘                    │  ├─ Checkpoint Saver  │
                                       │  └─ State Management  │
                                       └──────────────────────┘
```

### 创建文件
在 `openclaw-storage/langgraph-bridge/` 下创建独立 Python 项目：

1. **`pyproject.toml`** —— 项目依赖配置
   - 依赖：`langgraph`, `langgraph-checkpoint`, `langgraph-checkpoint-sqlite`, `fastapi`, `uvicorn`
   - 使用本地 langgraph 源码（`path = "../langgraph/libs/langgraph"` 等）

2. **`server.py`** —— FastAPI 服务入口
   - `POST /agent/invoke` —— 执行 agent，传入 thread_id + 输入
   - `GET /agent/state/{thread_id}` —— 获取某个 thread 的 checkpoint 状态
   - `GET /agent/history/{thread_id}` —— 获取 checkpoint 历史

3. **`agent.py`** —— LangGraph agent 定义
   - 使用 `StateGraph` 构建 agent
   - 编译时注入 `SqliteSaver` 作为 checkpointer

## 第三部分：文件读写性能测试 Agent

### 目标
测试 **有 checkpoint vs 无 checkpoint** 对文件读写操作速度的影响。

### Agent 设计（`langgraph-bridge/file_benchmark_agent.py`）

```
StateGraph 结构:
  START -> generate_test_data -> write_files -> read_files -> analyze_results -> END
```

**State 定义：**
```python
class BenchmarkState(TypedDict):
    file_sizes: list[int]           # 要测试的文件大小列表（bytes）
    write_results: list[dict]       # 写入结果 {size, duration, throughput}
    read_results: list[dict]        # 读取结果
    test_dir: str                   # 临时测试目录
    summary: str                    # 最终分析摘要
```

**4 个节点：**
1. `generate_test_data` —— 生成不同大小的测试数据（1KB, 10KB, 100KB, 1MB, 10MB）
2. `write_files` —— 写入文件并计时，记录每个大小的写入速度
3. `read_files` —— 读取文件并计时，记录每个大小的读取速度
4. `analyze_results` —— 汇总对比数据，输出性能报告

### 测试脚本（`langgraph-bridge/run_benchmark.py`）

运行两轮测试：
1. **有 checkpoint**：`graph.compile(checkpointer=SqliteSaver.from_conn_string("benchmark.db"))`
2. **无 checkpoint**：`graph.compile()` （不传 checkpointer）

对比输出：
- 各节点执行时间
- 总执行时间差异
- checkpoint 序列化/反序列化开销占比

## 要创建的文件清单

| 文件 | 说明 |
|------|------|
| `langgraph-bridge/pyproject.toml` | Python 项目配置 |
| `langgraph-bridge/server.py` | FastAPI 服务（OpenClaw 对接入口） |
| `langgraph-bridge/agent.py` | 基础 LangGraph agent |
| `langgraph-bridge/file_benchmark_agent.py` | 文件读写性能测试 agent |
| `langgraph-bridge/run_benchmark.py` | 性能测试运行脚本 |
| `docs/langgraph-checkpoint-research.md` | Checkpoint 机制研究报告 |

## 关键源码引用

- Checkpoint 基类：`langgraph/libs/checkpoint/langgraph/checkpoint/base/__init__.py`
- InMemorySaver：`langgraph/libs/checkpoint/langgraph/checkpoint/memory/__init__.py`
- StateGraph.compile：`langgraph/libs/langgraph/langgraph/graph/state.py:1038`
- Pregel checkpoint 逻辑：`langgraph/libs/langgraph/langgraph/pregel/_checkpoint.py`
- 预构建 agent：`langgraph/libs/prebuilt/langgraph/prebuilt/chat_agent_executor.py`

## 验证方式

1. 安装依赖：`cd langgraph-bridge && pip install -e .`
2. 运行性能测试：`python run_benchmark.py`，确认输出对比报告
3. 启动服务：`python server.py`，用 curl 测试 `/agent/invoke` 接口
4. 验证 checkpoint 持久化：重启服务后通过 `/agent/state/{thread_id}` 恢复之前的状态
