# PAB 验收清单（v0.2 scaffold）

这份清单区分“当前可自动验证的源码能力”和“仍需原生环境的交付项”。
通过源码检查不等于已经生成签名 EXE、APK 或 AAB。

## 自动验收

在 Node.js 24+、不需要网络的工作区执行：

```bash
npm run check:offline
npm run platform:verify
npm run release:source
npm run release:check
```

预期结果：

| 检查 | 结果含义 |
| --- | --- |
| `check:offline` | Core、SDK、CLI、平台适配器、Registry、Ability、Dashboard smoke 全部通过 |
| `e2e:v02` | 同一 Capture Everything 包经 Windows global hotkey 与 Android Share Target 路由，并完成完整生命周期 |
| `platform:verify` | Windows launcher 与 Android bridge contract 存在且字段一致 |
| `release:source` | 生成 source-only ZIP、SHA-256 manifest、unsigned status |
| `release:check` | Node-only ZIP CRC/摘要检查通过、未携带签名材料、未冒充 signed |

## 平台壳验收

### Windows

- [x] PowerShell/CMD launcher 指向 `apps/dashboard/preview.mjs`。
- [x] `bridge-contract.json` 与 Android 声明同一组核心命令/事件。
- [x] Node 缺失时给出可读错误。
- [ ] WebView2/Tauri host bridge。
- [ ] global hotkey、native notification、signed updater。
- [ ] signed EXE/MSIX/installer。

### Android

- [x] `bridge-contract.json` 定义 snapshot、command、install、capture、
  recall 和事件表面。
- [x] `build-shell.sh` 默认只做离线 contract check。
- [x] `PAB_ANDROID_BUILD_MODE=native` 明确报告 “native artifact not built”。
- [ ] Capacitor/WebView host project。
- [ ] Share Target、Quick Tile、widget、shortcut、notification action。
- [ ] signed APK/AAB 和 Play/App distribution metadata。

## 发布验收边界

GitHub Actions 会上传 source-only bundle。它不会自动生成或暗示原生签名
制品；签名流水线必须在独立变更中配置密钥、密钥轮换、构建证明和人工
审批。
