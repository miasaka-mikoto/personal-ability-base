import { ErrorCode, PabError } from "./errors.js";

const VERSION_RE = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/**
 * Parse a semantic version. Missing minor/patch components are accepted for
 * range expressions, but `parseVersion` normalises them to zero.
 * @param {string|number} input
 * @returns {{major:number,minor:number,patch:number,prerelease:string[],build:string[],raw:string}}
 */
export function parseVersion(input) {
  const raw = String(input ?? "").trim().replace(/^v/i, "");
  const match = VERSION_RE.exec(raw);
  if (!match) {
    throw new PabError(ErrorCode.INVALID_VERSION, `Invalid semantic version: ${input}`, { input });
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease: match[4] ? match[4].split(".") : [],
    build: match[5] ? match[5].split(".") : [],
    raw,
  };
}

/** @param {ReturnType<typeof parseVersion>} a @param {ReturnType<typeof parseVersion>} b */
export function compareVersions(a, b) {
  const left = typeof a === "string" ? parseVersion(a) : a;
  const right = typeof b === "string" ? parseVersion(b) : b;
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  const max = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < max; i += 1) {
    const x = left.prerelease[i];
    const y = right.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y) ? 1 : -1;
    if (xn) return -1;
    if (yn) return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

/** @param {string|object} version */
export function normaliseVersion(version) {
  const parsed = typeof version === "string" ? parseVersion(version) : version;
  return `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease?.length ? `-${parsed.prerelease.join(".")}` : ""}`;
}

function partialVersion(token) {
  const clean = String(token).trim().replace(/^v/i, "");
  if (!clean || clean === "*" || clean.toLowerCase() === "x") return { parts: [], wildcard: true };
  const [base, prerelease] = clean.split("-", 2);
  const parts = base.split(".");
  if (parts.some((part) => part === "" || /^[xX*]$/.test(part))) {
    const concrete = parts.filter((part) => !/^[xX*]$/.test(part));
    return { parts: concrete.map(Number), wildcard: true, prerelease };
  }
  if (!parts.every((part) => /^\d+$/.test(part)) || parts.length > 3) {
    throw new PabError(ErrorCode.INVALID_VERSION, `Invalid version range token: ${token}`, { token });
  }
  return { parts: parts.map(Number), wildcard: parts.length < 3, prerelease };
}

function lowerBoundFor(parts) {
  return `${parts[0] ?? 0}.${parts[1] ?? 0}.${parts[2] ?? 0}`;
}

function upperBoundForWildcard(parts) {
  if (!parts.length) return null;
  if (parts.length === 1) return `${parts[0] + 1}.0.0`;
  if (parts.length === 2) return `${parts[0]}.${parts[1] + 1}.0`;
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

/** Evaluate one comparator against a version. */
function testComparator(version, comparator) {
  const value = parseVersion(version);
  const token = comparator.trim();
  if (!token || token === "*" || token.toLowerCase() === "x") return true;
  if (token.startsWith("^")) {
    const base = parseVersion(lowerBoundFor(partialVersion(token.slice(1)).parts));
    let upper;
    if (base.major > 0) upper = `${base.major + 1}.0.0`;
    else if (base.minor > 0) upper = `0.${base.minor + 1}.0`;
    else upper = `0.0.${base.patch + 1}`;
    return compareVersions(value, base) >= 0 && compareVersions(value, upper) < 0;
  }
  if (token.startsWith("~")) {
    const partial = partialVersion(token.slice(1));
    const base = parseVersion(lowerBoundFor(partial.parts));
    const upper = partial.parts.length <= 1 ? `${base.major + 1}.0.0` : `${base.major}.${base.minor + 1}.0`;
    return compareVersions(value, base) >= 0 && compareVersions(value, upper) < 0;
  }
  const match = /^(>=|<=|>|<|=)?\s*(.*)$/.exec(token);
  const operator = match?.[1] ?? "=";
  const rawTarget = match?.[2] ?? token;
  const partial = partialVersion(rawTarget);
  if (partial.wildcard) {
    if (!partial.parts.length) return true;
    const lower = parseVersion(lowerBoundFor(partial.parts));
    const upperRaw = upperBoundForWildcard(partial.parts);
    if (!upperRaw) return true;
    const upper = parseVersion(upperRaw);
    if (operator === ">=") return compareVersions(value, lower) >= 0;
    if (operator === ">") return compareVersions(value, upper) >= 0;
    if (operator === "<=") return compareVersions(value, upper) < 0;
    if (operator === "<") return compareVersions(value, lower) < 0;
    return compareVersions(value, lower) >= 0 && compareVersions(value, upper) < 0;
  }
  const target = parseVersion(rawTarget);
  const comparison = compareVersions(value, target);
  return operator === ">=" ? comparison >= 0
    : operator === ">" ? comparison > 0
      : operator === "<=" ? comparison <= 0
        : operator === "<" ? comparison < 0
          : comparison === 0;
}

/**
 * Determine whether a version satisfies a small, npm-compatible subset of
 * semver ranges. Supports `^`, `~`, comparison chains, wildcards and `||`.
 */
export function satisfies(version, range = "*") {
  const expression = String(range).trim();
  if (!expression || expression === "*") return true;
  return expression.split("||").some((alternative) => {
    const trimmed = alternative.trim();
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
    if (hyphen) {
      return testComparator(version, `>=${hyphen[1]}`) && testComparator(version, `<=${hyphen[2]}`);
    }
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    return tokens.every((token) => testComparator(version, token));
  });
}

/** @param {string} range @returns {string} */
export function canonicalRange(range) {
  return String(range ?? "*").trim() || "*";
}
