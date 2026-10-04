# `@pab/ability-cli`

Dependency-free developer tooling for Personal Ability Base modules. The
executable is `bin/pab.mjs`; package managers expose it as `pab`.

```bash
pab create my-ability --dir abilities
pab validate abilities/my-ability
pab build abilities/my-ability
pab dev abilities/my-ability --check
pab pack abilities/my-ability --out releases/my-ability-0.1.0.pab
```

`pab build` copies portable `src/` JavaScript into the versioned package
entry under `dist/` and writes a deterministic `build-info.json` containing
the entry digest. `pab pack` creates a portable ZIP `.pab` package in-process,
suitable for the Core installer on Windows, Android development hosts, and
Linux/macOS.

`pab dev` starts a local in-memory Runtime Adapter, activates the module, and
prints its registered contributions. It uses Node watch mode so rebuilding the
module and restarting the command is enough to inspect changes without a
Windows or Android shell.
