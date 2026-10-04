import { ErrorCode, PabError } from "./errors.js";
import { compareVersions, satisfies } from "./semver.js";
import { validateManifest } from "./manifest.js";

/**
 * Resolve Ability dependencies from a registry snapshot. It is intentionally
 * deterministic: candidates are sorted by descending version, then source ID.
 */
export class DependencyResolver {
  /** @param {Iterable<object>|Map<string, object|object[]>} catalog */
  constructor(catalog = []) {
    this.setCatalog(catalog);
  }

  setCatalog(catalog) {
    this.catalog = new Map();
    const entries = catalog instanceof Map ? catalog.entries() : Object.entries(catalog ?? {});
    for (const [key, value] of entries) {
      const values = Array.isArray(value) ? value : [value];
      for (const candidate of values) {
        if (!candidate) continue;
        const manifest = candidate.manifest ?? candidate;
        const checked = validateCatalogManifest(manifest);
        const id = checked.id || key;
        if (!this.catalog.has(id)) this.catalog.set(id, []);
        this.catalog.get(id).push({ ...candidate, manifest: checked });
      }
    }
    for (const candidates of this.catalog.values()) candidates.sort((a, b) => compareVersions(b.manifest.version, a.manifest.version) || String(a.manifest.source ?? "").localeCompare(String(b.manifest.source ?? "")));
    return this;
  }

  /** @param {Record<string,string>|string[]|Map<string,string>} requests @param {{platform?:string,coreVersion?:string,installed?:Map<string,object>,includeOptional?:boolean}} [options] */
  resolve(requests, options = {}) {
    const roots = requests instanceof Map ? Object.fromEntries(requests) : Array.isArray(requests) ? Object.fromEntries(requests.map((id) => [id, "*"])) : { ...(requests ?? {}) };
    const selected = new Map();
    const visiting = [];
    const optionalMissing = [];
    const warnings = [];

    const choose = (id, range, optional = false) => {
      const existing = selected.get(id);
      if (existing) {
        if (!satisfies(existing.manifest.version, range)) {
          if (optional) { optionalMissing.push({ id, range, reason: "version-conflict" }); return; }
          throw new PabError(ErrorCode.DEPENDENCY_CONFLICT, `${id}@${existing.manifest.version} does not satisfy ${range}`, { id, range, selected: existing.manifest.version });
        }
        return;
      }
      if (visiting.includes(id)) {
        const cycle = [...visiting.slice(visiting.indexOf(id)), id];
        throw new PabError(ErrorCode.DEPENDENCY_CYCLE, `Circular dependency: ${cycle.join(" -> ")}`, { cycle });
      }
      const candidates = (this.catalog.get(id) ?? []).filter((candidate) => satisfies(candidate.manifest.version, range));
      const compatible = candidates.filter((candidate) => (!options.platform || candidate.manifest.platforms.includes(options.platform)) && (!options.coreVersion || compatibleCore(candidate.manifest.minCoreVersion, options.coreVersion)));
      const pinned = options.installed instanceof Map ? options.installed.get(id) : options.installed?.[id];
      const pinnedVersion = typeof pinned === "string" ? pinned : pinned?.activeVersion ?? pinned?.version;
      const candidate = (pinnedVersion && compatible.find((item) => item.manifest.version === pinnedVersion)) ?? compatible[0];
      if (!candidate) {
        if (optional) { optionalMissing.push({ id, range, reason: "not-found" }); return; }
        throw new PabError(ErrorCode.DEPENDENCY_MISSING, `No candidate for ${id}@${range}`, { id, range, available: candidates.map((x) => x.manifest.version) });
      }
      for (const [otherId, other] of selected) {
        if (conflictsWith(candidate.manifest, other.manifest) || conflictsWith(other.manifest, candidate.manifest)) {
          throw new PabError(ErrorCode.DEPENDENCY_CONFLICT, `${candidate.manifest.id} conflicts with ${other.manifest.id}`, { id: candidate.manifest.id, conflict: other.manifest.id });
        }
      }
      visiting.push(id);
      for (const [depId, depRange] of Object.entries(candidate.manifest.dependencies)) choose(depId, depRange, false);
      if (options.includeOptional) for (const [depId, depRange] of Object.entries(candidate.manifest.optionalDependencies)) choose(depId, depRange, true);
      visiting.pop();
      selected.set(id, candidate);
      // Dependencies were added during recursion; check the newly selected
      // node against them as well as against previously selected siblings.
      for (const [otherId, other] of selected) {
        if (otherId === id) continue;
        if (conflictsWith(candidate.manifest, other.manifest) || conflictsWith(other.manifest, candidate.manifest)) {
          throw new PabError(ErrorCode.DEPENDENCY_CONFLICT, `${candidate.manifest.id} conflicts with ${other.manifest.id}`, { id: candidate.manifest.id, conflict: other.manifest.id });
        }
      }
    };

    for (const [id, range] of Object.entries(roots)) choose(id, range, false);
    // Dependencies are inserted before parents by a depth-first pass, but the
    // map insertion above occurs after recursion and thus naturally gives an
    // install-safe order.
    const order = [...selected.values()];
    return { selected, order, optionalMissing, warnings };
  }
}

/** Registry entries intentionally omit executable-package fields such as
 * `entry`; fill only those metadata defaults while still running the full
 * manifest validator. A downloaded package manifest remains strict. */
function validateCatalogManifest(manifest) {
  try { return validateManifest(manifest); } catch (error) {
    if (manifest && typeof manifest === "object" && (manifest.packageUrl || manifest.releaseUrl || manifest.repository) && !manifest.entry) {
      return validateManifest({
        schemaVersion: manifest.schemaVersion ?? 1,
        id: manifest.id,
        name: manifest.name ?? manifest.id,
        displayName: manifest.displayName ?? manifest.name ?? manifest.id,
        version: manifest.version,
        description: manifest.description ?? "",
        author: manifest.author ?? "",
        minCoreVersion: manifest.minCoreVersion ?? "0.0.0",
        platforms: manifest.platforms ?? ["windows", "android"],
        permissions: manifest.permissions ?? [],
        dependencies: manifest.dependencies ?? {},
        optionalDependencies: manifest.optionalDependencies ?? {},
        conflicts: manifest.conflicts ?? {},
        contributes: manifest.contributes ?? {},
        entry: "dist/index.js",
        source: manifest.source,
      });
    }
    throw error;
  }
}

function conflictsWith(manifest, other) {
  const range = manifest.conflicts?.[other.id];
  return Boolean(range && satisfies(other.version, range));
}

function compatibleCore(minRange, version) {
  const range = /^\d+(?:\.\d+){0,2}/.test(minRange) ? `>=${minRange}` : minRange;
  return satisfies(version, range);
}
