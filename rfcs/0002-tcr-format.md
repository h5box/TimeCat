# RFC 0002：TCR 录制格式 v0

| 状态 | 草案。第 2–7 节均已实现 |
|---|---|
| 日期 | 2026-10-20，2026-10-21 定稿第 6 节、补充第 4.3 节；M2 补充 Shadow DOM、frame、样式表、字体、资源和插件事件（第 6.4、6.13–6.20 节）；M3 补充多段字节流、实时流和媒体（第 4、4.4、6.21–6.22、7 节） |
| 实现 | `@timecat-js/protocol`（`FORMAT_VERSION = 0`）；第 4.3、4.4 节的时间线由 `@timecat-js/player-core` 实现 |
| 背景 | [RFC 0001](./0001-timecat-next.md) 第 3.4 节 |

TCR（TimeCat Recording）是 TimeCat 的录制数据格式。设计目标：

- 体积小。
- 能流式写入和读取。
- chunk 能独立解码，从而支持随机 seek。
- 解析不可信输入是安全的。
- 能在不破坏旧数据的前提下演进。

1.0 之前（格式版本 0），格式可能做不兼容的调整。

## 1. 约定

- "错误"指读取方必须中止解析，实现中抛出 `TcrDecodeError`。
- 多字节数值只有 `f64` 一种，采用小端序。
- 时间单位是毫秒，只有媒体包（第 7 节）用微秒。

## 2. 基本类型

| 类型 | 编码 |
|---|---|
| `u8` | 1 个字节 |
| `varuint` | 无符号 LEB128，取值范围 [0, 2^53 − 1]，最多 8 个字节。超过 8 个字节或超出安全整数范围都是错误。不强制最短编码。 |
| `varint` | 先做 zigzag 变换（n ≥ 0 映射为 2n，n < 0 映射为 −2n − 1），再按 `varuint` 编码。取值范围 [−2^52, 2^52 − 1] |
| `f64` | IEEE 754 双精度，小端序，8 个字节 |
| `bytes` | `varuint` 长度，后跟原始字节 |
| `string` | `varuint` **字节**长度，后跟 UTF-8 |

关于 `string` 的细节：

- 写入时，孤立的 UTF-16 代理项会编码成 U+FFFD。这是有损的，但 UTF-16 长度保持不变。
- 读取时，非法的 UTF-8 序列解码为 U+FFFD。
- 开头的 U+FEFF（BOM）属于正文内容，必须原样保留。

## 3. 字符串表

需要去重的字符串通过字符串表写入，每个字符串前面带一个 `varuint` 标签：

| 标签 | 含义 |
|---|---|
| 0 | 字面量，后跟 `string`，不加入表 |
| 1 | 字面量，后跟 `string`，并按出现顺序加入表（索引从 0 开始） |
| n ≥ 2 | 引用表中第 n − 2 项，引用不存在的项是错误 |

哪些字符串加入表由写入方决定；读取方只按标签执行，所以去重策略可以调整而不影响兼容性。表的作用域由使用方定义：事件负载以**单个事件体**为作用域，每个事件体开始时表为空。这样每个事件都能单独解码，录制端也能在事件写完后立刻把它交出去，不必等整个 chunk。

当前实现的去重策略（仅供参考，不属于格式）：标签名、命名空间、属性名一律加入；属性值不超过 64 个字符时加入；文本和注释不超过 32 个字符时加入；URL 和表单值不加入。

## 4. 段（segment）

一次会话由一个或多个段组成，每次页面加载产生一个段。一条字节流（一个文件，或一次流式传输）包含一个段，或者一个接一个的多个段：

```
Stream  := Segment+
Segment := Header Chunk*
```

读取方在 chunk 的边界上读到字节 `54`（magic 的第一个字节）时，按 Header 读下一段。所以 chunk kind `0x54` 保留不用，读到是错误。

### 4.1 Header

| 字段 | 类型 | 说明 |
|---|---|---|
| magic | 4 字节 | `54 43 52 00`，即 "TCR\0"；不匹配是错误 |
| version | `varuint` | 格式版本，当前为 0。高于读取方支持的版本是错误 |
| flags | `varuint` | 保留，必须为 0；非 0 是错误 |
| sessionId | `string` | 会话 ID，同一会话的各段相同 |
| segment | `varuint` | 段序号，从 0 开始 |
| startedAt | `f64` | 段开始时的墙钟时间（epoch 毫秒），chunk 的时间都相对于它 |
| meta | `string` | UTF-8 编码的 JSON **对象**，存放 SDK 版本、视口等信息；不是对象是错误 |

### 4.2 Chunk

| 字段 | 类型 | 说明 |
|---|---|---|
| kind | `u8` | 1 = 事件（第 6 节），2 = 媒体（第 7 节），3 = 同步（第 4.4 节）。`0x54` 保留（见上文）。读取方**跳过**其他不认识的 kind（负载有长度前缀，可以直接跳过） |
| flags | `u8` | bit 0 = 关键帧（不依赖同轨道更早的 chunk 即可解码）；bit 1 = 负载经 gzip 压缩；其余位保留，非 0 是错误 |
| track | `varuint` | 轨道 ID（第 5 节） |
| sequence | `varuint` | 段内序号，从 0 开始依次递增，用于排序和发现缺失 |
| startTime | `varuint` | 相对 `startedAt` 的毫秒数 |
| duration | `varuint` | chunk 覆盖的时长，单位毫秒 |
| payload | `bytes` | 负载 |

写入方建议遵守：

- 每个 chunk 压缩后不超过 64 KiB，因为页面卸载时 `fetch(keepalive)` 的发送上限就是 64 KiB。
- 压缩一律用 gzip，因为浏览器原生的 CompressionStream 只有 gzip 系在三大引擎都可用。

### 4.3 时间线

读取方把一次会话的各段拼成一条时间线，按以下规则排列事件：

- **段的顺序**：按 `segment` 排序，相同时按 `startedAt`。各段的 `sessionId` 必须相同，不同是错误。
- **段的偏移**：第一个段的 `startedAt` 是时间线的零点。之后每个段的事件整体后移，偏移量取"该段 `startedAt` 减去零点"和"之前各段的结束时间"中较大的一个。段的结束时间是其中所有 chunk 的 `startTime + duration` 的最大值（加上该段的偏移）。这样即使各段的墙钟不一致，段也不会重叠，并且按序号依次播放。
- **段内的顺序**：chunk 按 `sequence` 读取。各轨道的事件按时间合并；时间相同的事件按轨道 ID 从小到大排列；同一轨道的事件保持在字节流中的顺序（先按 chunk 的 `sequence`，再按 chunk 内的位置）。

写入方依赖最后一条：同一时刻写出的事件中，`Dom`（1）先于 `Input`（2）、`Scroll`（4）等轨道应用。所以一帧里新插入的表单控件或可滚动元素，可以在同一时刻紧接着带上它的状态或滚动位置。

`Dom` 轨道的某个 chunk 无法解码时（例如负载不是合法的 gzip 数据），它之后的变更引用的节点 ID 都无法确定。建议读取方给出警告，并在下一个快照之前不再应用 Mutations 事件；其他轨道的事件照常应用。

### 4.4 实时流

写入方按轨道攒 chunk，一个 chunk 结束时才写出，所以字节流里各轨道的 chunk 是交错的：一个轨道的 chunk 可能晚于另一个轨道上时间更晚的 chunk 写出。读完整个文件再排序的读取方不受影响；边收边播的读取方需要知道哪段时间已经完整，这由同步 chunk 说明。

同步 chunk（kind 3）：`track` 为 0，`flags` 为 0，负载为空，`duration` 为 0，`sequence` 照常递增。它的 `startTime` 为 T，表示**页面轨道**（ID 小于 16 的固定轨道，即 `Dom` 到 `Media`，以及以后在这个范围内新增的轨道）上时间早于 T 的事件，都在这个 chunk 之前的 chunk 里。

- 同一段内，同步 chunk 的 `startTime` 不减小。
- 读取方可以播放时间早于最近一个 T 的页面事件；读到下一个段的 Header 或字节流结束时，这一段的事件全部可以播放。
- 其他轨道不受同步 chunk 约束：数据轨道（16–31）的事件可能晚到，读取方按时间插入；`Assets` 轨道的内容与时间无关，到达后即可使用；媒体轨道的包按第 7 节缓冲。
- 只写文件的写入方不必写同步 chunk，读取方也可以忽略它。

写入方每隔一段时间（即实时延迟，默认 5 秒）结束各轨道的 chunk 并写出同步 chunk。

## 5. 轨道

| ID | 轨道 | ID | 轨道 |
|---|---|---|---|
| 1 | `Dom`：快照与 DOM 变更 | 16 | `Console`：控制台与未捕获错误 |
| 2 | `Input`：表单输入（已脱敏） | 17 | `Network`：网络请求元数据 |
| 3 | `Pointer`：指针与触摸 | 18 | `Perf`：性能指标 |
| 4 | `Scroll`：滚动 | 19 | `Custom`：业务自定义事件 |
| 5 | `Viewport`：视口与缩放 | 32 | `Assets`：抓取的资源（如 `blob:` URL） |
| 6 | `Navigation`：页面内导航 | ≥ 256 | 动态轨道，录制时为每路媒体流分配，由 MediaTrack 事件声明（第 7 节） |
| 7 | `Media`：媒体轨道的声明，音视频元素的播放状态 | | |

1–255 中其余的 ID 保留，供以后的固定轨道使用。

## 6. 事件负载

### 6.1 事件 chunk

事件 chunk（kind 1）的负载是一串事件，每个事件为：

| 字段 | 类型 | 说明 |
|---|---|---|
| type | `varuint` | 事件类型（6.2） |
| dt | `varuint` | 距上一个事件的毫秒数；第一个事件相对 chunk 的 `startTime` |
| body | `bytes` | 事件体 |

- 事件时间 = chunk 的 `startTime` 加上累计的 `dt`，超出安全整数范围是错误。chunk 内的事件按时间排列。
- 每个事件体有自己的字符串表（第 3 节）。
- 读取方**跳过**不认识的事件类型。
- 读取方忽略事件体末尾多出的字节，所以以后可以在已有事件的末尾追加字段。
- 一个事件不会跨 chunk。只含一个大事件（如大快照、大资源）的 chunk 可以超过第 4.2 节建议的大小。

### 6.2 事件类型

事件类型 ID 全局唯一，不依赖轨道：

| ID | 事件 | 轨道 | 内容 |
|---|---|---|---|
| 1 | Snapshot | `Dom` | 整个文档 |
| 2 | Mutations | `Dom` | 一帧内合并的 DOM 变更 |
| 3 | Input | `Input` | 表单控件的值、勾选状态、选中项 |
| 4 | PointerMoves | `Pointer` | 一段指针移动，按列存储 |
| 5 | PointerButton | `Pointer` | 指针按下或抬起 |
| 6 | Scroll | `Scroll` | 视口或元素的滚动位置 |
| 7 | Viewport | `Viewport` | 视口尺寸 |
| 8 | Navigation | `Navigation` | 同文档内的 URL 变化（History API、hash） |
| 9 | StyleSheet | `Dom` | 通过 CSSOM 改变的样式规则 |
| 10 | AdoptedStyleSheets | `Dom` | 文档或 shadow root 采用的样式表 |
| 11 | FontFace | `Assets` | 脚本添加的字体 |
| 12 | Asset | `Assets` | 回放时无法再从原 URL 加载的资源，如 `blob:` URL 的内容 |
| 13 | Console | `Console` | 控制台消息、未捕获的错误和未处理的 Promise 拒绝 |
| 14 | Network | `Network` | 结束的网络请求 |
| 15 | Perf | `Perf` | 性能指标 |
| 16 | Custom | `Custom` | 业务自定义事件 |
| 17 | MediaTrack | `Media` | 声明一个媒体轨道，或改变它的格式 |
| 18 | MediaState | `Media` | `<audio>` / `<video>` 的播放状态 |

### 6.3 节点 ID

- 节点 ID 是正整数，0 表示"没有"（如 6.6 的 `beforeId`、6.9 的 `targetId`）。
- 快照默认**不写 ID**：文档节点为 1，其余节点按先序遍历依次为 2、3、4……。shadow root 和 frame 的文档也是节点，按它们在节点树中的位置编号（6.4）。快照之后的下一个可用 ID 为节点数加 1。
- 每个快照都重置 ID 空间：它之前的 ID 全部作废。
- 增量变更新增的节点按它们在事件体里出现的顺序，从当前的下一个可用 ID 继续分配。所以解码 `Dom` 轨道需要从最近的快照开始顺序读取：以快照开头的 `Dom` chunk 是关键帧，其余 `Dom` chunk 不是。其他轨道的事件解码不依赖之前的数据，它们的 chunk 都标为关键帧。
- 快照也可以显式写出每个节点的 ID（6.5 的 flags bit 0）。录制端不使用这种形式；回放端或剪辑工具从录像的中间状态生成快照时用它保留原有 ID。

### 6.4 节点树

快照和增量变更里的 DOM 树都编码为先序的节点序列。每个节点以一个 `u8` 节点头开始：

| 位 | 含义 |
|---|---|
| 0–2 | 节点类型：0 End，1 Element，2 Text，3 Comment，4 Document，5 Doctype，6 ShadowRoot。7 是错误 |
| 3 | 有子节点：节点之后依次是各子节点，最后以 End 结束。只用于 Element、Document 和 ShadowRoot |
| 4 | Element：有命名空间，标签名之后写命名空间。Document：文档处于怪异模式。ShadowRoot：closed 模式 |
| 5–7 | 属性个数 0–6；为 7 时，个数另写为 `varuint`。只用于 Element |

节点头之后的字段（`[id]` 只在显式 ID 的快照里出现；所有字符串都经过字符串表）：

| 类型 | 字段 |
|---|---|
| End | 无 |
| Element | `[id]`、标签名、`[命名空间]`、`[属性个数]`、每个属性的名和值、子节点…、End |
| Text | `[id]`、文本 |
| Comment | `[id]`、文本 |
| Document | `[id]`、文档 URL（相对 URL 以它为基准解析）、子节点…、End |
| Doctype | `[id]`、name、publicId、systemId |
| ShadowRoot | `[id]`、子节点…、End |

- 标签名是 local name：HTML 元素为小写，SVG 和 MathML 元素保留大小写。属性名是带前缀的完整名字（如 `xlink:href`）。
- 不带命名空间的元素继承父节点的命名空间。最顶层的节点（增量变更中每段新增节点的根），以及 Document 和 ShadowRoot 的子节点，以 HTML 为基准。空字符串表示没有命名空间。
- Document 是快照的根节点，也表示 frame 的内容：作为 `<iframe>` 或 `<frame>` 的第一个子节点。ShadowRoot 表示元素的 shadow tree，作为宿主元素的第一个子节点。两者之后才是元素自己的子节点。
- 在根节点以下，Document 和 ShadowRoot 只能是 Element 的第一个子节点，否则是错误。Doctype 只能是 Document 的子节点。
- 以下都是错误：在 Text、Comment、Doctype 上设置任何标志位；在 Document 和 ShadowRoot 上设置第 3、4 位以外的标志位；带标志位的 End；没有可结束节点的 End；属性个数乘以 2 超过剩余字节数。
- 嵌套深度没有上限，实现必须用迭代而不是递归来读写节点树。
- 回放端用 open 模式重建 closed shadow root，因为回放页面不运行脚本，模式只用来展示。

### 6.5 Snapshot（1）

| 字段 | 类型 | 说明 |
|---|---|---|
| flags | `varuint` | bit 0 = 显式 ID。其余位非 0 是错误 |
| nextId | `varuint` | 下一个可用 ID，只在显式 ID 时出现 |
| root | 节点树 | 根节点必须是 Document |

- 快照替换整个文档，回放端丢弃之前的全部状态，包括构造样式表的编号（6.13）。
- 快照只包含 DOM 结构。表单的当前状态、滚动位置、通过 CSSOM 改过的样式表和 adopted 样式表，由紧随其后、时间相同的 Input、Scroll、StyleSheet 和 AdoptedStyleSheets 事件给出，所以回放端从最近的快照开始，按顺序应用之后的全部事件，就能还原任意时刻的状态。
- 录制端以时间切片的方式遍历 DOM，快照的时间是遍历**结束**的时刻；遍历期间发生的变化由同一时刻、紧随快照的 Mutations 事件补上。

### 6.6 Mutations（2）

| 字段 | 类型 | 说明 |
|---|---|---|
| 移除 | `varuint` 个数，每项一个 `varuint` 节点 ID | 把节点连同子树从父节点上摘下 |
| 新增 | `varuint` 段数，每段为：`varuint` parentId、`varuint` beforeId、`varuint` 节点数、各节点的节点树 | 把这一段节点按顺序插到 parentId 的子节点中、beforeId 之前；beforeId 为 0 表示追加到末尾 |
| 属性变化 | `varuint` 个数，每项为：`varuint` 节点 ID、属性名、`u8` 是否存在（0 或 1，其他值是错误）、存在时的属性值 | 设置或删除属性 |
| 文本变化 | `varuint` 个数，每项为：`varuint` 节点 ID、文本 | 替换 Text 或 Comment 节点的内容 |

- 按字段顺序应用：先移除，再按顺序插入各段，再改属性，最后改文本。
- 新增的节点按出现顺序分配 ID（6.3）。
- 被移除的节点及其子树的 ID 不会再被引用。同一个节点再次插入时，会以新 ID 和完整的子树重新出现。
- 给已有的元素附加 shadow root、往已有的 frame 里载入新文档，都写成单独的一段：Document 或 ShadowRoot 是这一段唯一的节点，beforeId 为 0，否则是错误。
- 新的 Document 替换 frame 里原有的文档；移除 frame 的文档后，frame 显示空白。shadow root 不能移除，移除它的项被忽略；宿主已有 shadow root，或者不能附加 shadow root 时（与 `attachShadow` 的规则相同），新的 ShadowRoot 连同子树被忽略。
- 回放端忽略引用未知 ID 的项，这样即使录制端漏掉了一些变化，后续回放也不会中断。

### 6.7 Input（3）

`varuint` 个数，每项为 `varuint` 节点 ID、`u8` 类型，以及：

| 类型 | 内容 |
|---|---|
| 0 值 | 字符串：`<input>` / `<textarea>` 的当前值，已按录制配置脱敏 |
| 1 勾选 | `u8`：0 未选中，1 选中，其他值是错误 |
| 2 选中项 | `varuint` 个数，每项为一个 `varuint` 选项序号：`<select>` 当前选中的选项 |

未知的类型是错误（项没有长度前缀，无法跳过）。新增类型需要新的事件类型。

### 6.8 PointerMoves（4）

| 字段 | 类型 | 说明 |
|---|---|---|
| pointer | `u8` | 0 鼠标，1 笔，2 触摸。其他值是错误 |
| count | `varuint` | 样本数，至少为 1 |
| 时间列 | (count − 1) × `varint` | 第一个样本在事件时间上，不写；之后每项是二阶差分，见下文。相邻样本的间隔（毫秒）不能为负，否则是错误 |
| x 列 | `varint`，然后 (count − 1) × `varint` | 第一个 x，之后每项是二阶差分 |
| y 列 | `varint`，然后 (count − 1) × `varint` | 同上 |

二阶差分是每一步减去上一步：设某列的值为 v₀、v₁、…，第 i 步是 vᵢ − vᵢ₋₁，写出的是第 i 步减第 i − 1 步，第 1 步之前的一步按 0 算。匀速移动时二阶差分都是 0，平滑的移动也接近 0，比直接写每一步更好压缩：RFC 0001 附录 A 的 2 万次移动，按 5 秒一个 chunk 压缩后小 14%。

坐标是相对视口的整数 CSS 像素（`clientX` / `clientY` 取整）。v0 只记录主指针。

### 6.9 PointerButton（5）

| 字段 | 类型 | 说明 |
|---|---|---|
| action | `u8` | 0 按下，1 抬起。其他值是错误 |
| pointer | `u8` | 同 6.8 |
| button | `u8` | `PointerEvent.button`：0 主键，1 中键，2 右键…… |
| x、y | `varint` | 同 6.8 |
| targetId | `varuint` | 指针下的节点，0 表示未知 |

### 6.10 Scroll（6）

`varuint` 个数，每项为 `varuint` 节点 ID、`varint` x、`varint` y，即该节点的 `scrollLeft` / `scrollTop`（取整的 CSS 像素）。节点 ID 是文档节点时表示这个文档的视口滚动：页面的，或者 frame 的。

### 6.11 Viewport（7）

`varuint` 宽、`varuint` 高：`innerWidth` / `innerHeight`，CSS 像素。

### 6.12 Navigation（8）

`varuint` 文档节点 ID（页面的，或者 frame 的），然后是字符串：新的文档 URL。这个文档里之后的相对 URL 以它为基准解析。

### 6.13 StyleSheet（9）

通过 CSSOM（`insertRule`、`deleteRule`、`replace`、`replaceSync` 等）而不是标记改变的样式规则。

| 字段 | 类型 | 说明 |
|---|---|---|
| owner | `u8` | 0：`<style>` 元素的样式表，ID 是元素的节点 ID；1：构造样式表（`new CSSStyleSheet()`），ID 是样式表编号。其他值是错误 |
| id | `varuint` | 见 owner |
| 变化 | `varuint` 个数，每项为 `u8` 类型及其内容 | 按顺序应用 |

| 类型 | 内容 |
|---|---|
| 0 替换 | `varuint` 规则数，每条规则一个字符串：替换全部规则 |
| 1 插入 | `varuint` 位置、规则字符串 |
| 2 删除 | `varuint` 位置 |

- 规则是顶层规则的 `cssText`。改变嵌套规则（例如 `@media` 里的规则）写成删除再插入它所在的顶层规则。未知的类型是错误。
- 构造样式表按快照编号，从 1 开始；某个编号的第一个事件创建这个样式表。
- 录制端第一次记录某个样式表时写替换，之后才写插入和删除。回放端某条规则解析失败时（例如别的引擎不认识的选择器），在同一位置放一条不生效的规则，让后续的位置仍然对得上。
- `<style>` 元素的文本改变时，浏览器重新解析整个样式表，之前通过 CSSOM 的改变随之失效。

### 6.14 AdoptedStyleSheets（10）

`varuint` 文档或 shadow root 的节点 ID，`varuint` 个数，每项一个 `varuint` 构造样式表编号：替换它采用的样式表（`adoptedStyleSheets`），按顺序排列。回放端忽略不存在的编号。

### 6.15 FontFace（11）

| 字段 | 类型 | 说明 |
|---|---|---|
| family | 字符串 | 字体族名 |
| 来源 | `u8` 类型，然后是内容 | 0：字符串，CSS `src` 的值，URL 已转成绝对 URL；1：`bytes`，字体文件。其他值是错误 |
| 描述符 | `varuint` 个数，每项为名和值两个字符串 | `FontFace` 的描述符，如 `weight`、`unicodeRange` |

回放端把整个录像里的字体加到回放的每个文档中，与时间无关。

### 6.16 Asset（12）

字符串 URL、字符串 MIME 类型、`bytes` 内容。录制端把回放时无法再加载的资源（`blob:` URL 只在页面存活期间有效）抓取下来；回放端把引用这个 URL 的地方换成自己生成的 URL。同样与时间无关。

### 6.17 Console（13）

| 字段 | 类型 | 说明 |
|---|---|---|
| level | `u8` | 0 debug，1 log，2 info，3 warn，4 error。其他值是错误 |
| source | `u8` | 0 调用 `console` 的方法，1 未捕获的错误，2 未处理的 Promise 拒绝。其他值是错误 |
| args | `varuint` 个数，每项一个字符串 | 各参数转成的文本 |
| stack | 字符串 | 调用栈，没有时为空 |

### 6.18 Network（14）

字符串 initiator（`fetch`、`xmlhttprequest`、`beacon`，或者 Resource Timing 的 `initiatorType`）、字符串方法、字符串 URL、`varuint` HTTP 状态码（页面读不到响应时为 0）、`varuint` 耗时（毫秒）、`varuint` 接收的字节数（未知时为 0）、字符串错误信息（成功时为空）。事件在请求结束时写出，事件时间是结束时刻，开始时刻是它减去耗时。

### 6.19 Perf（15）

字符串指标名（如 `LCP`、`CLS`、`INP`）、`f64` 值、`varuint` 相关的节点 ID（没有时为 0）。

### 6.20 Custom（16）

字符串事件名、字符串数据（JSON 文本）。

### 6.21 MediaTrack（17）

声明媒体轨道，或者从事件时间起改变它的格式（例如 canvas 改变了尺寸）。见第 7 节。

| 字段 | 类型 | 说明 |
|---|---|---|
| track | `varuint` | 动态轨道 ID，小于 256 是错误 |
| kind | `u8` | 1 视频，2 音频。其他值是错误 |
| targetId | `varuint` | 显示这个轨道的节点，如 `<canvas>`；0 表示没有，如旁白 |
| codec | 字符串 | WebCodecs 的 codec 字符串，如 `vp09.00.10.08`、`opus`；容器流为空 |
| description | `bytes` | WebCodecs 解码器配置的 `description`，如 H.264 的 `avcC`；不需要时为空 |
| container | 字符串 | 容器流的 MIME 类型，如 `audio/webm;codecs=opus`；编码帧为空 |
| width、height | `varuint` | 视频的编码尺寸（像素）；音频为 0 |
| sampleRate、channels | `varuint` | 音频的采样率和声道数；视频为 0，容器流自带时也可以为 0 |

codec 和 container 必须恰好有一个非空，否则是错误。

### 6.22 MediaState（18）

`<audio>` / `<video>` 元素的播放状态。录制端在元素开始播放、暂停、跳转、改变速率或音量时写出，录制开始时也为已有的元素各写一个。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | `varuint` | 元素的节点 ID |
| flags | `u8` | bit 0 = 暂停，bit 1 = 静音；其余位非 0 是错误 |
| currentTime | `f64` | 播放位置，单位秒 |
| playbackRate | `f64` | 播放速率 |
| volume | `f64` | 音量，0 到 1 |

元素在播放时，回放时刻 t 的位置是 `currentTime + (t − 事件时间) / 1000 × playbackRate`。

## 7. 媒体

媒体轨道是动态轨道（ID ≥ 256），录制 canvas、视频画面、麦克风旁白这类连续的音视频。每个媒体轨道先由 `Media` 轨道上的 MediaTrack 事件（6.21）声明，事件时间不晚于它的第一个包；它的包放在这个轨道的媒体 chunk（kind 2）里。轨道有两种形式：

- **编码帧**（codec 非空）：每个包是 WebCodecs 编码出的一个 `EncodedVideoChunk` / `EncodedAudioChunk`。包的时间是它的显示时间，关键包是关键帧。读取方用 MediaTrack 的 codec、description、尺寸或采样率配置解码器，从时刻 t 之前最近的关键包开始解码。
- **容器流**（container 非空）：包是同一条字节流依次切下的片段，字节流是 container 格式的媒体文件（如 MediaRecorder 写出的 WebM）。从声明起把包按顺序拼起来，就是可以播放的文件；文件的 0 秒对应 MediaTrack 事件的时间。声明后的第一个包是关键包，其余不是。包的时间是它写出的时刻，只用于分 chunk 和实时流。

同一轨道再次出现 MediaTrack 事件时，之后的包按新格式解码，并且下一个包是关键包。

### 7.1 媒体 chunk

媒体 chunk 的负载是一串包，每个包为：

| 字段 | 类型 | 说明 |
|---|---|---|
| flags | `u8` | bit 0 = 关键包，可以从这里开始解码；其余位非 0 是错误 |
| dt | `varint` | 距上一个包的微秒数；第一个包相对 chunk 的 `startTime × 1000`。可以为负：有 B 帧的视频按解码顺序存放，显示时间会往回走 |
| duration | `varuint` | 包的时长，单位微秒；未知时为 0 |
| data | `bytes` | 包的内容 |

- 包的时间 = `startTime × 1000` 加上累计的 `dt`，为负或超出安全整数范围是错误。
- chunk 的 `startTime` 是第一个包的时间（向下取整到毫秒），`duration` 一直覆盖到结束得最晚的包。第一个包是关键包时，chunk 带关键帧标记。
- 写入方在每个关键包处开始新 chunk，读取方从关键帧 chunk 读起就能解码；chunk 也可以在两个关键包之间因为大小或实时延迟而结束。
- 编码过的音视频几乎压缩不了，写入方不压缩媒体 chunk。

## 8. 演进规则

- **向后兼容的扩展**：新增 chunk kind、轨道、事件类型、`meta` 字段。旧读取方会跳过这些新内容，不需要提升 `version`。
- **不兼容的改变**：修改已有字段的布局或语义、启用新的 flag 位，都必须提升 `version`。
- 1.0 之前 `version` 保持为 0，格式可能直接调整；1.0 起按以上规则执行。

## 9. 安全

录像在回放端是**不可信输入**：

- 所有长度和引用都做边界检查，越界一律报错。
- 每个计数在分配之前先和剩余字节数比较，伪造的超大计数直接报错。
- 节点树用迭代解码，嵌套再深也不会耗尽调用栈。
- 读取方返回的负载是原数据的视图，不复制，所以伪造的超大长度不会导致大块内存分配。
- 未知的 flag 位直接拒绝；未知的 kind 跳过。
- `meta` 只接受 JSON 对象。
