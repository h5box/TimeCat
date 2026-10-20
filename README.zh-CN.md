<h1 align="center">TimeCat</h1>

<p align="center">高性能、隐私优先的网页会话录制与回放</p>

<p align="center"><a href="./README.md">English</a> | 中文</p>

> **正在重写。** TimeCat 正在从零重建，目前还不能使用：地基（M0）已经完成，下一步是录制器。架构和路线图见
> [RFC 0001](./rfcs/0001-timecat-next.md)。

TimeCat 录制网页里发生的一切，包括 DOM 变化、输入、滚动和指针移动，并能像视频一样回放出来，但录下的并不是真正的视频画面。

## 设计目标

- **对页面无感。** 主线程只负责读取 DOM；编码、压缩、存储、上传都在 Worker 中完成。快照分片执行，录制不会产生长任务。
- **数据小。** 使用专门设计的二进制格式 [TCR](./rfcs/0002-tcr-format.md)：字符串表、隐式节点 ID、高频流按列存储。实测快照 gzip 后比 1.x 的 JSON 格式小 2.5–3.5 倍。
- **隐私默认安全。** 输入值在离开页面之前就已脱敏，密码永远脱敏。
- **回放安全。** 录到的脚本永远不会执行：回放沙箱不开 `allow-scripts`。
- **媒体用原生编解码。** Canvas、视频、音频交给浏览器自带的编解码器（WebCodecs、MediaRecorder）。

## 包

| 包 | 状态 |
|---|---|
| [`@timecat-js/protocol`](./packages/protocol) | v0 草案：二进制基本类型、字符串表、chunk 容器 |
| `@timecat-js/recorder` | 计划中（M1） |
| `@timecat-js/player-core`、`@timecat-js/player` | 计划中（M1–M2） |

[`apps/bench`](./apps/bench) 用夹具页面测量录制器的性能，并记录了 TimeCat 的对标对象 rrweb 的基线数据。

## 开发

需要 Node.js 24，pnpm 通过 Corepack 启用。

```bash
corepack enable
pnpm install
pnpm check          # 格式、lint、类型、未使用代码、单元测试、构建、体积预算
pnpm test:browser   # 在 Chromium、Firefox、WebKit 中运行测试（Playwright）
pnpm bench          # 录制器性能基准
```

开发约定见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 历史

TimeCat 由 [oct16](https://github.com/oct16/TimeCat) 于 2020 年创建。这次重写是独立的实现，与 1.x 没有共享代码，也不能读取 1.x 的录像。1.x 的最后一版源码保留在 `legacy-1.x` tag。

## 许可证

[GPL-3.0-or-later](./LICENSE)
