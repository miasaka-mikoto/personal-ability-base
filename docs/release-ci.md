# Release / CI contract

PAB 的发布分成两个明确层次：

1. **Offline source lane**：在只安装 Node.js 24、无需 `npm install` 的环境运行 smoke、schema、
   SDK/CLI/Core/Registry tests，制作源码 ZIP 并写出 SHA-256 sidecar。
2. **Native signing lane（未来）**：在独立受保护 runner 中构建 WebView2/
   Tauri 与 Android host，执行安全审计、签名、证明和人工发布审批。

当前 `.github/workflows/ci.yml` 只执行第一层；
`.github/workflows/release.yml` 发布的也是 source-only artifact。这样可以
让开发者获得可审计的源码，而不会把一个 scaffold 误认为可安装产品。

`npm run check:offline` 本身不访问网络，也不会调用付费模型或生成
`package-lock.json`；当前验收 lane 只依赖 Node.js 标准库。完整 Vite 开发
构建仍可由开发者另行安装 dashboard devDependencies。

## 本地入口

```bash
npm run check:offline
npm run release:source
npm run release:check
```

`release:check` 使用 Node 标准库验证 store-only ZIP 的本地头、CRC、manifest
中的 SHA-256、签名状态，并检查压缩包内是否出现 `.pem`、`.key`、`.p12`、
`.pfx` 或 `.jks` 等签名材料；Windows 不需要额外安装 `unzip`/`zipinfo`。

## 版本与安全边界

- 版本来源是根 `package.json`；发布脚本不会自动改版本号。
- Source ZIP 不包含 `node_modules`、临时包、私钥或已生成的 release ZIP。
- Registry 中的 package hash/signature 只有在真实 Release 上传后才能替换为
  正式值；示例值不能作为生产信任根。
- 原生制品必须由专门 host pipeline 生成；本仓库的 Android shell scaffold
  明确把 `apk/aab/signed` 标记为 `false`。
