import { PabRegistryError } from "./errors.ts";
import { compareVersions, satisfies } from "./semver.ts";
import type { AbilityRegistryEntry, DependencyResolution, Platform, RegistryDocument } from "./types.ts";

export interface DependencyResolverOptions {
  platform: Platform;
  coreVersion: string;
  installed?: Record<string, string>;
}

/** Resolves module versions using only registry metadata; it never executes module code. */
export class DependencyResolver {
  private readonly entriesById = new Map<string, AbilityRegistryEntry[]>();
  private readonly options: DependencyResolverOptions;

  constructor(document: RegistryDocument, options: DependencyResolverOptions) {
    this.options = options;
    for (const entry of document.abilities) {
      const list = this.entriesById.get(entry.id) ?? [];
      list.push(entry);
      this.entriesById.set(entry.id, list);
    }
    for (const list of this.entriesById.values()) list.sort((a, b) => compareVersions(b.version, a.version));
  }

  resolve(requested: Record<string, string>): DependencyResolution {
    const selected = new Map<string, AbilityRegistryEntry>();
    const visiting = new Set<string>();
    const order: string[] = [];
    const optionalSkipped: Array<{ id: string; range: string; reason: string }> = [];

    const visit = (id: string, range: string, parent?: string, optional = false): void => {
      const existing = selected.get(id);
      if (existing) {
        if (satisfies(existing.version, range)) return;
        if (optional) {
          optionalSkipped.push({ id, range, reason: `Selected ${existing.version} does not satisfy ${range}` });
          return;
        }
        throw new PabRegistryError("DEPENDENCY_CONFLICT", `${id}@${existing.version} does not satisfy ${range}`, { id, selected: existing.version, required: range, parent });
      }
      if (visiting.has(id)) throw new PabRegistryError("DEPENDENCY_CYCLE", `Circular dependency detected at ${id}`, { id, parent });
      const entry = this.pick(id, range);
      if (!entry) {
        if (optional) {
          optionalSkipped.push({ id, range, reason: "No compatible registry entry" });
          return;
        }
        throw new PabRegistryError("DEPENDENCY_MISSING", `No compatible version found for ${id} (${range})`, { id, range, parent, platform: this.options.platform });
      }
      visiting.add(id);
      for (const [dependencyId, dependencyRange] of Object.entries(entry.dependencies ?? {})) visit(dependencyId, dependencyRange, id, false);
      for (const [dependencyId, dependencyRange] of Object.entries(entry.optionalDependencies ?? {})) visit(dependencyId, dependencyRange, id, true);
      visiting.delete(id);
      // Mark after descendants so installation can safely proceed dependency-first.
      selected.set(id, entry);
      order.push(id);
      this.checkConflicts(entry, selected);
    };

    for (const [id, range] of Object.entries(requested)) visit(id, range);
    return { requested: { ...requested }, selected: Object.fromEntries(selected) as Record<string, AbilityRegistryEntry>, order, optionalSkipped };
  }

  resolvePack(abilityIds: string[]): DependencyResolution {
    const requested: Record<string, string> = {};
    for (const id of abilityIds) requested[id] = "*";
    return this.resolve(requested);
  }

  private pick(id: string, range: string): AbilityRegistryEntry | undefined {
    const installed = this.options.installed?.[id];
    const candidates = (this.entriesById.get(id) ?? []).filter((entry) =>
      entry.platforms.includes(this.options.platform) &&
      satisfies(this.options.coreVersion, `>=${entry.minCoreVersion}`) &&
      satisfies(entry.version, range));
    if (installed) {
      const preferred = candidates.find((entry) => entry.version === installed);
      if (preferred) return preferred;
    }
    return candidates[0];
  }

  private checkConflicts(entry: AbilityRegistryEntry, selected: Map<string, AbilityRegistryEntry>): void {
    for (const [conflictId, conflictRange] of Object.entries(entry.conflicts ?? {})) {
      const other = selected.get(conflictId);
      if (other && satisfies(other.version, conflictRange)) {
        throw new PabRegistryError("DEPENDENCY_CONFLICT", `${entry.id}@${entry.version} conflicts with ${conflictId}@${other.version}`, { id: entry.id, conflictId, conflictRange, otherVersion: other.version });
      }
    }
    for (const other of selected.values()) {
      const inverse = other.conflicts?.[entry.id];
      if (inverse && satisfies(entry.version, inverse)) {
        throw new PabRegistryError("DEPENDENCY_CONFLICT", `${other.id}@${other.version} conflicts with ${entry.id}@${entry.version}`, { id: other.id, conflictId: entry.id, conflictRange: inverse });
      }
    }
  }
}

