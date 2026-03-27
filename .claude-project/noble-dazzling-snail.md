# WSBuffer 用户态模拟复现计划

## Context

复现 FAST'26 论文 "Rearchitecting Buffered I/O in the Era of High-Bandwidth SSDs" 的核心机制。论文提出 WSBuffer 架构优化 Linux 内核 buffered I/O 写路径。由于用户在 macOS 上无 NVMe SSD 阵列，采用用户态 C 程序模拟核心数据结构和算法逻辑，并通过对比测试验证性能优势。

## 项目结构

```
~/wsbuffer-sim/
├── Makefile
├── README.md
├── include/
│   ├── scrap_buffer.h      # Scrap Buffer 数据结构
│   ├── buffer_minimized.h  # Buffer-Minimized Data Access
│   ├── otflush.h           # OTflush 两阶段刷盘
│   ├── concurrent_mgmt.h   # Concurrent Page Management
│   ├── page_cache.h        # 传统 Page Cache 模拟（对照组）
│   └── common.h            # 通用定义（PAGE_SIZE, SCRAP_PAGE_SIZE 等）
├── src/
│   ├── scrap_buffer.c
│   ├── buffer_minimized.c
│   ├── otflush.c
│   ├── concurrent_mgmt.c
│   ├── page_cache.c        # 传统 buffered I/O 模拟
│   └── storage_backend.c   # 模拟 SSD 后端（文件模拟块设备）
├── bench/
│   ├── bench_main.c        # 主基准测试入口
│   ├── bench_throughput.c   # 吞吐量对比测试
│   ├── bench_latency.c     # 延迟对比测试
│   └── bench_partial.c     # Partial-page write 对比测试
└── test/
    └── test_main.c          # 单元测试
```

## 核心模块实现

### 1. Scrap Buffer（§3.2）
- **scrap-page 结构**: 128B header + 256KB data-zone
  - header: counter(4B) + number(1B) + ssd-id(2B) + tag(1B) + index entries(各8B, 最多19个)
  - data-zone: 存放实际写入数据
- **写入逻辑**: 按 offset 拆分到对应 scrap-page，merge-friendly 方式合并重叠 data-segments
- **批量分配**: 一次分配 32 个 scrap-page（4KB header area + 8MB data-zone area）
- **状态管理**: unfilled / full / flushing 三种状态，通过 tag field 标记

### 2. Buffer-Minimized Data Access（§3.3, Algorithm 1）
- **写机制**:
  - 小写入（< Req_Scrap_Size 阈值）→ 全部进 scrap buffer
  - 大写入 → Splitting_Write 拆分为 partial-scrap-page parts + scrap-page-aligned parts
  - Aligned 部分直接写 SSD（模拟为直接写文件）
  - Partial 部分进 scrap buffer
  - 回收被覆盖的旧 page cache pages
- **读机制**:
  - 先查 scrap buffer，若全部命中则直接读
  - 否则合并 scrap buffer + page cache + SSD 数据

### 3. OTflush 两阶段刷盘（§3.4）
- **Queue 管理**: Q1（unfilled pages）+ Q2（full pages）
- **Stage-1**: 对 Q1 中 unfilled scrap-page 执行 read-before-write，填充完整后移入 Q2
- **Stage-2**: 将 Q2 中 full scrap-page 以 data-zone 粒度批量写回 SSD
- **Load-aware 调度**: 根据 SSD 负载动态调整 flush 行为
- **异步执行**: 用 pthread 后台线程模拟异步刷盘

### 4. Concurrent Page Management（§3.5）
- **分离管理**: scrap buffer 和 page cache 使用独立的索引结构和锁
- **细粒度锁**: 用 per-page 或 per-group 锁替代全局锁，减少竞争
- **模拟锁竞争**: 多线程并发写入，对比全局锁 vs 细粒度锁的吞吐差异

### 5. 传统 Page Cache 模拟（对照组）
- 标准 4KB page 缓冲所有写入
- 全局 XArray 模拟索引 + 全局锁
- Dirty page flush 走单线程
- Partial-page write 触发同步 read-before-write

### 6. Storage Backend（模拟 SSD）
- 用本地文件模拟块设备
- 可配置读/写延迟（模拟 SSD 特性：高带宽但有延迟）
- 支持多"通道"并发（用多线程模拟 SSD 内部并行）

## 基准测试

### Test 1: 吞吐量对比（对应论文 Figure 1）
- 顺序写 2MB，1/2/4/8/16 线程
- 对比: Page Cache (传统) vs WSBuffer

### Test 2: 内存压力下的写性能（对应论文 Figure 2）
- 不同内存限额（10%-100%）下的写吞吐
- 对比内存利用率

### Test 3: Partial-page 写延迟（对应论文 Figure 3）
- 4KB/16KB/64KB/256KB/1MB/4MB partial-page 写
- 对比 full-page write vs partial-page write 延迟

### Test 4: 多线程并发扩展性
- 线程数从 1 增加到 16
- 对比全局锁 vs concurrent page management

## 实现步骤

1. **基础框架**: common.h 定义常量 + storage_backend.c 模拟 SSD
2. **传统 Page Cache**: 实现对照组
3. **Scrap Buffer**: 核心数据结构和写入/合并逻辑
4. **Buffer-Minimized Access**: 写拆分 + 读合并机制
5. **OTflush**: 两阶段异步刷盘
6. **Concurrent Page Management**: 细粒度锁
7. **基准测试**: 吞吐量、延迟、partial-page 对比
8. **结果输出**: CSV 格式，可用 gnuplot/matplotlib 绘图

## 编译与运行

```bash
cd ~/wsbuffer-sim
make            # 编译全部
./bench_main    # 运行基准测试
./test_main     # 运行单元测试
```

## 验证方式

1. 单元测试验证各模块的正确性（scrap buffer 写入/读取/合并）
2. 基准测试对比传统 page cache vs WSBuffer 的吞吐和延迟
3. 输出结果应体现论文中的核心趋势：WSBuffer 吞吐更高、partial-page 延迟更低
