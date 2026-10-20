# 编码方案基准（RFC 0001 附录 A）

在真实浏览器里比较几种会话录制数据编码方案的主线程耗时、压缩后体积和解码耗时：

- JSON（TimeCat 1.x 风格的对象树 / 紧凑元组）
- msgpackr（对象 / records 扩展 / 元组）
- 单遍二进制：遍历 DOM 时直接写入，包含字符串表、隐式节点 ID 和 varint
- 指针轨迹：1.x 对象 / JSON 元组 / 列式差分 + varint

测试页面是一个合成的电商列表页，DOM 生成逻辑在 `bench-page.js` 的 `buildPage()` 中。

## 运行

```bash
npm install
npx playwright-core install chromium   # 或者设置 CHROMIUM_PATH 指向已安装的 Chromium
node run.mjs 400     # 约 1.28 万节点
node run.mjs 1600    # 约 5.1 万节点
```

输出为 JSON，各项均为预热后 9 次测量的中位数。结果见 [RFC 0001 附录 A](../../0001-timecat-next.md#附录-a编码方案基准2026-10-20)。

这是一次性的原型测试，不是正式基准套件。正式基准放在 M0 的 `apps/bench` 中，会覆盖真实页面夹具、三个浏览器引擎，并与 rrweb 对比。
