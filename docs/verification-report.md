# PAB v0.2 验收记录

日期：2026-10-04

## 已验证

| 检查 | 结果 |
| --- | --- |
| Core / SDK / CLI / Registry / Host Adapter 单元测试 | PASS |
| Core 安装、激活、更新、回滚、禁用、卸载保留数据 | PASS |
| 四个官方 Ability（含 Capture Everything） | PASS |
| SHA-256、Ed25519、依赖图、离线 Registry、ZIP 路径防护 | PASS |
| Ability SDK manifest 校验与 `pab create/dev/build/validate/pack` | PASS |
| Dashboard source smoke（Store、安装阶段、权限、Loadout、Command Palette） | PASS |
| Registry installer demo（Discover → Download → Verify → Install） | PASS |
| Registry example schema / Ability Pack validation | PASS |
| Request/Response Bus、持久化更新策略（automatic/manual/ignore/pinned） | PASS |
| v0.2 lifecycle E2E（离线 Registry、安装、激活、禁用/启用、更新/回滚、卸载保留数据、重装） | PASS |
| Windows/Android host adapter contract 与平台 scaffold 检查 | PASS |
| 可复现 source-only ZIP、SHA-256 sidecar、unsigned 状态检查 | PASS |

可重复执行：

```bash
npm test
npm run smoke
npm run validate:abilities
npm run dashboard:smoke
npm run demo:install
npm run validate:registry
npm run e2e:v02
npm run check:offline
npm run release:source
npm run release:check
```

## 当前交付边界

- 这是可运行的 Core、Runtime、SDK、Registry 安全层、Host Adapter contract、
  Capture Everything 和 Dashboard 原型；
  尚未生成签名的 Windows 安装器或 Android APK/AAB。
- `registry/registry.example.json` 的公钥、签名和摘要是占位示例，不能直接
  作为生产官方 Registry。发布时必须替换为实际 Release 包和 Core 内置的
  pinned Ed25519 公钥。
- 下载的 JavaScript 在 v0.2 scaffold 通过受限 Ability API 运行；生产 Windows/Android
  Shell 仍需把模块放入 Worker/WebView 沙箱，并以 capability bridge 提供系统
  API。Core 不执行下载的 Kotlin/Java 原生二进制。
- Vite/TypeScript 的完整生产构建需要联网安装开发依赖；无依赖环境下的
  `dashboard:smoke` 和 Node 24 TypeScript 语法检查已通过。安装依赖后可运行
  `npm run dashboard:build` 生成 Vite 生产包。
