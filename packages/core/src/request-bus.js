import { ErrorCode, PabError } from "./errors.js";

/**
 * Explicit request/response channel for Ability-to-Ability and host calls.
 * A request is addressed to a registered capability; it is never an
 * implicit database lookup. Handlers may declare permissions which are
 * checked by Core immediately before invocation.
 */
export class RequestBus {
  /** @param {{eventBus?: any, permissionManager?: any, idFactory?: () => string}} [options] */
  constructor(options = {}) {
    this.eventBus = options.eventBus;
    this.permissionManager = options.permissionManager;
    this.idFactory = options.idFactory ?? (() => globalThis.crypto?.randomUUID?.() ?? `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`);
    /** @type {Map<string, {id:string,title:string,description:string,handler:Function,abilityId?:string,permissions:string[],metadata:object}>} */
    this.handlers = new Map();
  }

  /** @param {{id:string,title?:string,description?:string,handler:Function,abilityId?:string,permissions?:string[],metadata?:object}} definition */
  register(definition) {
    if (!definition || typeof definition.id !== "string" || !definition.id.trim()) throw new TypeError("Request id is required");
    if (typeof definition.handler !== "function") throw new TypeError(`Request ${definition.id} handler must be a function`);
    if (this.handlers.has(definition.id)) throw new PabError(ErrorCode.REQUEST_ALREADY_REGISTERED, `Request already registered: ${definition.id}`, { id: definition.id });
    const request = {
      id: definition.id,
      title: definition.title ?? definition.id,
      description: definition.description ?? "",
      handler: definition.handler,
      abilityId: definition.abilityId,
      permissions: [...new Set(definition.permissions ?? [])],
      metadata: { ...(definition.metadata ?? {}) },
    };
    this.handlers.set(request.id, request);
    return () => this.unregister(request.id);
  }

  unregister(id) { return this.handlers.delete(id); }
  has(id) { return this.handlers.has(id); }
  get(id) { return this.handlers.get(id); }
  list(filter = {}) {
    return [...this.handlers.values()]
      .filter((request) => !filter.abilityId || request.abilityId === filter.abilityId)
      .map(({ handler, ...publicRequest }) => ({ ...publicRequest }));
  }

  /** @param {string} id @param {unknown} [payload] @param {{source?:string,abilityId?:string,correlationId?:string,signal?:AbortSignal}} [options] */
  async request(id, payload, options = {}) {
    const request = this.handlers.get(id);
    if (!request) throw new PabError(ErrorCode.REQUEST_NOT_FOUND, `Request not found: ${id}`, { id });
    const source = options.source ?? options.abilityId ?? "core";
    const requestId = options.correlationId ?? this.idFactory();
    for (const permission of request.permissions) {
      await this.permissionManager?.assert(request.abilityId ?? source, permission, { request: id, source });
    }
    await this.eventBus?.publish("request.started", { requestId, id, payload }, { source, correlationId: requestId });
    try {
      const response = await request.handler(payload, { requestId, request, source, signal: options.signal });
      await this.eventBus?.publish("request.completed", { requestId, id, response }, { source: request.abilityId ?? source, correlationId: requestId });
      return response;
    } catch (error) {
      await this.eventBus?.publish("request.failed", { requestId, id, error: String(error) }, { source: request.abilityId ?? source, correlationId: requestId });
      throw error;
    }
  }
}
