# AGENTS.md — Forgejo Toolkit

本项目是 VS Code 扩展 **Forgejo Toolkit**，采用 pnpm monorepo 结构。

## 项目结构

```
forgejo-toolkit/
├── .vscode/                          # 根目录 VS Code 配置（launch/tasks）
├── packages/
│   ├── forgejo-toolkit/              # VS Code 扩展主体
│   │   ├── .vscode/                  # 包级 VS Code 配置
│   │   ├── src/                      # 扩展主机代码（Node/CJS）
│   │   ├── webview/                  # Webview 前端（Vue 3 + Vite）
│   │   │   ├── src/
│   │   │   │   ├── views/            # 页面级组件
│   │   │   │   ├── composables/      # 组合式逻辑
│   │   │   │   ├── locales/          # i18n 语言文件
│   │   │   │   └── types/            # 共享类型
│   │   │   ├── index.html
│   │   │   └── vite.config.ts
│   │   ├── esbuild.js                # 扩展构建脚本
│   │   └── package.json
│   └── vscode-elements-vue/          # 共享包：VSCode Elements Vue 适配
│       ├── src/
│       └── package.json
├── package.json
└── pnpm-workspace.yaml
```

## 技术栈

- **扩展主机**：TypeScript、esbuild、CJS、Node 18+
- **Webview**：Vue 3、Vite 8、TypeScript
- **UI 组件**：`@vscode-elements/elements`
- **国际化**：`vue-i18n@10`
- **包管理**：pnpm workspaces

## 常用命令

所有命令均应在仓库根目录执行：

```bash
# 安装依赖
pnpm install

# 构建扩展
pnpm --filter forgejo-toolkit run build

# 开发监听模式（同时监听扩展和 webview）
pnpm --filter forgejo-toolkit run dev

# 类型检查
pnpm --filter forgejo-toolkit run check

# 清理构建产物
pnpm --filter forgejo-toolkit run clean
```

## 开发工作流

1. 在 VS Code 中打开 `D:/code/forgejo-toolkit`。
2. 按 `F5` 启动 **Run Extension**。该配置会先执行 `dev` 任务，启动 esbuild 和 Vite 监听。
3. 修改代码并保存：
   - 扩展主机代码变更 → esbuild 重新生成 `out/extension.js`
   - Webview 代码变更 → Vite 重新生成 `out/webview/`
4. 在 Extension Host 窗口中按 `Ctrl+R` 或执行 **Developer: Reload Window** 加载最新扩展。

> 注意：VS Code Webview 内无法实现真正的 HMR，因此扩展主机刷新是必要的。

## 代码规范

- 扩展主机代码使用 CommonJS（`format: 'cjs'`），`vscode` 模块标记为 `external`。
- Webview 代码使用 ESM，Vite 构建输出到 `out/webview/`。
- Vue 单文件组件中：
  - 使用 `<script setup lang="ts">`
  - 导入 `.vue` 组件时必须带 `.vue` 扩展名
  - 优先使用相对路径，避免在 SFC 中使用 `../views/X.vue` 这种跨层路径
- 类型共享：webvew 与扩展之间的共享类型放在 `webview/src/types/`。

## 国际化（i18n）

- 支持语言：`en`（英文）、`zh`（中文）。
- 默认根据 VS Code 语言自动检测：`zh*` → 中文，其他 → 英文。
- 用户可通過设置 `forgejoToolkit.locale` 手动覆盖。
- Webview 内通过 `vue-i18n` 切换语言，并通过 `postMessage` 通知扩展持久化配置。
- 新增文案时，必须同时更新 `webview/src/locales/en.json` 和 `zh.json`。

## Webview 与扩展通信

- 扩展端：`src/webview/viewProvider.ts` 中的 `_reply` 方法向 webview 发送消息。
- Webview 端：`composables/vscode.ts` 封装 `acquireVsCodeApi()` 的 `postMessage`。
- 消息格式统一为 `{ command: string, ...payload }`。
- 新增命令时，需要同时更新：
  1. `viewProvider.ts` 的 message switch case
  2. Webview 中调用 `vscode.postMessage` 的位置
  3. 如有必要，补充类型定义

## 依赖管理

- 新增依赖优先安装到对应 package，避免直接安装到根目录。
- 工作区包通过 `workspace:*` 引用。
- 升级依赖前建议先运行 `pnpm --filter forgejo-toolkit run check` 确认类型安全。

## 调试建议

- 调试扩展时建议单独禁用其他扩展（取消 `launch.json` 中 `--disable-extensions` 的注释）。
- 如果 webview 不更新，检查 `out/webview/` 是否已重新生成，然后重启 Extension Host。
- 构建失败时，分别运行 `pnpm run watch:extension` 和 `pnpm run watch:webview` 以定位问题来源。

## 发布

```bash
pnpm --filter forgejo-toolkit run vscode:prepublish
pnpm --filter forgejo-toolkit run package
```

发布前确保：

- `package.json` 中的 `publisher` 已更新
- `CHANGELOG.md` 已记录变更（如适用）
- 版本号已正确提升
