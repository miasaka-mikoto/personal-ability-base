import { ErrorCode, PabError } from "./errors.js";

export const PermissionDecision = Object.freeze({ ALLOW: "allow", DENY: "deny", ASK: "ask" });

/**
 * Per-ability permission store. The host supplies `prompt` to present a
 * native Windows/Android consent sheet; tests and headless mode can use a
 * deterministic callback.
 */
export class PermissionManager {
  /** @param {{storage?:any,eventBus?:any,prompt?:(request:object)=>Promise<string>|string,defaultDecision?:string}} [options] */
  constructor(options = {}) {
    this.storage = options.storage;
    this.eventBus = options.eventBus;
    this.prompt = options.prompt;
    this.defaultDecision = options.defaultDecision ?? PermissionDecision.ASK;
    /** @type {Map<string,Map<string,string>>} */
    this.grants = new Map();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    const saved = await this.storage?.get("grants", {});
    for (const [abilityId, permissions] of Object.entries(saved ?? {})) this.grants.set(abilityId, new Map(Object.entries(permissions ?? {})));
    this.loaded = true;
  }

  async persist() {
    const serialised = Object.fromEntries([...this.grants].map(([id, values]) => [id, Object.fromEntries(values)]));
    await this.storage?.set("grants", serialised);
  }

  async get(abilityId, permission) {
    await this.load();
    return this.grants.get(abilityId)?.get(permission) ?? this.defaultDecision;
  }

  async list(abilityId) {
    await this.load();
    return Object.fromEntries(this.grants.get(abilityId) ?? []);
  }

  async set(abilityId, permission, decision) {
    if (!Object.values(PermissionDecision).includes(decision)) throw new TypeError(`Unknown permission decision: ${decision}`);
    await this.load();
    if (!this.grants.has(abilityId)) this.grants.set(abilityId, new Map());
    this.grants.get(abilityId).set(permission, decision);
    await this.persist();
    await this.eventBus?.publish("permission.changed", { abilityId, permission, decision }, { source: "core" });
    return decision;
  }

  async request(abilityId, permissions, context = {}) {
    const requested = [...new Set(permissions ?? [])];
    const decisions = {};
    for (const permission of requested) {
      let decision = await this.get(abilityId, permission);
      if (decision === PermissionDecision.ASK && this.prompt) {
        decision = await this.prompt({ abilityId, permission, ...context });
        if (!Object.values(PermissionDecision).includes(decision)) decision = PermissionDecision.DENY;
        await this.set(abilityId, permission, decision);
      }
      decisions[permission] = decision;
    }
    return decisions;
  }

  async assert(abilityId, permission, context = {}) {
    const decision = await this.get(abilityId, permission);
    if (decision === PermissionDecision.ASK) {
      const result = await this.request(abilityId, [permission], context);
      if (result[permission] !== PermissionDecision.ALLOW) throw new PabError(ErrorCode.PERMISSION_REQUIRED, `${abilityId} requires permission ${permission}`, { abilityId, permission, decision: result[permission] });
      return true;
    }
    if (decision !== PermissionDecision.ALLOW) throw new PabError(ErrorCode.PERMISSION_DENIED, `${abilityId} is not allowed to use ${permission}`, { abilityId, permission, decision });
    return true;
  }

  async revoke(abilityId, permission) {
    await this.load();
    if (permission) this.grants.get(abilityId)?.delete(permission);
    else this.grants.delete(abilityId);
    await this.persist();
    await this.eventBus?.publish("permission.revoked", { abilityId, permission }, { source: "core" });
  }
}

