# PAB Ability Registry

The production registry is a static GitHub-hosted JSON document. It can be
served from a repository such as `PersonalAbilityBase/Registry` and cached by
Core for offline browsing.

Each release is a separate entry in `registry.json`, with a GitHub Release
asset URL, SHA-256, trust level, platform matrix, permissions, dependencies,
minimum Core version, and optional Ed25519 signature. See
`packages/registry-security/fixtures/registry.json` for the complete schema.

The fixture intentionally contains placeholder signing material. Replace the
public key and signatures in a real official registry; never ship the fixture
as a trusted production registry.

Suggested repositories:

```text
PersonalAbilityBase/Core
PersonalAbilityBase/Registry
PersonalAbilityBase/ability-pocket-cortex
PersonalAbilityBase/ability-skill-hud
PersonalAbilityBase/ability-decision-forge
PersonalAbilityBase/ability-capture-everything
```

The example Registry also carries optional `packs` and `loadouts`. Packs
resolve and install modules; loadouts only change focus and never uninstall a
module or remove its user data.

If an organization is unavailable, the same layout works under a personal
GitHub account; only repository URLs in the registry need to change.
