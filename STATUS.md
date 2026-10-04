# PAB 状态快照（v0.2 scaffold）

更新时间：2026-10-04

本仓库当前是可运行的 PAB Core + Dashboard 原型，并新增了可复现的发布
和平台壳检查入口。发布脚本的目标是让每次提交都能回答“源码是否完整、
离线验收是否通过、包的摘要是什么”，而不是把尚未完成的原生壳包装成
已完成产品。

根项目仍保持 `0.1.0` Core/SDK 兼容版本；这里的“v0.2”表示已交付的
宿主契约、官方 Capture Everything、生命周期 E2E 和发布 scaffold，不是
一次未经迁移评审的 Core API 破坏性版本升级。

## 当前可用

- Core / Ability / User Data 隔离、Ability Runtime、权限和生命周期。
- Registry、依赖解析、SHA-256 / Ed25519 校验、离线缓存。
- Windows/Android 共享 Dashboard 源码和平台桥接契约。
- 同一 Capture Everything 命令已在无原生依赖 E2E 中通过 Windows global
  hotkey 与 Android Share Target 两条宿主路径路由。
- `npm run check:offline`：不访问网络、不调用收费模型的验收入口。
- `npm run release:source` + `npm run release:check`：源码 ZIP、SHA-256
  sidecar 和 unsigned 状态清单。
- `.github/workflows/ci.yml`：每次 push/PR 的 Node 24 离线验收。
- `.github/workflows/release.yml`：tag/手动触发的 source-only GitHub
  Release。

## 明确未完成

- 尚未生成或签名 Windows EXE/MSIX/安装器。
- 尚未生成或签名 Android APK/AAB；`platform/android` 目前只是 bridge
  contract + build-check scaffold。
- 尚未配置生产签名密钥、可信公钥轮换服务或自动更新服务器。
- 尚未创建真实 GitHub Organization/Release Registry；示例 Registry 的
  package hash/signature 仍需正式发布时替换。
- Ability worker/WebView 资源隔离和原生全局热键仍属于后续 host 工作。

## 下一步

1. 固定 WebView2/Tauri Windows host bridge，并加入受控 worker。
2. 固定 Capacitor/Android WebView host，接入 Share Target、Quick Tile 和
   Room/SQLite adapter。
3. 在独立的受保护环境配置签名、可复现构建和发布公钥。
