# Changesets

每个会影响已发布包的改动，都需要附带一个 changeset，说明影响了哪些包、版本怎么升、改了什么：

```bash
pnpm changeset
```

发布时，`pnpm changeset version` 会汇总所有 changeset，更新版本号和 CHANGELOG。详见 [Changesets 文档](https://github.com/changesets/changesets)。
