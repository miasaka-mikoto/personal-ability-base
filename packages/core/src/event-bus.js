/**
 * Small async event bus shared by Core and abilities. Events are namespaced
 * (`capture.created`) and handlers can subscribe to exact names, `*` segments,
 * or `**` suffixes. A handler never receives a mutable internal envelope.
 */
export class EventBus {
  /** @param {{clock?:()=>number,idFactory?:()=>string,logger?:{error?:Function}}} [options] */
  constructor(options = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => globalThis.crypto?.randomUUID?.() ?? `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`);
    this.logger = options.logger ?? console;
    /** @type {Map<number,{pattern:string,handler:Function,once:boolean,priority:number}>} */
    this.subscriptions = new Map();
    this.nextSubscriptionId = 1;
  }

  /** @param {string} pattern @param {(event:object)=>unknown|Promise<unknown>} handler @param {{once?:boolean,priority?:number}} [options] */
  subscribe(pattern, handler, options = {}) {
    if (typeof pattern !== "string" || !pattern.trim()) throw new TypeError("Event pattern is required");
    if (typeof handler !== "function") throw new TypeError("Event handler must be a function");
    const id = this.nextSubscriptionId++;
    this.subscriptions.set(id, { pattern: pattern.trim(), handler, once: Boolean(options.once), priority: options.priority ?? 0 });
    return () => this.subscriptions.delete(id);
  }

  /** Alias used by SDK ergonomics. */
  on(pattern, handler, options) { return this.subscribe(pattern, handler, options); }

  /** @param {string} type @param {unknown} [payload] @param {{source?:string,correlationId?:string,metadata?:Record<string,unknown>}} [options] */
  async publish(type, payload, options = {}) {
    if (typeof type !== "string" || !type.trim()) throw new TypeError("Event type is required");
    const event = Object.freeze({
      id: this.idFactory(),
      type: type.trim(),
      // SDK/native adapters use the more descriptive aliases; retaining both
      // keeps the wire envelope stable across host implementations.
      event: type.trim(),
      timestamp: this.clock(),
      source: options.source ?? "core",
      sourceAbilityId: options.source ?? "core",
      correlationId: options.correlationId,
      payload,
      metadata: Object.freeze({ ...(options.metadata ?? {}) }),
    });
    const matching = [...this.subscriptions.entries()]
      .filter(([, subscription]) => matches(subscription.pattern, event.type))
      .sort((a, b) => b[1].priority - a[1].priority);
    const results = [];
    const errors = [];
    for (const [id, subscription] of matching) {
      if (subscription.once) this.subscriptions.delete(id);
      try {
        results.push(await subscription.handler(event));
      } catch (error) {
        errors.push({ error, subscriptionId: id });
        this.logger?.error?.("PAB event handler failed", { event, error });
      }
    }
    return { event, results, errors };
  }

  /** Publish without waiting for handlers; useful for UI notifications. */
  emit(type, payload, options) {
    return this.publish(type, payload, options);
  }

  /** Wait for the next matching event or reject after timeout. */
  waitFor(pattern, { timeoutMs = 30_000, signal } = {}) {
    return new Promise((resolve, reject) => {
      let timer;
      const unsubscribe = this.subscribe(pattern, (event) => {
        clearTimeout(timer);
        resolve(event);
      }, { once: true });
      const abort = () => {
        clearTimeout(timer);
        unsubscribe();
        reject(signal?.reason ?? new Error("Event wait aborted"));
      };
      if (signal) {
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
      }
      timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for event ${pattern}`));
      }, timeoutMs);
    });
  }

  clear() { this.subscriptions.clear(); }
  get size() { return this.subscriptions.size; }
}

function matches(pattern, type) {
  if (pattern === "**" || pattern === type) return true;
  const patternParts = pattern.split(".");
  const typeParts = type.split(".");
  if (patternParts.at(-1) === "**") {
    const prefix = patternParts.slice(0, -1);
    return typeParts.length >= prefix.length && prefix.every((part, i) => part === "*" || part === typeParts[i]);
  }
  if (patternParts.length !== typeParts.length) return false;
  return patternParts.every((part, i) => part === "*" || part === typeParts[i]);
}
