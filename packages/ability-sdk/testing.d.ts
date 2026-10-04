import type { RuntimeAdapter, Permission } from "./index.js";
export interface TestRuntime extends RuntimeAdapter {
  events: Map<string, Set<Function>>;
  notifications: unknown[];
  pages: unknown[];
  commands: Map<string, unknown>;
  requests: Map<string, unknown>;
  memories: unknown[];
  registerCommand(definition: Record<string, unknown>): () => void;
  registerRequest(definition: Record<string, unknown>): () => void;
  executeCommand(id: string, input?: unknown): Promise<unknown>;
}
export function createTestRuntime(options?: { version?: string; grantedPermissions?: Permission[]; logger?: (entry: unknown) => void }): TestRuntime;
