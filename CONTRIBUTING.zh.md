# 参与 Forgejo Toolkit 贡献

Forgejo Toolkit 是一个由人工维护的开源项目。我们欢迎真实用户的贡献。可以使用 LLM 或其他自动化工具作为编码辅助，但所有变更都必须由人工维护者审阅并提交。

## 如何贡献

1. 开始大型工作之前，先开启一个 issue 讨论变更。
2. Fork 仓库并为你的变更创建一个分支。
3. 做出你的修改。
4. 运行 CI 所运行的检查并修复它们报告的问题：`pnpm run lint`、`pnpm exec oxfmt --check "**/*.{js,mjs,cjs,ts,vue}"`、`pnpm run check`、三个仓库审计——`node tools/api-audit/check.mjs`、`node tools/tracking-audit/check.mjs`、`node tools/docs-audit/check.mjs`——以及两个测试套件：`pnpm --filter forgejo-toolkit test` 与 `pnpm --filter @cpf23333-forgejo-toolkit/shared test`。
5. CI 还会用 `pnpm --filter forgejo-toolkit run build` 构建扩展产物；如果你的改动可能影响构建，请自行运行它。
6. 开启一个描述清晰的 pull request。

## CI 与自动化

我们的 CI 仅用于验证代码。它**不会**自动提交、推送、发布、合并或修改仓库。

在新增或修改 CI 工作流时：

- CI 必须通过人工触发（`workflow_dispatch` 或等效方式），而不是在每次推送或定时自动运行。
- 当人工显式启动时，CI 可以运行 lint、类型检查、测试、构建或多平台矩阵任务。
- 不要添加自动合并、自动发布或自动提交步骤。

## 资源使用

为了使项目在 Codeberg 上可持续运行：

- 不要提交构建产物、依赖项或大型二进制文件。
- 截图和媒体文件应尽量小，或托管到外部。
- 不要将发布用的 `.vsix` 文件存放在 git 中；请附加到 Codeberg Releases。

## 提交信息

提交信息必须使用英文，并遵循 conventional commit 风格：

```
type(scope): short description

Longer explanation if needed.
```

示例：

- `feat(webview): add file history dialog`
- `fix(api): handle empty repository list`
- `docs: update README screenshots`

## 问题与反馈

如有问题或需要报告 bug，请在 [Codeberg Issues](https://codeberg.org/cpf23333/forgejo-toolkit/issues) 开启 issue。

## 许可证

通过提交贡献，你同意将你的贡献以 MIT 许可证授权。
