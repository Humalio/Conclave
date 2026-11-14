/** The hub version reported in MCP initialisation and recorded on feedback reports. Keep in step with package.json. */
export const HUB_VERSION = '1.0.0';

/** Compare dotted numeric versions ("0.2.0", "v1.4"); missing parts count as 0. Returns null if either has no digits. */
export function compareVersions(a: string, b: string): number | null {
  const parts = (v: string) => (v.match(/\d+/g) ?? []).map(Number);
  const x = parts(a), y = parts(b);
  if (!x.length || !y.length) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
