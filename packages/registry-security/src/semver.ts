/** A deliberately small, deterministic SemVer implementation. */

export class SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string[];
  readonly raw: string;

  constructor(version: string) {
    this.raw = version;
    const value = version.trim().replace(/^v/, "");
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
    if (!match) throw new Error(`Invalid semantic version: ${version}`);
    this.major = Number(match[1]);
    this.minor = Number(match[2]);
    this.patch = Number(match[3]);
    this.prerelease = match[4] ? match[4].split(".") : [];
  }

  toString(): string {
    const base = `${this.major}.${this.minor}.${this.patch}`;
    return this.prerelease.length ? `${base}-${this.prerelease.join(".")}` : base;
  }
}

function compareIdentifiers(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersions(a: string | SemVer, b: string | SemVer): number {
  const av = typeof a === "string" ? new SemVer(a) : a;
  const bv = typeof b === "string" ? new SemVer(b) : b;
  if (av.major !== bv.major) return av.major - bv.major;
  if (av.minor !== bv.minor) return av.minor - bv.minor;
  if (av.patch !== bv.patch) return av.patch - bv.patch;
  if (!av.prerelease.length && !bv.prerelease.length) return 0;
  if (!av.prerelease.length) return 1;
  if (!bv.prerelease.length) return -1;
  for (let i = 0; i < Math.max(av.prerelease.length, bv.prerelease.length); i += 1) {
    if (av.prerelease[i] === undefined) return -1;
    if (bv.prerelease[i] === undefined) return 1;
    const c = compareIdentifiers(av.prerelease[i], bv.prerelease[i]);
    if (c) return c;
  }
  return 0;
}

export function validVersion(version: string): boolean {
  try {
    new SemVer(version);
    return true;
  } catch {
    return false;
  }
}

type Comparator = { op: ">" | ">=" | "<" | "<=" | "="; version: SemVer };

function comparatorSatisfied(version: SemVer, comparator: Comparator): boolean {
  const c = compareVersions(version, comparator.version);
  switch (comparator.op) {
    case ">": return c > 0;
    case ">=": return c >= 0;
    case "<": return c < 0;
    case "<=": return c <= 0;
    default: return c === 0;
  }
}

function parsePartial(part: string): { major?: number; minor?: number; patch?: number; prerelease?: string } {
  const value = part.replace(/^v/, "").split("+")[0];
  const [base, prerelease] = value.split("-");
  const bits = base.split(".");
  const parse = (v: string | undefined): number | undefined => {
    if (v === undefined || v === "" || v.toLowerCase() === "x" || v === "*") return undefined;
    if (!/^\d+$/.test(v)) throw new Error(`Invalid version component: ${v}`);
    return Number(v);
  };
  if (bits.length > 3) throw new Error(`Invalid partial version: ${part}`);
  return { major: parse(bits[0]), minor: parse(bits[1]), patch: parse(bits[2]), prerelease };
}

function expandToken(token: string): Comparator[] {
  token = token.trim();
  if (!token || token === "*" || token.toLowerCase() === "x" || token.toLowerCase() === "latest") return [];
  const opMatch = /^(<=|>=|<|>|=|\^|~)?\s*(.*)$/.exec(token);
  if (!opMatch) throw new Error(`Invalid range token: ${token}`);
  const op = opMatch[1] ?? "=";
  if (!opMatch[2].trim()) throw new Error(`Invalid empty semantic-version range token: ${token}`);
  const partial = parsePartial(opMatch[2]);
  if (partial.major === undefined) {
    if (op !== "=") throw new Error(`Invalid semantic-version range token: ${token}`);
    return [];
  }
  const make = (major: number, minor: number, patch: number): SemVer =>
    new SemVer(`${major}.${minor}.${patch}${partial.prerelease ? `-${partial.prerelease}` : ""}`);
  const major = partial.major;
  const minor = partial.minor ?? 0;
  const patch = partial.patch ?? 0;
  if (op === "^") {
    let upper: SemVer;
    if (major > 0) upper = make(major + 1, 0, 0);
    else if (partial.minor === undefined || minor > 0) upper = make(1, 0, 0);
    else if (partial.patch === undefined || patch > 0) upper = make(0, minor + 1, 0);
    else upper = make(0, 0, patch + 1);
    return [{ op: ">=", version: make(major, minor, patch) }, { op: "<", version: upper }];
  }
  if (op === "~") {
    const upper = partial.minor === undefined ? make(major + 1, 0, 0) : make(major, minor + 1, 0);
    return [{ op: ">=", version: make(major, minor, patch) }, { op: "<", version: upper }];
  }
  if (op === "=" && (partial.minor === undefined || partial.patch === undefined)) {
    if (partial.minor === undefined) return [{ op: ">=", version: make(major, 0, 0) }, { op: "<", version: make(major + 1, 0, 0) }];
    return [{ op: ">=", version: make(major, minor, 0) }, { op: "<", version: make(major, minor + 1, 0) }];
  }
  return [{ op: op as Comparator["op"], version: make(major, minor, patch) }];
}

function parseRangeBranch(branch: string): Comparator[] {
  const trimmed = branch.trim();
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
  if (hyphen) {
    const lo = parsePartial(hyphen[1]);
    const hi = parsePartial(hyphen[2]);
    if (lo.major === undefined || hi.major === undefined) return [];
    const low = new SemVer(`${lo.major}.${lo.minor ?? 0}.${lo.patch ?? 0}`);
    const high = new SemVer(`${hi.major}.${hi.minor ?? 0}.${hi.patch ?? 0}`);
    return [{ op: ">=", version: low }, { op: "<=", version: high }];
  }
  return trimmed.split(/\s+/).flatMap(expandToken);
}

/** Supports exact versions, wildcards, comparators, ^, ~ and OR (||). */
export function satisfies(version: string | SemVer, range: string | undefined): boolean {
  if (!range || range.trim() === "" || range.trim() === "*" || range.trim().toLowerCase() === "latest") return true;
  const candidate = typeof version === "string" ? new SemVer(version) : version;
  // SemVer ranges normally exclude prereleases unless explicitly requested.
  const branches = range.split("||");
  if (branches.some((branch) => !branch.trim())) throw new Error(`Invalid empty semantic-version range branch: ${range}`);
  return branches.some((branch) => {
    const comparators = parseRangeBranch(branch);
    if (!comparators.length) return true;
    if (candidate.prerelease.length && !comparators.some((c) => c.version.prerelease.length)) return false;
    return comparators.every((comparator) => comparatorSatisfied(candidate, comparator));
  });
}

export function maxSatisfying(versions: string[], range = "*"): string | undefined {
  return versions
    .filter((version) => validVersion(version) && satisfies(version, range))
    .sort((a, b) => compareVersions(b, a))[0];
}
