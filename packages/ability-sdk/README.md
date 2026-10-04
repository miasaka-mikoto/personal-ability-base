# `@pab/ability-sdk`

Portable API for Personal Ability Base modules. The package has no runtime
dependencies and works in a Windows shell, Android WebView, browser preview,
or the in-memory test host.

```js
import { defineAbility } from "@pab/ability-sdk";

export default defineAbility({
  activate(api) {
    api.registerCommand({
      id: "com.example.hello",
      title: "Say hello",
      execute: () => api.showNotification({ title: "Hello", level: "success" })
    });
  }
});
```

Declare requested permissions and contributions in `manifest.json`; never
access host files or Core internals from module code. See
[`docs/ability-sdk.md`](../../docs/ability-sdk.md) for the full API and
starter workflow.
