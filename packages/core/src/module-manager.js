import { ErrorCode, PabError } from "./errors.js";
import { assertManifestCompatible, validateManifest } from "./manifest.js";
import { DependencyResolver } from "./dependency-resolver.js";

/** Coordinates install/update/rollback without coupling Core to a filesystem. */
export class ModuleManager {
  /** @param {{coreVersion:string,platform:string,store:any,runtime?:any,eventBus:any,dependencyResolver?:DependencyResolver,registry?:any,verifyHash?:Function,verifySignature?:Function,download?:Function}} options */
  constructor(options) {
    this.options = options;
    this.store = options.store;
    this.runtime = options.runtime;
    this.eventBus = options.eventBus;
    this.registry = options.registry;
    this.resolver = options.dependencyResolver ?? new DependencyResolver();
  }

  /** Refresh resolver catalog from registry entries. */
  setCatalog(entries) { this.resolver.setCatalog(entries); }

  async install(input, options = {}) {
    const pkg = await this.#obtainPackage(input, options);
    const manifest = assertManifestCompatible(pkg.manifest, { coreVersion: this.options.coreVersion, platform: this.options.platform });
    await this.#emitProgress(manifest.id, "discover", { manifest });
    await this.#verify(pkg, options);
    await this.#emitProgress(manifest.id, "verify", { version: manifest.version });
    const resolution = this.#resolveWithPackage(pkg, options);
    await this.#emitProgress(manifest.id, "dependencies", { order: resolution.order.map((x) => x.manifest.id) });
    const current = await this.store.get(manifest.id);
    const fromVersion = current?.activeVersion;
    if (fromVersion && fromVersion !== manifest.version && manifest.migrations?.length && typeof this.options.migrate === "function") {
      await this.#emitProgress(manifest.id, "migration", { from: fromVersion, to: manifest.version });
      try {
        await this.options.migrate({ id: manifest.id, fromVersion, toVersion: manifest.version, manifest, migrations: manifest.migrations });
      } catch (error) {
        throw new PabError(ErrorCode.MIGRATION_FAILED, `Migration failed for ${manifest.id} ${fromVersion} -> ${manifest.version}`, { id: manifest.id, from: fromVersion, to: manifest.version, cause: String(error) });
      }
    }
    // Dependencies supplied by the host downloader are installed first. A
    // registry-only dependency can still be resolved and displayed before the
    // host fetches its package in a subsequent call.
    for (const candidate of resolution.order) {
      let candidatePackage = candidate.package ?? (candidate.manifest.id === manifest.id ? pkg : null);
      if (!candidatePackage && this.options.download) {
        candidatePackage = await this.options.download(candidate.manifest.id, { version: candidate.manifest.version, dependency: true });
      }
      if (!candidatePackage && candidate.manifest.id !== manifest.id) {
        throw new PabError(ErrorCode.DEPENDENCY_MISSING, `Package bytes unavailable for dependency ${candidate.manifest.id}@${candidate.manifest.version}`, { id: candidate.manifest.id, version: candidate.manifest.version });
      }
      if (!candidatePackage) continue;
      candidatePackage = { ...candidatePackage, manifest: validateManifest(candidatePackage.manifest ?? candidate.manifest) };
      if (candidate.manifest.id !== manifest.id) await this.#verify(candidatePackage, options);
      await this.store.installVersion(candidate.manifest, {
        packageHash: candidatePackage.packageHash,
        packageRef: candidatePackage.packageRef,
        source: candidatePackage.source ?? "github",
        activate: false,
      });
    }
    const installed = await this.store.installVersion(manifest, {
      packageHash: pkg.packageHash,
      packageRef: pkg.packageRef,
      source: pkg.source ?? "github",
      activate: options.activate !== false,
    });
    await this.#emitProgress(manifest.id, "installed", { version: manifest.version });
    if (options.activate !== false && this.runtime) {
      await this.runtime.deactivate(manifest.id);
      await this.runtime.activate({ manifest, packageRef: pkg.packageRef }, { loader: pkg.loader });
      await this.#emitProgress(manifest.id, "activated", { version: manifest.version });
    }
    await this.eventBus?.publish("ability.installed", { id: manifest.id, version: manifest.version }, { source: "core" });
    return { record: installed, resolution };
  }

  async update(input, options = {}) {
    const pkg = await this.#obtainPackage(input, options);
    const current = await this.store.get(pkg.manifest.id);
    if (!current) return this.install(pkg, options);
    const policy = await this.store.getUpdatePolicy(pkg.manifest.id);
    const trigger = options.trigger ?? "manual";
    const ignoredVersion = policy.version;
    let skipReason;
    if (!options.force) {
      if (policy.mode === "pinned" && pkg.manifest.version !== policy.version) skipReason = `pinned:${policy.version}`;
      else if (policy.mode === "ignore" && (!ignoredVersion || pkg.manifest.version === ignoredVersion)) skipReason = ignoredVersion ? `ignored:${ignoredVersion}` : "ignored";
      else if (trigger === "automatic" && policy.mode !== "automatic") skipReason = `policy:${policy.mode}`;
    }
    if (skipReason) return { skipped: true, reason: skipReason, policy, record: current };
    return this.install(pkg, { ...options, activate: options.activate ?? current.enabled });
  }

  async getUpdatePolicy(id) { return this.store.getUpdatePolicy(id); }
  async setUpdatePolicy(id, policy) { return this.store.setUpdatePolicy(id, policy); }

  async rollback(id, version, options = {}) {
    const current = await this.store.get(id);
    if (!current) throw new PabError(ErrorCode.MODULE_NOT_INSTALLED, `${id} is not installed`);
    const target = version ?? current.history[0];
    if (!target || !current.versions[target]) throw new PabError(ErrorCode.ROLLBACK_UNAVAILABLE, `No installed version available for ${id}`, { id, version: target });
    if (this.runtime) await this.runtime.deactivate(id);
    const record = await this.store.activate(id, target);
    if (record.enabled && this.runtime) {
      const pkg = record.versions[target];
      await this.runtime.activate({ manifest: pkg.manifest, packageRef: pkg.packageRef }, { loader: options.loader });
    }
    await this.eventBus?.publish("ability.rolled_back", { id, version: target }, { source: "core" });
    return record;
  }

  async disable(id) {
    if (this.runtime) {
      try { await this.runtime.deactivate(id); }
      catch (error) { await this.eventBus?.publish("ability.deactivation.failed", { id, error: String(error) }, { source: "core" }); }
    }
    const record = await this.store.disable(id);
    await this.eventBus?.publish("ability.disabled", { id }, { source: "core" });
    return record;
  }

  async enable(id, options = {}) {
    const record = await this.store.enable(id);
    const version = record.activeVersion;
    if (this.runtime && version) await this.runtime.activate({ manifest: record.versions[version].manifest, packageRef: record.versions[version].packageRef }, { loader: options.loader });
    await this.eventBus?.publish("ability.enabled", { id, version }, { source: "core" });
    return record;
  }

  async uninstall(id, options = {}) {
    if (this.runtime) {
      try { await this.runtime.deactivate(id); }
      catch (error) { await this.eventBus?.publish("ability.deactivation.failed", { id, error: String(error) }, { source: "core" }); }
    }
    const result = await this.store.uninstall(id, { removeVersions: options.removeModule !== false });
    const dataRemoved = options.removeData === true || options.keepData === false;
    await this.eventBus?.publish("ability.uninstalled", { id, dataPreserved: !dataRemoved, dataRemoved, removeModule: options.removeModule !== false }, { source: "core" });
    return result;
  }

  async #obtainPackage(input, options) {
    const pkg = typeof input === "string" ? await this.options.download?.(input, options) : input;
    if (!pkg?.manifest) throw new PabError(ErrorCode.INVALID_MANIFEST, "Install requires a package manifest");
    return { ...pkg, manifest: validateManifest(pkg.manifest) };
  }

  #resolveWithPackage(pkg, options) {
    // Preserve a catalog supplied through `setCatalog()` when no Registry
    // service is attached; hosts commonly refresh the registry separately.
    const entries = new Map(this.resolver.catalog ?? []);
    entries.set(pkg.manifest.id, [{ manifest: pkg.manifest, package: pkg, source: pkg.source }]);
    // The registry may expose multiple versions and dependency packages.
    const registryEntries = this.registry?.list?.() ?? this.registry?.entries ?? [];
    for (const entry of registryEntries) {
      const manifest = entry.manifest ?? entry;
      if (!manifest?.id || manifest.id === pkg.manifest.id) continue;
      const candidate = { ...entry, manifest };
      if (!entries.has(manifest.id)) entries.set(manifest.id, []);
      entries.get(manifest.id).push(candidate);
    }
    this.resolver.setCatalog(entries);
    return this.resolver.resolve({ [pkg.manifest.id]: pkg.manifest.version }, { platform: this.options.platform, coreVersion: this.options.coreVersion, includeOptional: options.includeOptionalDependencies, installed: options.installed ?? options.pinnedVersions });
  }

  async #verify(pkg, options) {
    if (pkg.expectedHash || pkg.sha256) {
      if (typeof this.options.verifyHash !== "function") throw new PabError(ErrorCode.HASH_MISMATCH, "No hash verifier is configured");
      const valid = await this.options.verifyHash(pkg, pkg.expectedHash ?? pkg.sha256);
      if (!valid) throw new PabError(ErrorCode.HASH_MISMATCH, "Ability package SHA-256 verification failed", { id: pkg.manifest.id });
    }
    if (pkg.signature || pkg.signatureEnvelope) {
      if (typeof this.options.verifySignature !== "function") throw new PabError(ErrorCode.SIGNATURE_INVALID, "No signature verifier is configured");
      const valid = await this.options.verifySignature(pkg);
      if (!valid) throw new PabError(ErrorCode.SIGNATURE_INVALID, "Ability package signature is invalid", { id: pkg.manifest.id });
    }
  }

  async #emitProgress(id, stage, details = {}) { await this.eventBus?.publish("ability.install.progress", { id, stage, ...details }, { source: "core" }); }
}
