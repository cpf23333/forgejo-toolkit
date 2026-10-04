# Contributing to Forgejo Toolkit

Forgejo Toolkit is a human-maintained open source project. We welcome contributions from real people. LLMs and other automated tools may be used as coding assistants, but all changes must be reviewed and committed by human maintainers.

## How to contribute

1. Open an issue to discuss the change before starting large work.
2. Fork the repository and create a branch for your change.
3. Make your changes.
4. Run the checks CI runs and fix what they report: `pnpm run lint`, `pnpm exec oxfmt --check "**/*.{js,mjs,cjs,ts,vue}"`, `pnpm run check`, the three repository audits — `node tools/api-audit/check.mjs`, `node tools/tracking-audit/check.mjs`, `node tools/docs-audit/check.mjs` — and both test suites: `pnpm --filter forgejo-toolkit test` and `pnpm --filter @cpf23333-forgejo-toolkit/shared test`.
5. CI also builds the extension bundle with `pnpm --filter forgejo-toolkit run build`; run it if your change can affect the build.
6. Open a pull request with a clear description.

## CI and automation

Our CI only validates code. It does **not** commit, push, release, merge, or modify the repository autonomously.

When adding or changing CI workflows:

- CI must be triggered manually (`workflow_dispatch` or equivalent), not automatically on every push or on a schedule.
- CI may run lint, typecheck, tests, builds, or multi-platform matrix jobs when a human explicitly starts it.
- Do not add auto-merge, auto-release, or auto-commit steps.

## Resource usage

To keep the project sustainable on Codeberg:

- Do not commit build outputs, dependencies, or large binary files.
- Keep screenshots and media small, or host them externally.
- Do not store release `.vsix` files in git; attach them to Codeberg Releases instead.

## Commit messages

Commit messages must be written in English and follow the conventional commit style:

```
type(scope): short description

Longer explanation if needed.
```

Examples:

- `feat(webview): add file history dialog`
- `fix(api): handle empty repository list`
- `docs: update README screenshots`

## Quotation marks in Chinese prose

In Chinese body text, quotation, emphasis and paraphrase use ASCII `"…"`; `「…」` is reserved for a **locatable named object** — a cited heading or section, a UI label (button, link, panel title, accessible name), a verbatim string (product copy, a log line, a UI message), or a named decision, option or gate.

The reason is not typography: `tools/docs-audit/check.mjs` recognises cited headings by the `「…」` form, so `` `X.md` 的「A heading」 `` and `「A heading」一节/条目/小节` are checked against the target file. Writing those as `"…"` does not fail the check, it makes it **silently disappear**; going the other way makes the audit verify a phrase that never pointed at a heading, which usually fails outright.

- Citing a heading or a section: `docs/architecture/mcp-server.md` 的「Security model」一节.
- Citing a UI label or a verbatim string: click 「提交评审」; the view shows 「未知」.
- Quoting, emphasising or paraphrasing a sentence: write "不确定即放行", not 「不确定即放行」.

## Questions and feedback

Open an issue on [Codeberg](https://codeberg.org/cpf23333/forgejo-toolkit/issues) to ask questions or report problems.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
