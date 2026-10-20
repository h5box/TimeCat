# @timecat-js/bench

录制器性能基准：在固定的夹具页面上执行同样的用户操作，测量录制器带来的主线程开销、长任务和数据量。用来给 TimeCat 定性能目标，并和 rrweb 对标（RFC 0001 第 7、8 节）。

## 运行

```bash
pnpm bench                                   # 全部场景，预热 1 轮 + 测量 5 轮，取中位数
pnpm bench --scenario mutations --runs 10    # 只跑指定场景
pnpm bench --cpu-throttle 4                  # 用 CDP 模拟 4 倍降速的 CPU（接近中端手机）
```

需要 Playwright 的 Chromium。可以运行 `pnpm exec playwright install chromium` 安装；如果本机已经装好了 Chromium，也可以设置 `CHROMIUM_EXECUTABLE_PATH` 直接使用。结果会打印成表格，同时写入 `results/`（不纳入版本库）。

## 场景

| 场景 | 夹具 | 操作 |
|---|---|---|
| `snapshot-large` | 1600 张商品卡片，约 5.1 万个节点 | 只开始录制，主要测全量快照 |
| `mutations` | 实时行情看板 | 300 帧：每帧改 20 个单元格、切换 10 行的 class、更新 1 个 style 动画，每 30 帧插入并移除列表项 |
| `typing` | 结账表单 | 8 个输入框共 191 次按键，加 1 次下拉选择和 1 次勾选 |
| `pointer-scroll` | 400 张商品卡片 | 以约 60Hz 移动指针 300 次，滚轮 20 次 |

每个场景完成**固定的工作量**，而不是持续固定的时长：录制器拖慢页面时，工作量不变，CPU 时间才有可比性。夹具里的随机数用固定种子生成，每次运行的变更完全相同。

## 指标

| 指标 | 含义 |
|---|---|
| start | 启动录制那次调用阻塞主线程的时间（rrweb 的全量快照在这次调用里同步完成） |
| main thread | 从开始录制到场景结束，页面主线程的任务总时长（CDP `Performance.getMetrics` 的 `TaskDuration`） |
| overhead | 同一场景下减去对照组（`none`，不录制）的主线程时长，即录制器自身的开销 |
| long tasks / longest | 录制期间超过 50ms 的长任务个数及最长一个的时长 |
| raw / gzip | 录到的数据按上传格式序列化后的大小，以及 gzip 之后的大小 |
| serialize | 把录到的数据转成上传格式所花的主线程时间 |

测量上有两点需要注意：

- 各录制器交替运行，机器状态的缓慢漂移会均匀影响所有录制器。
- 录制器必须在页面自己的任务里启动。通过 CDP `evaluate` 执行的任务不会被 Long Tasks API 上报，否则长任务会被漏统计。

## rrweb 基线

2026-10-20 实测：

- 环境：Chromium 141.0.7390.37 headless，Intel Xeon 2.8 GHz × 4 vCPU，不降速 CPU。
- 被测对象：`@rrweb/record` 2.1.7，开启 `maskAllInputs`，与 TimeCat 默认的隐私设置一致。
- 方法：预热 1 轮，测量 5 轮取中位数。

| 场景 | start | overhead | long tasks（最长） | 事件数 | raw | gzip | serialize |
|---|---|---|---|---|---|---|---|
| snapshot-large | 395.7 ms | 399.8 ms | 1（396 ms） | 2 | 6895 KB | 256.7 KB | 197.0 ms |
| mutations | 39.2 ms | 346.3 ms | 0 | 302 | 953 KB | 126.5 KB | 11.3 ms |
| typing | 16.6 ms | 53.8 ms | 0 | 216 | 28 KB | 2.3 KB | 0.5 ms |
| pointer-scroll | 129.3 ms | 152.8 ms | 1（130 ms） | 36 | 1726 KB | 67.8 KB | 29.8 ms |

几点观察：

- rrweb 的全量快照是同步完成的，在大页面上会产生一个约 400ms 的长任务。TimeCat 的快照分片执行，目标是没有任何超过 50ms 的长任务（RFC 0001 第 3.2 节）。
- 数据量的大头是快照：5.1 万节点的快照 gzip 后为 257 KB，TimeCat 的编码原型在同一页面上是 86 KB（RFC 0001 附录 A）。
- 开销小的场景（如 typing）噪声相对较大，比较时要多跑几轮。

这些数字和机器有关，只用来在同一台机器上做相对比较。
