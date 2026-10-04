# SiYuan 技术评估记录

日期：2026-10-04  
项目：Personal Ability Base（PAB）  
状态：已完成初步源码、构建和插件架构核对

## 结论

不将 SiYuan 整体 Fork 作为 PAB Core。SiYuan 适合作为可选的知识/块数据引擎，或在后续通过适配层复用其成熟能力；PAB Core、Ability Runtime、Registry、权限和生命周期管理应保持独立。

这不是对 SiYuan 质量的否定，而是产品边界不同：SiYuan 的扩展模型是“在知识工作区中加载插件”，PAB 的核心模型是“能力模块拥有独立版本、权限、依赖、数据和运行时，并可跨 Windows/Android 安全安装、停用、升级和回滚”。

## 已核对的官方资料

- 主仓库及架构说明：<https://github.com/siyuan-note/siyuan>
- 当前发布页（截至本记录日，`v3.8.7-alpha.3`，稳定版 `v3.8.6`）：<https://github.com/siyuan-note/siyuan/releases>
- 开发与构建说明：<https://github.com/siyuan-note/siyuan/blob/master/.github/CONTRIBUTING.md>
- Android 包装工程：<https://github.com/siyuan-note/siyuan-android>
- 官方插件 API 类型仓库：<https://github.com/siyuan-note/petal>
- 官方插件模板及 manifest 说明：<https://github.com/siyuan-note/plugin-sample>
- 社区 Bazaar：<https://github.com/siyuan-note/bazaar>
- HTTP API：<https://github.com/siyuan-note/siyuan/blob/master/docs/API.md>
- 插件发布/数据授权：<https://github.com/siyuan-note/siyuan/blob/master/docs/PLUGIN-PUBLISH.md>
- 许可证：<https://github.com/siyuan-note/siyuan/blob/master/LICENSE>

## 构建事实

SiYuan 当前是 Electron 前端 + Go kernel 的组合。官方开发说明要求：

```text
# app
Node.js 24
pnpm 12.5.1（以 app/package.json 的 packageManager 为准）
pnpm install electron@44.4.5
pnpm run install:electron
pnpm run dev                 # 开发前端

# desktop kernel
cd kernel
CGO_ENABLED=1
go build -tags "fts5 sqlcipher" -o ../app/kernel/SiYuan-Kernel.exe

# Android kernel binding
cd kernel
gomobile bind -tags "fts5 sqlcipher" -ldflags "-s -w" \\
  -v -o kernel.aar -target android/arm64 -androidapi 26 ./mobile/
```

Android 工程再把 `appearance`、`guide`、`stage`、`changelogs` 等资源放入 `app/src/main/assets/app.zip`，由 Gradle 生成 APK/AAB。也就是说，桌面和 Android 共享 Go kernel，但仍然是两个平台包装工程，并非一个可直接装载任意 Ability 的统一运行时。

## SiYuan 可复用的部分

| 能力 | 证据/价值 | PAB 采用方式 |
| --- | --- | --- |
| 块模型、引用、反向链接、Markdown WYSIWYG | 主仓库 README 的核心特性 | 作为可选 `knowledge`/`memory` provider，不能成为所有 Ability 的隐式依赖 |
| 搜索、SQL、数据库视图、资产和导入导出 | 官方 HTTP API 和 CLI 已覆盖 | 在 `pab-storage` 适配层暴露最小接口 |
| Go kernel + SQLite/FTS5/SQLCipher 构建链 | 官方构建脚本 | 先做独立 adapter spike；不要把 PAB Core 绑定到 SiYuan 内部路由 |
| Windows/Android 发行路径 | Electron + gomobile/AAR 已验证 | 可借鉴 CI、打包和平台能力抽象 |
| 插件市场的 GitHub Release + `package.zip` 流程 | Bazaar 官方规则 | 只借鉴分发经验；PAB Registry 要有自己的签名、哈希和依赖字段 |

## 与 PAB 要求的结构性差异

### 1. 扩展不是受控 Ability Runtime

官方插件包主要包含 `index.js`/`index.css`/`plugin.json`，可选 `kernel.js`。前端插件继承 `Plugin`，在宿主前端进程运行；kernel 插件通过 JSON-RPC 与前端通信。`plugin.json` 有 `name`、`version`、`minAppVersion`、`kernels`、`backends`、`frontends` 等字段，但没有 PAB 所需的统一 reverse-DNS ID、权限声明、依赖/冲突图、贡献点 schema、签名策略或回滚元数据。

SiYuan 最近加入了 kernel-plugin sandbox 和 Web Crypto 支持，这是有价值的安全基础，但它仍是 SiYuan 插件模型的一部分，不能直接等同于 PAB 的跨平台 Ability Runtime。PAB 需要从入口、API、存储、网络、系统权限到 UI contribution 都由 Core 代理和审计。

### 2. Bazaar 不是 PAB Registry

Bazaar 首次上架需要向中央仓库的 `plugins.txt` 提交 `owner/repo`，后续通过 GitHub Release 上传 `package.zip`，索引通常每 1–3 小时更新。这个流程没有 PAB manifest 中要求的 SHA-256、数字签名、公钥信任根、平台兼容矩阵、依赖解析、冲突检测、安装迁移和版本回滚协议。因此 PAB 应建立自己的 `registry.json`/分片 Registry，并将 Bazaar 仅视为参考。

### 3. 数据与模块边界不满足 PAB 默认策略

SiYuan 工作区同时包含 `plugins`、`storage`、`assets`、`public` 和笔记本 `.sy` 数据。插件 sample 的 `uninstall()` 示例会主动删除插件数据；这与 PAB“卸载代码默认保留人生数据、重新安装可恢复”的要求相反。PAB 必须把模块代码放在版本化目录（例如 `modules/<id>/<version>`），把用户数据放在独立的 `userdata/abilities/<id>`，并由 Core 处理 migration、backup、rollback 和 keep-data 选项。

### 4. 平台和产品壳层不相同

SiYuan 的桌面壳是 Electron 44，Android 是独立 Gradle 工程；移动端通过预打包资源和 AAR 接入完整 SiYuan UI。PAB 的首页、Loadout、Ability Store、Command Palette、Quick Tile/Share Target 等不是 SiYuan 的自然 UI contribution，若从 SiYuan 页面树开始改造，核心升级会和产品壳层长期耦合。

### 5. 许可证约束

SiYuan 主仓库和 Android 工程标注 AGPL-3.0。若分发修改后的整体 Fork，需要遵守 AGPL 的源代码、许可证和相应通知义务；不能把 Fork 后的 Core 当作闭源/宽松许可证组件。即使 PAB 计划开源，也应在仓库中保留清晰的第三方目录、NOTICE、变更记录和许可证边界。是否采用 SiYuan 代码，需在实现前确认最终分发模式。

## 决策与迁移成本

**采用的方案：独立 PAB Core + 可插拔 SiYuan adapter。**

- PAB Core：独立实现 manifest 校验、Ability Loader、权限、依赖、事件/命令总线、Registry、签名/哈希、版本目录、迁移和回滚。
- PAB Runtime：优先 TypeScript/JavaScript + declarative UI；高风险/高性能代码预留 WASM。Ability 不直接获得 Node/Electron/Android 原生权限。
- `pab-storage`：先提供 PAB 自己的 SQLite/JSON 存储接口；另做可选 SiYuan adapter，调用稳定 HTTP API 或经过明确边界的 kernel 接口。
- PAB UI：独立 Dashboard/Store/Loadout；不得把 SiYuan 的传统笔记侧栏作为首页。

迁移成本是需要自行实现一套 Core/Runtime/Registry，短期代码量高于直接 Fork；收益是 Windows/Android 共用 Ability 契约、可验证供应链、可回滚数据、清晰的 Core/Ability/User Data 分离，以及未来替换存储引擎时不破坏模块生态。

## 建议的验证 Spike（仅在需要时执行）

1. 在隔离分支编译稳定版 `v3.8.6` 的 desktop kernel 和 Android AAR。
2. 在 Windows 和 Android 安装官方 plugin sample，验证 `index.js`、可选 `kernel.js`、生命周期和数据目录行为。
3. 写一个只读 PAB adapter：把 SiYuan block/search API 映射为 `StorageProvider`，不得让 PAB Ability 直接调用 `/api/*`。
4. 用一个最小 PAB manifest 做安装/禁用/保留数据/回滚测试。

若该 Spike 需要修改 SiYuan kernel、Android wrapper 或前端生命周期才能实现 PAB 的权限和回滚要求，应停止继续 Fork，保留 adapter 路线。

