// Minimal semver precedence (https://semver.org/#spec-item-11), enough for release tags.

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  pre: Array<string | number>;
}

const RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseVersion(text: string): ParsedVersion | undefined {
  const m = RE.exec(text);
  if (m === null) return undefined;
  const pre = (m[4] ?? '')
    .split('.')
    .filter((p) => p !== '')
    .map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

function comparePre(a: Array<string | number>, b: Array<string | number>): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // a release outranks its prereleases
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    if (typeof x === 'number') return -1; // numeric identifiers sort before alphanumeric
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === undefined) throw new Error(`not a version: ${JSON.stringify(a)}`);
  if (pb === undefined) throw new Error(`not a version: ${JSON.stringify(b)}`);
  return (
    Math.sign(pa.major - pb.major) ||
    Math.sign(pa.minor - pb.minor) ||
    Math.sign(pa.patch - pb.patch) ||
    comparePre(pa.pre, pb.pre)
  );
}
