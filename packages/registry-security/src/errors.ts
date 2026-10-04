export type RegistryErrorCode =
  | "INVALID_REGISTRY"
  | "REGISTRY_UNAVAILABLE"
  | "INVALID_MANIFEST"
  | "INVALID_ID"
  | "INVALID_VERSION"
  | "PLATFORM_UNSUPPORTED"
  | "CORE_VERSION_UNSUPPORTED"
  | "TRUST_BLOCKED"
  | "SIGNATURE_REQUIRED"
  | "SIGNATURE_INVALID"
  | "HASH_MISMATCH"
  | "DOWNLOAD_FAILED"
  | "PACKAGE_TOO_LARGE"
  | "ARCHIVE_INVALID"
  | "PATH_TRAVERSAL"
  | "DEPENDENCY_MISSING"
  | "DEPENDENCY_CONFLICT"
  | "DEPENDENCY_CYCLE"
  | "PERMISSION_DENIED"
  | "MIGRATION_FAILED"
  | "INSTALL_FAILED"
  | "NOT_INSTALLED"
  | "VERSION_NOT_INSTALLED"
  | "ROLLBACK_FAILED"
  | "INVALID_UPDATE_POLICY";

export class PabRegistryError extends Error {
  readonly code: RegistryErrorCode;
  readonly details: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(code: RegistryErrorCode, message: string, details: Record<string, unknown> = {}, cause?: unknown) {
    super(message);
    this.name = "PabRegistryError";
    this.code = code;
    this.details = details;
    this.cause = cause;
  }
}

export function asRegistryError(error: unknown, code: RegistryErrorCode, message: string, details: Record<string, unknown> = {}): PabRegistryError {
  if (error instanceof PabRegistryError) return error;
  return new PabRegistryError(code, message, details, error);
}
