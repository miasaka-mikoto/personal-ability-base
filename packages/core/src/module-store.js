import { ErrorCode, PabError } from "./errors.js";
import { compareVersions } from "./semver.js";
import { validateManifest } from "./manifest.js";

/**
 * Persists module metadata and version history, never user data. The actual
 * package bytes can be kept by a host filesystem/object store and referenced
 * with `packagePath` or `packageRef`.
 */
export class ModuleStore {
  /** @param {{storage?:any,clock?:()=>number}} [options] */
  constructor(options = {}) {
    this.storage = options.storage;
    this.clock = options.clock ?? (() => Date.now());
    this.records = new Map();
    this.policies = new Map();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    const saved = await this.storage?.get("records", {});
    for (const [id, record] of Object.entries(saved ?? {})) this.records.set(id, normaliseRecord(record));
    const policies = await this.storage?.get("policies", {});
    for (const [id, policy] of Object.entries(policies ?? {})) this.policies.set(id, normalisePolicy(policy));
    this.loaded = true;
  }

  async persist() {
    await this.storage?.set("records", Object.fromEntries(this.records));
    await this.storage?.set("policies", Object.fromEntries(this.policies));
  }

  async list() { await this.load(); return [...this.records.values()].map(cloneRecord); }
  async get(id) { await this.load(); const record = this.records.get(id); return record ? cloneRecord(record) : undefined; }
  async has(id) { await this.load(); return this.records.has(id); }

  async getUpdatePolicy(id) {
    await this.load();
    return { ...normalisePolicy(this.policies.get(id)) };
  }

  async setUpdatePolicy(id, policy) {
    await this.load();
    const normalized = normalisePolicy(policy);
    this.policies.set(id, normalized);
    await this.persist();
    return { ...normalized };
  }

  async installVersion(manifest, metadata = {}) {
    await this.load();
    const checked = validateManifest(manifest);
    const now = this.clock();
    let record = this.records.get(checked.id);
    if (!record) {
      record = { id: checked.id, activeVersion: null, enabled: false, installedAt: now, updatedAt: now, versions: {}, history: [] };
      this.records.set(checked.id, record);
    }
    const version = checked.version;
    const previous = record.activeVersion;
    if (previous && previous !== version && record.versions[previous]) record.versions[previous].state = "installed";
    record.versions[version] = {
      manifest: checked,
      installedAt: record.versions[version]?.installedAt ?? now,
      updatedAt: now,
      packageHash: metadata.packageHash,
      packageRef: metadata.packageRef,
      source: metadata.source,
      state: metadata.activate === false ? "installed" : "active",
    };
    if (previous && previous !== version) record.history = [previous, ...record.history.filter((v) => v !== previous)];
    record.activeVersion = version;
    record.enabled = metadata.activate === false ? record.enabled : true;
    record.updatedAt = now;
    await this.persist();
    return cloneRecord(record);
  }

  async activate(id, version) {
    await this.load();
    const record = this.require(id);
    const target = version ?? record.activeVersion;
    if (!target || !record.versions[target]) throw new PabError(ErrorCode.MODULE_NOT_INSTALLED, `${id}@${target ?? "?"} is not installed`);
    if (record.activeVersion && record.activeVersion !== target && record.versions[record.activeVersion]) record.versions[record.activeVersion].state = "installed";
    record.activeVersion = target;
    record.enabled = true;
    record.versions[target].state = "active";
    await this.persist();
    return cloneRecord(record);
  }

  async disable(id) { return this.setEnabled(id, false); }
  async enable(id) { return this.setEnabled(id, true); }
  async setEnabled(id, enabled) {
    await this.load();
    const record = this.require(id);
    record.enabled = Boolean(enabled);
    record.updatedAt = this.clock();
    await this.persist();
    return cloneRecord(record);
  }

  async removeVersion(id, version) {
    await this.load();
    const record = this.require(id);
    if (!record.versions[version]) throw new PabError(ErrorCode.MODULE_NOT_INSTALLED, `${id}@${version} is not installed`);
    if (record.activeVersion === version) {
      const replacement = [...Object.keys(record.versions)].filter((v) => v !== version).sort((a, b) => compareVersions(b, a))[0];
      if (replacement) record.activeVersion = replacement;
      else record.activeVersion = null;
    }
    delete record.versions[version];
    record.history = record.history.filter((v) => v !== version);
    if (!record.activeVersion) record.enabled = false;
    await this.persist();
    return cloneRecord(record);
  }

  async uninstall(id, { removeVersions = true } = {}) {
    await this.load();
    const record = this.require(id);
    if (removeVersions) this.records.delete(id);
    else { record.enabled = false; record.activeVersion = null; }
    await this.persist();
    return { id, removed: removeVersions, dataPreserved: true };
  }

  async repair(id, version, metadata = {}) {
    await this.load();
    const record = this.require(id);
    const target = record.versions[version ?? record.activeVersion];
    if (!target) throw new PabError(ErrorCode.MODULE_NOT_INSTALLED, `${id}@${version ?? "?"} is not installed`);
    Object.assign(target, metadata, { state: "installed", repairedAt: this.clock() });
    await this.persist();
    return cloneRecord(record);
  }

  require(id) {
    const record = this.records.get(id);
    if (!record) throw new PabError(ErrorCode.MODULE_NOT_INSTALLED, `${id} is not installed`, { id });
    return record;
  }
}

function normaliseRecord(record) {
  return {
    id: record.id,
    activeVersion: record.activeVersion ?? null,
    enabled: Boolean(record.enabled),
    installedAt: record.installedAt ?? Date.now(),
    updatedAt: record.updatedAt ?? Date.now(),
    history: [...(record.history ?? [])],
    versions: Object.fromEntries(Object.entries(record.versions ?? {}).map(([version, value]) => [version, { ...value, manifest: validateManifest(value.manifest) }])),
  };
}

function normalisePolicy(policy) {
  const mode = policy?.mode ?? "manual";
  if (!["automatic", "manual", "ignore", "pinned"].includes(mode)) throw new PabError(ErrorCode.INVALID_STATE, `Unknown update policy: ${mode}`);
  if (mode === "pinned" && (!policy?.version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(policy.version))) throw new PabError(ErrorCode.INVALID_VERSION, "Pinned update policy requires a semantic version");
  if (policy?.version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(policy.version)) throw new PabError(ErrorCode.INVALID_VERSION, "Update policy version must be semantic version");
  return { mode, ...(policy?.version ? { version: policy.version } : {}) };
}

function cloneRecord(record) {
  return typeof structuredClone === "function" ? structuredClone(record) : JSON.parse(JSON.stringify(record));
}
