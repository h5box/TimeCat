# RFC 0001：TimeCat Next 架构与技术选型

| 状态 | 草案，待确认 |
|---|---|
| 日期 | 2026-10-20 |
| 范围 | 从零重写录制 / 回放 SDK，并为服务端与 AI 能力预留接口 |

> 文中的版本号和浏览器兼容数据都是 2026-10-20 实际查询的结果，来源是 npm registry、MDN browser-compat-data 8.1.6 和 web-features 3.43.0。性能数据来自附录 A 的实测。

## 0. 结论速览

TimeCat Next 的定位是**高性能、隐私默认安全、面向 AI 分析设计**的网页会话录制回放工具。六个核心决策：

1. **主线程只做 DOM 访问。** 遍历 DOM 的同一趟里直接编码成二进制，再零拷贝转交 Worker；压缩、存储、上传全部在 Worker 里完成。
2. **快照分片执行。** 实测 5.1 万节点光是遍历就要约 55ms，不切片必然产生长任务。
3. **自研二进制分块格式 TCR。** 字符串表 + 隐式节点 ID + varint，高频流用列式差分。实测快照比 1.x 格式小 2.5–3.5 倍、解码快 2.2 倍以上，鼠标轨迹小 6 倍。
4. **媒体交给浏览器原生编解码器。** Canvas 和视频走 WebCodecs（MediaRecorder 兜底），音频用 Opus/AAC。不再劫持绘图 API，也不再用 base64 存 PCM。
5. **隐私和回放安全默认开启。** 输入默认脱敏，密码永远脱敏；回放沙箱里禁止执行脚本。
6. **为 AI 准备好数据。** 录像可以转成紧凑的"语义转写"，交给 Claude 生成摘要、复现步骤和测试用例；再通过 MCP 让 AI Agent 直接查询真实会话。

工程工具链统一换成新一代原生工具：Node 24 LTS、pnpm 12、TypeScript 7（原生编译器）、Rolldown 内核（tsdown + Vite 8）、Oxc（oxlint + oxfmt）、Vitest 5 Browser Mode、Playwright。

## 1. 目标与非目标

**目标**

- 录制对页面性能几乎无感：不产生由录制引起的 >50ms 长任务；主线程核心包 ≤ 15 KB（gzip）。
- 数据体积小，能流式传输，能随机 seek。
- 隐私默认安全，敏感数据不离开页面。
- 回放保真度高且安全：永远不执行录到的脚本。
- 覆盖现代 Web：Shadow DOM、Constructable Stylesheets、CSS-in-JS、SPA 导航、Canvas/WebGL。
- 录制数据可以直接用于 AI 分析和排障。

**非目标（首期）**

- 原生 App、小程序录制。
- 跨域 iframe 自动录制。这需要子页面也接入 SDK，再通过 postMessage 汇合。
- 读取 TimeCat 1.x 的数据。如有需要另做独立转换器，不污染新格式。

## 2. 总体架构

```
┌─ 被录制页面 · 主线程（只做必须碰 DOM 的事）─────────────────────┐
│ MutationObserver / 事件监听 / CSSOM 与 Shadow DOM 补丁              │
│ → 分片快照 + 按帧合并的增量 → 隐私脱敏 → 单遍二进制编码             │
└──────────────┬───────────────────────────────────────────────────┘
               │ postMessage(ArrayBuffer, [transfer])，零拷贝
┌──────────────▼─ Recorder Worker ──────────────────────────────────┐
│ 分轨缓冲 → CompressionStream('gzip') → OPFS 追加写入 → 上传 / 导出   │
└──────────────┬───────────────────────────────────────────────────┘
               │ TCR 分块容器：HTTP 上传 / 本地文件 / 实时流
┌──────────────▼─ 回放端 ───────────────────────────────────────────┐
│ Player Worker：流式解压、解码、构建 seek 索引（虚拟 DOM 快进）       │
│ 主线程：在无脚本的 sandbox iframe 中物化 DOM，时间轴调度，光标叠加层 │
│ UI：<timecat-player> Web Component                                │
└──────────────┬───────────────────────────────────────────────────┘
               │ M4 起
┌──────────────▼─ 服务端与 AI ──────────────────────────────────────┐
│ 接入 API → 对象存储 + PostgreSQL 索引 → 语义转写 → Claude 分析       │
│ MCP Server：AI Agent 直接检索、复盘真实用户会话                      │
└──────────────────────────────────────────────────────────────────┘
```

## 3. 关键设计决策

### 3.1 线程模型：主线程只做 DOM 访问

DOM 只能在主线程读取，这部分成本转移不了；压缩、持久化、网络这些工作都可以、也应该放进 Worker。附录 A 的实测表明，**把对象树交给 Worker 这一步本身就很贵**：`postMessage` 的结构化克隆和 `JSON.stringify` 差不多耗时。所以最优做法是在遍历 DOM 的同一趟里直接写二进制，然后以 transfer 的方式零拷贝交出去。

| 主线程总耗时（含 DOM 遍历） | 1.28 万节点 | 5.1 万节点 |
|---|---|---|
| 遍历 + JSON.stringify + TextEncoder（1.x 的思路） | 32.7 ms | 126.7 ms |
| 遍历 + structuredClone（直接 postMessage 对象） | 26.4 ms | 121.5 ms |
| 遍历 + msgpackr，transfer | 23.3 ms | 88.9 ms |
| **单遍二进制编码，transfer** | **22.4 ms** | **74.1 ms** |

### 3.2 快照：分片执行 + 一致性协议

5.1 万节点光遍历就要约 55ms，换什么编码都绕不开。所以全量快照按时间片执行，每片 ≤ 8ms，片与片之间让出主线程。让出方式优先用 `scheduler.yield()`（Chrome 129+、Firefox 142+）；Safari 不支持，降级为 `MessageChannel` 宏任务。

分片期间页面还在变化，一致性规则如下：

- 开始遍历之前先挂上 MutationObserver。
- 变更发生在**还没访问**的区域：直接丢弃，稍后访问时自然会拿到最新状态。
- 变更发生在**已经访问**的区域：排队，快照结束后作为增量输出。
- 节点在两个区域之间移动：拆成"移除 + 新增"两步处理。

这是录制端最容易出错的部分，要用基于性质的测试兜底：用 fast-check 生成随机的 DOM 变更序列，录制、回放，再比对 DOM。小页面如果预计不到一个时间片就能完成，直接同步做完。

### 3.3 增量：按帧合并

MutationObserver 的回调里只把记录放进队列，不做处理；每个动画帧统一调用一次 `takeRecords()` 处理。后台标签页没有 rAF，用定时器兜底。这样做的好处：

- 一帧内对同一个节点的多次属性修改，只输出最终值。对动画多的页面收益很大。
- 新增的子树只在帧末序列化一次，同一批里对它内部的后续变更自动去重。
- 每帧的录制开销有上限，可以监控，也可以降级，比如超出预算时降低采样率。

### 3.4 数据格式：TCR（TimeCat Recording）

**编码**

- 字符串表：标签名、属性名、较短的属性值（如 class 列表）第一次出现时内联写入，之后只写索引。
- 隐式节点 ID：快照按 DFS 顺序分配 ID，ID 本身不写进数据，解码时按同样的顺序重建。
- 整数统一用 LEB128 varint。
- 高频流（指针、滚动）列式存储：时间、x、y 各成一列，只存差值，再做 zigzag + varint。

**容器**

- 结构是文件头（magic、格式版本、会话元信息）加若干 chunk。
- 每个 chunk 包含轨道 ID、时间范围、关键帧标记、编码信息和独立压缩的负载。字符串表的作用域是单个 chunk，保证**每个 chunk 都能独立解码**。这是流式播放、随机访问和断点续传的前提。
- 每个 chunk 压缩后控制在 64 KB 以内，因为页面卸载时 `fetch(keepalive)` 的发送上限就是 64 KB。
- 轨道包括：`dom`、`input`、`pointer`、`scroll`、`viewport`、`navigation`、`console`、`network`、`perf`、`custom`、`canvas:<id>`、`video:<id>`、`audio`、`assets`。
- 格式带版本号，事件类型只增不改。另提供 CLI，把 TCR 转成 JSON 方便调试。

**压缩**

浏览器端用原生的 `CompressionStream('gzip')`：三大引擎都支持，不增加包体积。brotli 在 Chrome 上不可用，zstd 还没有任何浏览器正式支持，所以都不考虑。服务端如果想省存储，可以再转存成 zstd。

**实测收益（附录 A）**

| | 1.x 风格 JSON | TCR 原型 | 提升 |
|---|---|---|---|
| 快照 gzip 后体积（1.28 万 / 5.1 万节点） | 89.5 / 302.0 KB | 35.5 / 86.0 KB | 2.5× / 3.5× |
| 回放端解压 + 解码（1.28 万 / 5.1 万节点） | 21.3 / 75.9 ms | 8.9 / 33.8 ms | 2.4× / 2.2× |
| 2 万次鼠标移动 gzip 后体积 | 156.0 KB | 24.7 KB | 6.3× |

**明确不做的事**

- 不用 msgpackr 之类的通用二进制库。实测自研格式压缩后要小 2.1–2.9 倍，而且没有依赖。
- 录制 SDK 不引入 WASM。瓶颈在 DOM 访问，不在计算；WASM 只会增加体积和启动成本。

### 3.5 媒体：交给浏览器原生编解码器

- **Canvas（2D / WebGL）和 `<video>` 的画面**录成视频轨。优先用 WebCodecs 的 `VideoEncoder`，通过 `isConfigSupported()` 在 AV1、VP9、H.264 中选一个（可以用上硬件加速）。Firefox Android 没有 WebCodecs，用 MediaRecorder 兜底。旧版逐条劫持 2D/WebGL 绘图 API 的方案开销大、还原度差，彻底放弃。
- **`<video>` 默认只录播放状态**，即 src、播放、暂停、跳转、倍速，开销最小。需要像素级还原时才开启画面捕获。
- **麦克风旁白**用 MediaRecorder 输出 Opus，Safari 上输出 AAC。旧版把 8kHz 的 Float32 PCM 做 base64 后存储，约 341 kbps，而且只有电话音质；32 kbps 的 Opus 体积约为其 1/10，音质还是全频带的。
- 所有媒体都以二进制轨存储，不做 base64。

### 3.6 隐私：默认安全

- 所有输入值默认脱敏；`type=password` 永远脱敏，不能关闭。
- 提供三类选择器：`maskText` 让文本脱敏，`block` 把元素整块替换成同尺寸占位块，`ignore` 不录该元素的输入。
- 脱敏在主线程编码之前完成，敏感明文不会进入任何缓冲区。
- 网络请求默认只录元数据（方法、URL、状态码、耗时、大小），URL 查询参数按规则脱敏。请求体和响应体需要显式开启，并受白名单和大小上限约束。

### 3.7 回放安全模型

- 旧版的回放 iframe 同时开了 `allow-scripts` 和 `allow-same-origin`，按 HTML 规范这等于没有沙箱。新版 sandbox **不开 `allow-scripts`**：DOM 由父页面直接构建，录到的任何脚本都不会执行。
- 回放文档注入 CSP，作为第二道防线；物化时丢弃 `on*` 属性和 `javascript:` URL。
- 外部资源（图片、字体、样式）可以经可配置的代理加载，避免看录像时把查看者的 IP 暴露给第三方，或触发意料之外的请求。
- 回放内容上面盖一层透明的交互层，回放内容本身不接收任何用户输入。

### 3.8 覆盖现代 Web 平台

| 能力 | 方案 |
|---|---|
| Shadow DOM | 给 `attachShadow` 打补丁，逐个观察 open shadow root；closed shadow root 要求 SDK 在页面脚本之前初始化 |
| Constructable Stylesheets / `adoptedStyleSheets` | 给 setter 和 `replace` / `replaceSync` 打补丁（已是 Baseline 广泛可用） |
| CSS-in-JS（生产环境用 `insertRule` 注入样式） | 给 `CSSStyleSheet.prototype.insertRule` / `deleteRule` 打补丁 |
| 同源 iframe | 递归录制，共享同一个会话；跨域 iframe 需要子页面接入 SDK |
| 字体 | 给 `FontFace` / `document.fonts.add` 打补丁，CSS 里的 URL 转成绝对路径 |
| `blob:` 资源 | 会话结束后就失效，所以抓取存到 `assets` 轨 |
| SPA 导航 | 优先用 Navigation API（Baseline 2026），降级为 `history` 补丁 + `popstate` |
| 移动端缩放 | `visualViewport` |

### 3.9 Seek：在 Worker 里虚拟快进

回放端的 Worker 维护一棵轻量的虚拟树。加载录像时，它按变更量自适应地生成"合成关键帧"，以压缩后的 TCR 快照形式放在内存里。seek 时先物化最近的关键帧，再在真实 DOM 上应用少量尾部事件。这样录制端就不必周期性地做全量快照，主线程更轻。长会话的关键帧也可以由服务端离线预先算好。

### 3.10 排障和 AI 需要的上下文

需要采集的上下文包括：`console`、未捕获的错误和 Promise 拒绝、网络请求、性能指标、业务自定义事件。性能指标里，INP 和 LCP 从 Safari 26.2 起也能采到，CLS 和 LoAF 只有 Chromium 提供。这些数据都按轨道存储，都以插件形式提供，按需启用。

## 4. 技术栈

### 4.1 工程工具链

| 领域 | 选择 | 当前版本 | 理由 |
|---|---|---|---|
| 运行时 | Node.js 24 LTS | 24.22 | 当前的 Active LTS；等 Node 26 进入 LTS 再升级 |
| 包管理 | pnpm workspaces + catalogs | 12.14 | 依赖隔离严格，catalog 统一各包的依赖版本 |
| 语言 | TypeScript 7（原生编译器），开启 strict 和 `isolatedDeclarations` | 7.0.2 | 类型检查大幅提速（官方称约 10 倍）；`isolatedDeclarations` 让 `.d.ts` 可以直接由 Oxc 生成 |
| 库构建 | tsdown（Rolldown + Oxc） | 0.23 | 和 Vite 8 是同一个引擎，ESM 输出和 `.d.ts` 打包一步完成 |
| 演示站 / 控制台 | Vite 8 | 8.3 | 底层已换成 Rolldown 1.x |
| Lint | oxlint + oxlint-tsgolint（类型感知） | 1.89 / 7.0 | typescript-eslint 只支持到 TS 6.0；tsgolint 基于 typescript-go |
| 格式化 | oxfmt（锁定精确版本） | 0.74 | 与 Prettier 兼容，同属 Oxc 工具链；还没到 1.0，出问题可以无痛切回 Prettier |
| 单元 / 组件测试 | Vitest 5；DOM 相关测试用 Browser Mode + Playwright | 5.0 | 在真实浏览器里测 DOM，不再依赖 jsdom 模拟 |
| E2E / 保真 / 性能基准 | Playwright | 1.64 | Chromium、Firefox、WebKit 三个引擎 |
| 版本与发布 | Changesets | 3.0 | 管理 monorepo 的版本号和 CHANGELOG |
| 包质量 | size-limit、publint、arethetypeswrong、knip | — | 体积预算、导出和类型正确性、死代码检测 |
| CI | GitHub Actions | — | 三浏览器矩阵，性能和体积回归时直接失败 |

暂不引入 Turborepo：十个以内的包，用 `pnpm -r` 按拓扑顺序构建就够了，等构建时间真成了瓶颈再加。

### 4.2 运行时依赖

`protocol`、`recorder`、`player-core` 不依赖任何第三方运行时库。回放 UI 只依赖 Lit 3，实测一个最小组件打包后约 6 KB（gzip）。Lit 基于原生 Web Components，可以嵌进 React、Vue 或任何框架的页面。

### 4.3 浏览器支持策略

**录制端基线：2023 年上半年发布的浏览器版本**，即 Chrome / Edge 111+、Firefox 115+（ESR）、Safari / iOS 16.4+。所需的能力在这条基线上全部可用：

| 能力 | 支持情况 |
|---|---|
| CompressionStream（gzip / deflate-raw） | Baseline 广泛可用（Chrome 80/103、Firefox 113、Safari 16.4） |
| 模块 Worker | Baseline 广泛可用（Firefox 114、Safari 15） |
| OPFS + `createSyncAccessHandle` | Baseline 广泛可用（Chrome 102、Firefox 111、Safari 15.2） |
| Constructable Stylesheets | Baseline 广泛可用（Firefox 101、Safari 16.4） |
| WebCodecs `VideoEncoder` | Chrome 94、Firefox 130（仅桌面）、Safari 16.4；缺失时降级 |

渐进增强：
- `scheduler.yield()` 缺失时用 MessageChannel。
- Navigation API 缺失时给 `history` 打补丁。
- WebCodecs 缺失时用 MediaRecorder。
- OPFS 不可用（比如部分隐私模式）时退到 IndexedDB，再不行就只存在内存里。

低于基线的浏览器上，SDK 静默不启用，绝不影响页面本身。

**回放端**支持各主流浏览器的最近两个版本。回放端面向开发者和分析人员，不需要照顾老旧浏览器。

### 4.4 服务端与控制台（M4，暂定）

| 层 | 选择 | 理由 |
|---|---|---|
| 接入与 API | Hono 4，跑在 Node 24 上 | 轻量、性能好，以后可以迁到 Bun、Workers 或 Deno |
| 录像存储 | S3 兼容的对象存储（S3 / R2 / MinIO） | chunk 天然适合放对象存储，支持 Range 读取 |
| 元数据与索引 | PostgreSQL + Drizzle ORM | 会话、事件索引、AI 结果统一管理，自带全文检索 |
| 任务队列 | pg-boss | 基于 Postgres，转写和 AI 任务不需要额外引入 Redis |
| 控制台 | React 19 + Vite 8 + TanStack Router + Tailwind CSS 4 | 生态最大，直接嵌入 `<timecat-player>` |
| 部署 | Docker Compose 一键自托管 | Postgres + MinIO + 应用 |
| 规模化分析（按需） | ClickHouse | 事件量上来之后再引入 |

## 5. AI 层设计

### 5.1 核心原则：不把原始 DOM 交给模型

直接喂 DOM 既贵，又会泄露隐私。做法是先从录像里提取**语义转写**：用户操作的目标元素用可访问名称（role + 名称）来描述，再和网络、控制台、性能事件按时间合并。元素名称可以在服务端用回放引擎重建当时的 DOM 后再计算，**录制端没有任何额外开销**。

```
00:03  进入 /checkout「结算」
00:05  点击 button「立即支付」
00:05  POST /api/pay → 500（230ms）
00:06  console.error  TypeError: Cannot read properties of undefined (reading 'id')  app.js:123
00:08  连续点击 button「立即支付」×4（2 秒内，疑似狂点）
00:15  离开页面
```

一小时的会话，转写下来通常只有几千个 token。

### 5.2 能力

| 能力 | 实现方式 |
|---|---|
| 会话摘要、章节、卡点、错误归因 | 单次调用 + 结构化输出（Zod schema），结果写回数据库，章节和卡点标注在播放器时间轴上 |
| 生成 Bug 复现步骤和 Playwright 测试 | 由代码控制的闭环：生成用例 → 在预发环境执行 → 把失败信息回灌给模型，最多 N 轮 |
| 批量分析 | Message Batches API：价格减半，异步执行，大多数批次一小时内完成 |
| MCP Server | 提供 `search_sessions`、`get_transcript`、`get_dom_at`、`render_screenshot`、`get_errors` 等工具，Claude Code 等 MCP 客户端可以直接用真实用户会话排查问题 |
| 会话检索 | 先用结构化过滤 + PostgreSQL 全文检索 + Agent 调用工具查询；Claude API 不提供 embeddings，向量检索等确有需要时再评估 |

### 5.3 Claude API 使用要点

- 用官方 SDK `@anthropic-ai/sdk`（0.136）。默认模型 `claude-opus-5-5`：输入每百万 token $4、输出 $20，1M 上下文。模型名做成可配置项。
- 结构化输出用 `client.messages.parse()` + `zodOutputFormat()`，结果经过 Zod 校验。
- 这个模型的思考始终开启，用 `output_config.effort` 控制深度。Opus 5.5 默认是 `medium`，按任务显式设置。
- Prompt caching：固定的系统提示词和 schema 放在前缀，会话转写放在后面。
- 实时请求开启服务端 refusal fallback（`fallbacks: "default"`）。Batch API 不支持这个参数，所以批处理的结果要检查 `stop_reason`，必要时单独重试。

### 5.4 AI 场景下的隐私

- 转写基于录制时已经脱敏过的数据。
- 发送给模型之前再做一轮规则脱敏，覆盖邮箱、手机号、卡号等。
- AI 功能按项目单独开启。
- 明确规定数据保留期限。

## 6. 仓库结构

```
packages/
  protocol/      事件模型 + TCR 编解码（零依赖，录制、回放、服务端共用）
  recorder/      录制核心：主线程入口 + Worker 入口
  plugins/
    canvas/      Canvas / WebGL 视频轨（WebCodecs）
    media/       麦克风旁白、<video> 状态与画面
    console/     控制台与未捕获错误
    network/     fetch / XHR 元数据
    perf/        Web Vitals、长任务
  player-core/   无头回放引擎：时间轴、seek 索引、DOM 物化、沙箱
  player/        <timecat-player>（Lit）
  insight/       语义转写 + AI 分析（在服务端运行）
  mcp/           MCP Server
  cli/           inspect / export / convert
apps/
  playground/    Vite 演示站 + 测试夹具页面
  bench/         性能基准（Playwright + CDP，对标 rrweb）
  server/        接入服务（M4）
  console/       管理控制台（M4）
```

## 7. 质量保障

- **保真测试**：夹具页面执行脚本化的 DOM 变更，录制后回放，在检查点比对 DOM 结构并截图对比，三个引擎同时跑。
- **性质测试**：用 fast-check 随机生成 DOM 变更序列，验证回放出的 DOM 和原 DOM 一致。重点覆盖 3.2 的分片一致性和 3.3 的合并逻辑。
- **性能基准**：用 Playwright + CDP 采集长任务、主线程 CPU、内存和数据量，在同一批夹具上和 rrweb 2.1 对比；CI 里出现回归就失败。
- **体积预算**：用 size-limit 卡住每个包的 gzip 体积。
- **包质量**：用 publint + arethetypeswrong 检查导出和类型，用 knip 检查死代码和多余依赖。

## 8. 性能目标（首版，全部由基准套件验证）

| 指标 | 目标 |
|---|---|
| 录制端主线程核心包 | ≤ 15 KB gzip，Worker 部分按需加载 |
| 录制引起的长任务 | 在 5 万节点的页面上，没有一个超过 50ms |
| 快照体积 | 比 1.x 格式小 2.5 倍以上 |
| 指针轨迹体积 | 比 1.x 格式小 5 倍以上 |
| Seek | 1 小时会话内任意位置 ≤ 300ms |
| 对标 rrweb 2.1 | 主线程 CPU 和数据量都不劣于 rrweb，以公开的基准结果为准 |

## 9. 里程碑

| 阶段 | 内容 |
|---|---|
| M0 地基 | monorepo、工具链、三浏览器 CI、基准框架（含 rrweb 对标）、TCR 格式规范 v0；换掉旧 `.gitignore`（旧规则忽略了 `docs`、`examples`、`test*` 这些常用名字） |
| M1 录制核心 + 最小回放 | 分片快照、按帧合并的增量、输入（含脱敏）/ 指针 / 滚动 / 视口 / 导航；Worker 管线（编码、压缩、OPFS、导出）；player-core 的播放和 seek；保真测试套件 |
| M2 平台覆盖与回放体验 | Shadow DOM、Constructable Stylesheets / CSSOM、iframe、字体和 `blob:` 资源；`<timecat-player>` UI；导出为单个 HTML 文件；console、network、perf 插件 |
| M3 媒体与实时 | Canvas / 视频轨（WebCodecs）、麦克风旁白、实时模式 |
| M4 服务端与 AI | 接入服务、存储、控制台；语义转写、摘要、批量分析；MCP Server；生成 Playwright 用例 |

## 10. 待决策事项

1. **许可证**：新代码继续用 GPL-3.0，还是改用 MIT / Apache-2.0？这次是重写，不搬运旧代码，两条路都走得通。如果打算商用或嵌入闭源产品，宽松许可证更合适。
2. **首期范围**：建议 M0–M2 先做纯前端 SDK，和原版定位一致；服务端和 AI 在协议层预留接口，到 M4 再落地。
3. **npm 包名**：`timecatjs` 和 `@timecat/*` 都归原作者所有，需要换一个新的 scope 或名字。
4. **旧录像兼容**：是否需要回放 TimeCat 1.x 录下的数据？需要的话做一个独立的转换器。
5. **仓库组织**：建议直接在本分支替换成新的 monorepo，旧代码留在 git 历史里（可以打 tag 标记），两套代码不并存。

## 附录 A：编码方案基准（2026-10-20）

**目的**：用数据决定录制数据的编码方式，而不是凭经验。

**环境**：Chromium 141.0.7390.37 headless；Intel Xeon 2.8 GHz × 4 vCPU（云容器）；msgpackr 2.1.2。

**数据**：一个合成的电商列表页，包含导航栏和商品卡片，卡片里有 SVG 图标、长 class 列表和 data 属性。400 张卡片约 1.28 万个节点，1600 张约 5.1 万个。指针轨迹是 2 万次约 60Hz 的平滑随机移动。

**方法**：每一项先预热，再测 9 次取中位数。"主线程总耗时"包含 DOM 遍历。TCR 原型的往返校验（编码后再解码，和元组树逐项比对）全部通过。

**快照，1.28 万节点**

| 方案 | 编码 | 原始 | gzip 后 | 解压 + 解码 |
|---|---|---|---|---|
| JSON（1.x 风格对象树） | 19.6 ms | 1994 KB | 89.5 KB | 21.3 ms |
| JSON（紧凑元组） | 16.0 ms | 1499 KB | 76.8 KB | 20.0 ms |
| msgpackr（对象） | 12.4 ms | 1747 KB | 80.8 KB | 18.9 ms |
| msgpackr + records（对象） | 10.6 ms | 1242 KB | 75.9 KB | 11.4 ms |
| msgpackr（元组） | 6.6 ms | 1346 KB | 75.5 KB | 10.4 ms |
| **单遍二进制（含遍历）** | 22.4 ms | 945 KB | **35.5 KB** | **8.9 ms** |

单纯 DOM 遍历约 16 ms；前五行的"编码"列都不含遍历时间。

**快照，5.1 万节点**

| 方案 | 编码 | gzip 后 | 解压 + 解码 |
|---|---|---|---|
| JSON（1.x 风格对象树） | 98.2 ms | 302.0 KB | 75.9 ms |
| msgpackr（元组） | 34.5 ms | 246.2 KB | 53.1 ms |
| **单遍二进制（含遍历）** | 74.1 ms | **86.0 KB** | **33.8 ms** |

单纯 DOM 遍历约 55 ms，这就是 3.2 必须分片的原因。

**2 万次指针移动**

| 方案 | 原始 | gzip 后 |
|---|---|---|
| JSON（1.x 风格对象） | 1822 KB | 156.0 KB |
| JSON（元组） | 331 KB | 120.6 KB |
| **列式差分 + varint** | 59 KB | **24.7 KB** |

**局限**：页面是合成的，只在一台机器上跑，headless 模式，只测了 Chromium；原型也没有包含脱敏、Shadow DOM 等真实逻辑。这些结论用来确定方向。M0 的基准套件会在真实页面夹具和三个引擎上，与 rrweb 一起重新验证。

**复现**：见 [`0001/encoding-bench/`](./0001/encoding-bench/)。
