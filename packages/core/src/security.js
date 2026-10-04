/**
 * Portable package integrity helpers. Hosts may replace these with platform
 * crypto implementations; Web Crypto is available on modern Windows and
 * Android WebViews.
 */
export async function sha256Hex(data) {
  const bytes = await toBytes(data);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  // Node 18+ exposes Web Crypto globally; this branch is for hosts that
  // inject a synchronous hash function without exposing node built-ins.
  if (typeof globalThis.__pabSha256 === "function") return globalThis.__pabSha256(bytes);
  throw new Error("No SHA-256 implementation available in this host");
}

export async function verifySha256(data, expected) {
  const actual = (await sha256Hex(data)).toLowerCase();
  return actual === String(expected).toLowerCase().replace(/^sha256:/, "");
}

async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data && typeof data.arrayBuffer === "function") return data.arrayBuffer();
  throw new TypeError("Hash input must be text, bytes, ArrayBuffer or Blob-like");
}
