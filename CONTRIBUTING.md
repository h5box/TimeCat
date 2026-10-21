# 参与开发

## 环境

- Node.js 24（见 `.node-version`）
- pnpm：版本锁定在 `package.json` 的 `packageManager` 字段，运行一次 `corepack enable` 后自动使用该版本

```bash
corepack enable
pnpm install
```

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm check` | 提交前完整检查：格式、lint、类型、未使用代码、单元测试、构建、体积预算。CI 跑的就是这一套，浏览器测试另外按引擎分别运行 |
| `pnpm test` | Node 环境下的单元测试 |
| `pnpm test:browser` | 在真实浏览器中运行测试（Chromium、Firefox、WebKit） |
| `pnpm format` | 用 oxfmt 格式化 |
| `pnpm build` | 用 tsdown 构建所有包，构建时同时运行 publint 和 arethetypeswrong |
| `pnpm size` | 检查各包的体积预算（`.size-limit.json`） |
| `pnpm bench` | 录制器性能基准，见 [`apps/bench`](./apps/bench) |
| `pnpm bench:seek` | 回放 seek 基准：录一段 1 小时的会话，测随机 seek 的耗时 |

浏览器测试需要 Playwright 的浏览器，用 `pnpm exec playwright install` 安装。本地可以用两个环境变量调整：

- `VITEST_BROWSERS=chromium`：只跑部分引擎。
- `CHROMIUM_EXECUTABLE_PATH`：指向已经安装好的 Chromium。

## 测试文件命名

| 文件名 | 运行环境 |
|---|---|
| `*.test.ts` | Node **和**所有浏览器。与运行环境无关的逻辑（如编解码）默认写在这里，保证各环境行为一致 |
| `*.node.test.ts` | 只在 Node 中运行 |
| `*.browser.test.ts` | 只在浏览器中运行（需要真实 DOM、布局等） |

编解码这类逻辑除了示例测试，还要用 fast-check 写基于性质的测试（往返一致、拒绝非法输入）。

录制器的保真测试在 [`packages/recorder/test/fidelity`](./packages/recorder/test/fidelity)：在 iframe 里录制页面，用 player-core 回放，在每个检查点比对两边的 DOM、表单状态和滚动位置。其中的性质测试用 fast-check 生成随机的变更序列，包括快照分片之间发生的变更。改动录制或回放逻辑时，先在这里补一个能复现问题的用例。

## 代码约定

- TypeScript 7，开启 `strict`、`isolatedDeclarations`、`erasableSyntaxOnly`：
  - 不用 `enum` 和 `namespace`，常量集合用 `as const` 对象；
  - 导出的函数和类成员要写明返回类型。
- 相对导入写 `.ts` 扩展名。工作区内的包之间通过 `@timecat-js/source` 导出条件直接引用源码，开发时不需要先构建。
- 包只输出 ESM，`exports` 由 tsdown 生成，发布时自动切换到 `dist`。
- lint 用 oxlint，开启类型感知规则；格式化用 oxfmt。typescript-eslint 不支持 TS 7，所以不用 ESLint。
- 录制端代码不能依赖第三方运行时库（RFC 0001 第 4.2 节）。

## 提交与发布

- 提交信息遵循 Conventional Commits，例如 `feat(protocol): add chunk index`。
- 影响已发布包的改动要附带 changeset：运行 `pnpm changeset`。
- 较大的设计改动先写 RFC，放在 [`rfcs/`](./rfcs) 目录下。
