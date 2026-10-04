import { ErrorCode, PabError } from "./errors.js";

/**
 * Command bus for user and ability actions. Commands are explicit, namespaced
 * and permission-checked before their handler runs.
 */
export class CommandBus {
  /** @param {{eventBus?:import('./event-bus.js').EventBus,permissionManager?:import('./permissions.js').PermissionManager}} [options] */
  constructor(options = {}) {
    this.eventBus = options.eventBus;
    this.permissionManager = options.permissionManager;
    /** @type {Map<string,{id:string,title:string,description:string,handler:Function,abilityId?:string,permissions:string[],metadata:object}>} */
    this.commands = new Map();
  }

  /** @param {{id:string,title?:string,description?:string,handler:Function,abilityId?:string,permissions?:string[],metadata?:object}} definition */
  register(definition) {
    if (!definition || typeof definition.id !== "string" || !definition.id.trim()) throw new TypeError("Command id is required");
    if (typeof definition.handler !== "function") throw new TypeError(`Command ${definition.id} handler must be a function`);
    if (this.commands.has(definition.id)) throw new PabError(ErrorCode.COMMAND_ALREADY_REGISTERED, `Command already registered: ${definition.id}`);
    const command = {
      id: definition.id,
      title: definition.title ?? definition.id,
      description: definition.description ?? "",
      handler: definition.handler,
      abilityId: definition.abilityId,
      permissions: [...new Set(definition.permissions ?? [])],
      metadata: { ...(definition.metadata ?? {}) },
    };
    this.commands.set(command.id, command);
    return () => this.unregister(command.id);
  }

  unregister(id) { return this.commands.delete(id); }
  get(id) { return this.commands.get(id); }
  list(filter = {}) {
    return [...this.commands.values()]
      .filter((command) => !filter.abilityId || command.abilityId === filter.abilityId)
      .map(({ handler, ...publicCommand }) => ({ ...publicCommand }));
  }

  /** @param {string} id @param {unknown} [input] @param {{source?:string,signal?:AbortSignal,abilityId?:string}} [options] */
  async execute(id, input, options = {}) {
    const command = this.commands.get(id);
    if (!command) throw new PabError(ErrorCode.COMMAND_NOT_FOUND, `Command not found: ${id}`, { id });
    if (command.abilityId && options.abilityId && command.abilityId !== options.abilityId) {
      throw new PabError(ErrorCode.PERMISSION_DENIED, `Command belongs to ${command.abilityId}`, { id });
    }
    for (const permission of command.permissions) {
      await this.permissionManager?.assert(command.abilityId ?? options.abilityId ?? "core", permission);
    }
    const startedAt = Date.now();
    const result = await command.handler(input, { command, source: options.source ?? "core", signal: options.signal });
    await this.eventBus?.publish("command.executed", { id, input, result, durationMs: Date.now() - startedAt }, { source: command.abilityId ?? "core" });
    return result;
  }
}

