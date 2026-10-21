# @timecat-js/bench

性能基准，用来验证 RFC 0001 第 8 节的性能目标：

- **录制基准**（`pnpm bench`）：在固定的夹具页面上执行同样的用户操作，测量录制器带来的主线程开销、长任务和数据量，和 rrweb 对比。
- **Seek 基准**（`pnpm bench:seek`）：录一段 1 小时的会话，测回放时跳到任意位置要多久。

## 运行

```bash
pnpm bench                                   # 全部场景和录制器，预热 1 轮 + 测量 5 轮，取中位数
pnpm bench --scenario mutations --runs 21    # 只跑指定场景，多跑几轮
pnpm bench --recorder timecat                # 只跑指定录制器（对照组 none 总会跑）
pnpm bench --cpu-throttle 4                  # 用 CDP 模拟 4 倍降速的 CPU（接近中端手机）
pnpm bench:seek                              # 1 小时会话，随机 seek 100 次
pnpm bench:seek --minutes 10 --cpu-throttle 4
pnpm bench:seek --live-rows 10               # 看板只有前 10 行在变，其余不动
```

需要 Playwright 的 Chromium。可以运行 `pnpm exec playwright install chromium` 安装；如果本机已经装好了 Chromium，也可以设置 `CHROMIUM_EXECUTABLE_PATH` 直接使用。结果会打印成表格，同时写入 `results/`（不纳入版本库）。

## 录制基准

### 场景

| 场景 | 夹具 | 操作 |
|---|---|---|
| `snapshot-large` | 1600 张商品卡片，约 5.1 万个节点 | 只开始录制，主要测全量快照 |
| `mutations` | 实时行情看板 | 300 帧：每帧改 20 个单元格、切换 10 行的 class、更新 1 个 style 动画，每 30 帧插入并移除列表项 |
| `typing` | 结账表单 | 8 个输入框共 191 次按键，加 1 次下拉选择和 1 次勾选 |
| `pointer-scroll` | 400 张商品卡片 | 以约 60Hz 移动指针 300 次，滚轮 20 次 |
| `canvas` | 960×540 的 2D Canvas 动画：渐变背景、120 个移动的标记和帧号 | 画 300 帧，每个动画帧一帧；录制器按 15 fps 录 Canvas |

每个场景完成**固定的工作量**，而不是持续固定的时长：录制器拖慢页面时，工作量不变，CPU 时间才有可比性。夹具里的随机数用固定种子生成，每次运行的变更完全相同。

### 录制器

| 录制器 | 说明 |
|---|---|
| `none` | 对照组：同样的页面和操作，不录制 |
| `rrweb` | `@rrweb/record` 2.1.7，开启 `maskAllInputs`，和 TimeCat 默认的隐私设置一致 |
| `timecat` | `@timecat-js/recorder` 的 `record()`，默认选项，连同 Worker 从源码打包 |

`canvas` 场景里两个录制器都录 Canvas：TimeCat 加上 `@timecat-js/plugin-canvas`（默认 15 fps），rrweb 开启 `recordCanvas`，按同样的 15 fps 采样，用 rrweb 文档建议的 WebP（质量 0.6）。

### 指标

| 指标 | 含义 |
|---|---|
| start | 启动录制那次调用阻塞主线程的时间。rrweb 的全量快照在这次调用里同步完成；TimeCat 的快照分片进行，这里只有启动 |
| main thread | 从开始录制到场景结束，页面主线程的任务总时长（CDP `Performance.getMetrics` 的 `TaskDuration`）。TimeCat 要等分片快照全部写完才算结束 |
| overhead | 减去对照组（`none`）的 main thread，即录制器自身的开销 |
| long tasks / longest | 录制期间超过 50ms 的长任务个数及最长一个的时长 |
| events | 录到的事件数 |
| raw / gzip | rrweb：事件序列化成 JSON 的大小，以及 gzip 之后的大小。TimeCat：各 chunk 解压后的大小，以及录制文件本身的大小（chunk 已经在 Worker 里逐个压缩过，文件就是要上传的数据） |
| serialize | 停止录制时，把录到的数据转成上传格式所花的主线程时间。rrweb 是 `JSON.stringify`；TimeCat 边录边编码，编码时间已经算在 main thread 里，这里只剩最后一次写出 |

测量上需要注意：

- 各录制器交替运行，机器状态的缓慢漂移会均匀影响所有录制器。
- 录制器必须在页面自己的任务里启动。通过 CDP `evaluate` 执行的任务不会被 Long Tasks API 上报，否则长任务会被漏统计。
- `TaskDuration` 只统计页面的主线程。TimeCat 在 Worker 里做的压缩和存储不算在内，这正是把它们移出主线程的目的；rrweb 停止后的 gzip 也不算。
- `mutations` 的噪声很大：页面自己每帧要布局约 6ms，单轮的 main thread 能差出 ±200ms，而 overhead 是两个中位数相减。比较这个场景要多跑几轮。

### 结果（2026-10-21）

- 环境：Chromium 141.0.7390.37 headless，Intel Xeon 2.8 GHz × 4 vCPU，不降速 CPU。
- 被测对象：`@rrweb/record` 2.1.7（开启 `maskAllInputs`）和 M1 的 `@timecat-js/recorder`。M2 的复测见下一节。
- 方法：`pnpm bench --runs 9`，预热 1 轮，测量 9 轮取中位数。

| 场景 | 录制器 | start | overhead | long tasks（最长） | 事件数 | raw | gzip | serialize |
|---|---|---|---|---|---|---|---|---|
| snapshot-large | rrweb | 583.6 ms | 591.2 ms | 1（584 ms） | 2 | 6895 KB | 256.7 KB | 205.9 ms |
| | TimeCat | 12.0 ms | 285.4 ms | 0 | 2 | 2945 KB | 64.9 KB | 0.2 ms |
| mutations | rrweb | 55.2 ms | 556.2 ms | 1（56 ms） | 302 | 953 KB | 126.6 KB | 15.6 ms |
| | TimeCat | 12.2 ms | 605.2 ms | 0 | 302 | 135 KB | 63.6 KB | 0.1 ms |
| typing | rrweb | 20.7 ms | 71.2 ms | 0 | 217 | 28 KB | 2.3 KB | 0.7 ms |
| | TimeCat | 7.3 ms | 60.1 ms | 0 | 34 | 2.3 KB | 1.1 KB | 0.1 ms |
| pointer-scroll | rrweb | 160.1 ms | 189.9 ms | 1（160 ms） | 37 | 1725 KB | 67.8 KB | 49.0 ms |
| | TimeCat | 12.9 ms | 106.6 ms | 0 | 29 | 741 KB | 18.5 KB | 0.3 ms |

`mutations` 的 overhead 单看这张表分不出高下。把 main thread 拆开（结果文件里有这几项），另跑 15 轮取中位数，单位 ms，括号里是比对照组多出的部分：

| 录制器 | main thread | script | layout | style |
|---|---|---|---|---|
| none | 4117 | 85 | 1807 | 166 |
| rrweb | 4584（+467） | 431（+346） | 1787 | 163 |
| TimeCat | 4448（+331） | 305（+220） | 1756 | 158 |

script 每轮都很稳定（rrweb 404–454，TimeCat 295–338）；layout 和 style 三组没有差别，但 layout 每轮能差出 ±300ms。所以 main thread 的波动来自页面自己的布局，而不是录制器；两个录制器的 main thread 分布大面积重叠，稳定的信号是 script：TimeCat 在这个场景里的脚本时间比 rrweb 少约 1/3。

几点观察：

- **长任务**：rrweb 的全量快照是同步完成的，在 5.1 万节点的页面上是一个约 580ms 的长任务，400 张卡片的页面上是 160ms，看板页上也有 55ms。TimeCat 的快照分片执行（RFC 0001 第 3.2 节），四个场景都没有超过 50ms 的任务。
- **主线程开销**：snapshot-large 和 pointer-scroll 分别是 rrweb 的 48% 和 56%，typing 低 16%，mutations 持平（脚本时间低约 1/3）。TimeCat 的 start 只有 7–13ms，主要是启动 Worker；serialize 不到 1ms，因为数据边录边编码，压缩在 Worker 里完成。
- **数据量**：gzip 后是 rrweb 的 25%–50%，快照的差距最大：5.1 万节点的页面是 64.9 KB 对 256.7 KB。
- **事件数**：typing 里 TimeCat 的事件少，是因为 Playwright 的按键之间没有间隔，写出要等这一串按键处理完，多次按键就合成一个输入事件，只记最终状态。按键之间隔 20ms 以上时，每次按键都单独写出：20 次按键是 20 个事件，和 rrweb 一样。
- 这个基准还测出过 M1 早期调度上的两个问题：每次指针移动都请求动画帧，让输入变慢；在动画帧里改 DOM 的页面，两帧的变更被合成一次写出。原因和改法见 RFC 0001 第 3.3 节。

### M2 复测（2026-10-21）

M2 的录制器多了 Shadow DOM、同源 iframe、CSSOM、字体和 `blob:` 内容的录制，以及插件接口（基准里不开插件）。环境和方法同上，重跑一遍：

| 场景 | 录制器 | start | overhead | long tasks（最长） | 事件数 | raw | gzip | serialize |
|---|---|---|---|---|---|---|---|---|
| snapshot-large | rrweb | 431.1 ms | 439.4 ms | 1（431 ms） | 2 | 6895 KB | 256.7 KB | 156.2 ms |
| | TimeCat | 12.6 ms | 225.8 ms | 0 | 2 | 2945 KB | 64.9 KB | 0.2 ms |
| mutations | rrweb | 38.7 ms | 338.0 ms | 0 | 302 | 953 KB | 126.5 KB | 11.2 ms |
| | TimeCat | 11.9 ms | 382.1 ms | 0 | 302 | 135 KB | 63.6 KB | 0.2 ms |
| typing | rrweb | 17.3 ms | 34.4 ms | 0 | 216 | 28 KB | 2.3 KB | 0.5 ms |
| | TimeCat | 6.7 ms | 22.0 ms | 0 | 29 | 2.2 KB | 1.0 KB | 0.2 ms |
| pointer-scroll | rrweb | 124.1 ms | 180.3 ms | 1（124 ms） | 36 | 1725 KB | 67.7 KB | 30.1 ms |
| | TimeCat | 12.4 ms | 109.5 ms | 0 | 29 | 741 KB | 18.5 KB | 0.3 ms |

pointer-scroll 一行是另跑 21 轮的结果：9 轮时 TimeCat 的 overhead 是 145.6ms，rrweb 165.4ms，差距比别的轮次小得多，多跑几轮回到了 M1 的水平。这次机器比测 M1 时快，对照组的 main thread 短了 14%–37%，所以只看和 rrweb 的相对关系：

- **数据量**和 M1 相同。新增的录制内容，这些页面用不到，也就不占数据。
- **长任务**仍然没有，start 仍在 7–13ms。
- **主线程开销**：snapshot-large 是 rrweb 的 51%（M1 是 48%），pointer-scroll 61%（56%），typing 64%（84%），mutations 多 13%（多 9%）。overhead 是两个中位数相减，噪声大；比较稳定的是 script 比对照组多出的部分：mutations 里 TimeCat 229ms、rrweb 300ms（M1 是 220ms 和 346ms），pointer-scroll 里 44ms 和 141ms（M1 是 42ms 和 176ms）。TimeCat 的脚本时间和 M1 基本持平，M2 新增的录制在这些页面上没有带来可见的开销。

### M3 复测（2026-10-21）

M3 的录制器多了插件的媒体轨和实时流用的同步点（基准里不开插件，也不开 `onData`）。环境同上；snapshot-large 和 pointer-scroll 跑 9 轮，噪声大的 mutations 和 typing 分别跑 15 轮和 21 轮：

| 场景 | 录制器 | start | overhead | long tasks（最长） | 事件数 | raw | gzip | serialize |
|---|---|---|---|---|---|---|---|---|
| snapshot-large | rrweb | 400.1 ms | 403.2 ms | 1（400 ms） | 2 | 6895 KB | 256.7 KB | 148.1 ms |
| | TimeCat | 12.3 ms | 207.9 ms | 0 | 2 | 2945 KB | 64.9 KB | 0.2 ms |
| mutations | rrweb | 35.9 ms | 246.3 ms | 0 | 302 | 953 KB | 126.5 KB | 10.6 ms |
| | TimeCat | 12.6 ms | 303.6 ms | 0 | 302 | 135 KB | 63.5 KB | 0.1 ms |
| typing | rrweb | 15.9 ms | 35.7 ms | 0 | 216 | 28 KB | 2.3 KB | 0.4 ms |
| | TimeCat | 6.3 ms | 28.5 ms | 0 | 27 | 2.1 KB | 1.0 KB | 0.2 ms |
| pointer-scroll | rrweb | 118.0 ms | 167.4 ms | 1（118 ms） | 35 | 1725 KB | 67.7 KB | 32.5 ms |
| | TimeCat | 13.2 ms | 119.8 ms | 0 | 29 | 741 KB | 18.5 KB | 0.3 ms |

- **数据量**和 M2 基本相同（typing 的事件数随按键合并的时机浮动），**长任务**仍然没有，start 仍在 6–14ms。
- **主线程开销**：snapshot-large 是 rrweb 的 52%（M2 是 51%），pointer-scroll 72%（61%），typing 80%（64%），mutations 多 23%（多 13%）。比较稳定的 script 比对照组多出的部分：mutations 里 TimeCat 193ms、rrweb 254ms（M2 是 229ms 和 300ms），pointer-scroll 里 43ms 和 133ms（44ms 和 141ms），typing 里 18ms 和 28ms。TimeCat 的脚本时间没有变多。mutations 里 TimeCat 多出的主线程时间不在脚本里，M2 时也是这样。

### Canvas（M3，2026-10-21）

环境同上，`pnpm bench --scenario canvas --runs 9`。300 帧约 5 秒，两个录制器都按 15 fps 录 Canvas：

| 录制器 | start | main thread | overhead | script | long tasks（最长） | 事件数 | 文件大小 | serialize |
|---|---|---|---|---|---|---|---|---|
| 对照组 | – | 952 ms | – | 113 ms | 0 | – | – | – |
| rrweb | 93.9 ms | 1193 ms | 241 ms | 222 ms | 1（94 ms） | 68 | 626.6 KB（gzip 后） | 7.0 ms |
| TimeCat | 6.2 ms | 1097 ms | 145 ms | 123 ms | 0 | 3 | 109.6 KB | 0.2 ms |

- **数据量**：TimeCat 是 rrweb 的 17%，约 175 kbps。plugin-canvas 用 WebCodecs 编成 VP9，帧间只存变化；rrweb 每帧存一张 WebP，转成 base64 放进 JSON，gzip 也压不动。
- **主线程**：TimeCat 的脚本时间只比对照组多 10ms，rrweb 多 110ms。编码在浏览器的编码器里完成，不占页面的主线程；TimeCat 多出的 main thread 有九成以上不在脚本里，是浏览器自己的任务，应该是 `captureStream` 每帧复制画面的开销。rrweb 开始录制时有一个 94ms 的长任务。
- 事件数只算 TimeCat 的事件：视频的 packet 不是事件，写在媒体 chunk 里。

## Seek 基准

- 在看板夹具（`dashboard.html`）上录一段 60 分钟、每秒 10 帧的会话，共 3.6 万帧，每帧的变更和 `mutations` 场景相同。录制用的是 `record()` 内部同样的 Capture 和 Pipeline，只是时钟由基准自己推进，所以一小时的会话十几秒就能录完。
- 用 `@timecat-js/player-core` 加载录制（在 Worker 里建索引、生成关键帧），再按固定种子随机 seek 100 次，一次接一次。每次 seek 的耗时包括 seek 之后的样式计算和布局。
- 关键帧间隔用 player-core 的默认值，可以用 `--keyframe-interval` 修改。`--cpu-throttle` 在录制之后才生效，只影响回放。
- 看板的 200 行默认全都在变，两个关键帧之间 1000 个单元格几乎都改过一遍。`--live-rows N` 只让前 N 行变化，其余保持原样，模拟只有局部在变的页面。

2026-10-21 实测，环境同上，M2 的 `@timecat-js/player-core`：

| 变化的行 | CPU | 录制大小 | 加载 | seek 中位数 | p95 | 最慢 | 超过 300ms |
|---|---|---|---|---|---|---|---|
| 全部 200 行 | 不降速 | 7.5 MB | 3.0 s | 40.9 ms | 64.3 ms | 76.5 ms | 0 |
| | 降速 4 倍 | 7.5 MB | 3.9 s | 257.9 ms | 375.3 ms | 413.7 ms | 22 次 |
| 前 10 行 | 不降速 | 5.5 MB | 2.1 s | 15.4 ms | 30.3 ms | 35.7 ms | 0 |
| | 降速 4 倍 | 5.5 MB | 2.8 s | 84.3 ms | 145.2 ms | 190.7 ms | 0 |

M1 在同一台机器上的结果是全部行、不降速时中位数 47.5ms，降速 4 倍时 265.1ms、21 次超过 300ms。加载要把整个录制过一遍，时间随录制长度增长。

M3 复测（2026-10-21，全部行）。M3 为了实时回放，把建索引改成了一段一段增量进行：

| CPU | 录制大小 | 加载 | seek 中位数 | p95 | 最慢 | 超过 300ms |
|---|---|---|---|---|---|---|
| 不降速 | 7.5 MB | 3.0 s | 37.8 ms | 53.9 ms | 57.5 ms | 0 |
| 降速 4 倍 | 7.5 MB | 3.3 s | 205.6 ms | 277.2 ms | 314.3 ms | 3 次 |

加载和 seek 都没有变慢。降速 4 倍这一轮比 M2 那一轮好不少，但下面说过，这台机器同样的配置在不同时间能差出几十毫秒，不要当成 M3 的改进。

M2 恢复关键帧时不再整棵重建，而是把页面改成关键帧的样子，id 相同的节点留下（RFC 0001 第 8 节）。它对两种页面的效果不同：

- **只有局部在变**（前 10 行）：留下的节点不用重新算样式、布局和绘制。降速 4 倍、开着 profiler 对比，seek 中位数从约 214ms 降到约 103ms，布局、样式和绘制的时间分别少了 72%、83% 和 52%。
- **整页都在变**（全部行）：两个关键帧之间几乎每个单元格都换过文字，节点留下了，表格还是要整个重新布局和绘制。新旧实现交替各跑两轮，降速 4 倍时中位数是 219/244ms 对 230/221ms，没有差别。这时主线程的时间八成以上花在浏览器的样式、布局和绘制上，构建 DOM 的脚本只占一成多，所以 CPU 降速 4 倍时仍有约两成 seek 超过 300ms。

这些数字和机器有关，只用来在同一台机器上做相对比较。这台虚拟机的噪声也不小：同样的配置，降速 4 倍的中位数在不同时间运行能差出几十毫秒，比较两种实现要交替多跑几轮。
