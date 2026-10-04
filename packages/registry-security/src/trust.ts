import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import type { AbilityRegistryEntry, PackageVerificationResult, TrustLevel, TrustPolicyOptions } from "./types.ts";
import { PabRegistryError } from "./errors.ts";

const DEFAULT_ALLOWED: TrustLevel[] = ["official", "verified"];
const DEFAULT_SIGNED: TrustLevel[] = ["official", "verified"];

function decodeSignature(value: string): Buffer {
  // Accept URL-safe detached signatures as well as ordinary base64.
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Buffer.from(normalized, "base64");
}

function toPublicKey(value: string | Uint8Array): ReturnType<typeof createPublicKey> {
  if (typeof value !== "string") {
    const bytes = Buffer.from(value);
    // Accept either SubjectPublicKeyInfo DER or a raw 32-byte Ed25519 key.
    const der = bytes.length === 32 ? Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes]) : bytes;
    return createPublicKey({ key: der, format: "der", type: "spki" });
  }
  if (value.includes("BEGIN PUBLIC KEY")) return createPublicKey(value);
  // Registry may store a base64 DER SubjectPublicKeyInfo.
  const bytes = Buffer.from(value, "base64");
  const der = bytes.length === 32 ? Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes]) : bytes;
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class TrustPolicy {
  readonly allowedLevels: ReadonlySet<TrustLevel>;
  readonly requireSignatureFor: ReadonlySet<TrustLevel>;
  readonly trustedKeys: ReadonlyMap<string, string | Uint8Array>;
  readonly allowUnsignedLocal: boolean;

  constructor(options: TrustPolicyOptions = {}) {
    this.allowedLevels = new Set(options.allowedLevels ?? DEFAULT_ALLOWED);
    const required = new Set(options.requireSignatureFor ?? DEFAULT_SIGNED);
    if (options.allowUnsignedLocal === false) required.add("local");
    this.requireSignatureFor = required;
    this.trustedKeys = new Map(Object.entries(options.trustedKeys ?? {}));
    this.allowUnsignedLocal = options.allowUnsignedLocal ?? true;
  }

  isAllowed(level: TrustLevel, explicitOverride = false): boolean {
    if (this.allowedLevels.has(level)) return true;
    if (explicitOverride && (level === "community" || level === "local" || level === "developer")) return true;
    return false;
  }

  requiresSignature(level: TrustLevel): boolean {
    // The default required set excludes local packages. If a host explicitly
    // adds `local` to requireSignatureFor, that explicit policy must win.
    return this.requireSignatureFor.has(level);
  }

  verify(entry: AbilityRegistryEntry, bytes: Uint8Array, explicitOverride = false): PackageVerificationResult {
    const actualHash = sha256Hex(bytes);
    const hashValid = actualHash.toLowerCase() === entry.sha256.toLowerCase();
    const signatureRequired = this.requiresSignature(entry.trust);
    let signatureValid = false;
    const warnings: string[] = [];
    if (entry.signature) {
      const trustedKey = this.trustedKeys.get(entry.signature.keyId);
      if (!trustedKey) {
        warnings.push(`No trusted key found for key ID ${entry.signature.keyId}`);
      } else {
        try {
          const payload = entry.signature.signedPayload === "sha256"
            ? Buffer.from(actualHash, "utf8")
            : Buffer.from(bytes);
          signatureValid = verifySignature(null, payload, toPublicKey(trustedKey), decodeSignature(entry.signature.value));
        } catch (error) {
          warnings.push(`Signature could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } else if (signatureRequired) {
      warnings.push("A detached signature is required for this trust level");
    }
    const trustAllowed = this.isAllowed(entry.trust, explicitOverride);
    return { sha256: actualHash, hashValid, signatureRequired, signatureValid, trustAllowed, warnings };
  }

  assertAllowed(entry: AbilityRegistryEntry, bytes: Uint8Array, explicitOverride = false): PackageVerificationResult {
    const result = this.verify(entry, bytes, explicitOverride);
    if (!result.trustAllowed) {
      throw new PabRegistryError("TRUST_BLOCKED", `Source trust level is not allowed: ${entry.trust}`, { id: entry.id, trust: entry.trust });
    }
    if (!result.hashValid) {
      throw new PabRegistryError("HASH_MISMATCH", `SHA-256 verification failed for ${entry.id}@${entry.version}`, { expected: entry.sha256, actual: result.sha256 });
    }
    if (result.signatureRequired && !result.signatureValid) {
      throw new PabRegistryError("SIGNATURE_INVALID", `Signature verification failed for ${entry.id}@${entry.version}`, { keyId: entry.signature?.keyId });
    }
    return result;
  }
}

export function assertPermissions(requested: string[] | undefined, approved: string[] | undefined): void {
  if (!requested?.length) return;
  const approvedSet = new Set(approved ?? []);
  const denied = requested.filter((permission) => !approvedSet.has(permission));
  if (denied.length) {
    throw new PabRegistryError("PERMISSION_DENIED", `Permission approval required: ${denied.join(", ")}`, { requested, denied });
  }
}
