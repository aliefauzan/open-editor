// Builds data/places.json from Natural Earth ne_10m_populated_places_simple.dbf (public domain).
//   node packages/engine/data/build-places.mjs <path/to/ne_10m_populated_places_simple.dbf>
// Source: https://naciscdn.org/naturalearth/10m/cultural/ne_10m_populated_places_simple.zip (v5.1.2)
// Output is deterministic: rows sorted by population (desc), then name, then lat.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , dbfPath] = process.argv;
if (!dbfPath) {
  console.error('usage: node build-places.mjs <ne_10m_populated_places_simple.dbf>');
  process.exit(2);
}

const b = readFileSync(dbfPath);
const count = b.readUInt32LE(4);
const headerLen = b.readUInt16LE(8);
const recLen = b.readUInt16LE(10);
const fields = [];
let off = 1; // first byte of a record is the deletion flag
for (let p = 32; b[p] !== 0x0d; p += 32) {
  const name = b.toString('latin1', p, p + 11).replace(/\0.*$/, '');
  const len = b[p + 16];
  fields.push({ name, len, off });
  off += len;
}

const rows = [];
for (let i = 0; i < count; i++) {
  const base = headerLen + i * recLen;
  if (b[base] === 0x2a) continue; // deleted
  const r = {};
  for (const f of fields) r[f.name] = b.toString('utf8', base + f.off, base + f.off + f.len).trim();
  const aliases = [...new Set([r.namepar, r.namealt, r.nameascii].filter((a) => a && a !== r.name))];
  rows.push([
    r.name,
    aliases.join('|'),
    r.adm0name,
    r.iso_a2 === '-99' ? '' : r.iso_a2,
    r.adm1name,
    Math.round(Number(r.latitude) * 1e4) / 1e4,
    Math.round(Number(r.longitude) * 1e4) / 1e4,
    Number(r.pop_max),
    r.adm0cap === '1' ? 1 : 0,
  ]);
}
rows.sort((x, y) => y[7] - x[7] || x[0].localeCompare(y[0]) || x[5] - y[5]);

const out = {
  format: 'vox-places/1',
  source:
    'Natural Earth ne_10m_populated_places_simple v5.1.2, public domain, https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-populated-places/',
  columns: ['name', 'aliases', 'country', 'iso2', 'admin1', 'lat', 'lon', 'population', 'capital'],
  rows,
};
const url = new URL('./places.json', import.meta.url);
writeFileSync(url, JSON.stringify(out) + '\n');
console.log(`wrote ${rows.length} places to ${url.pathname}`);
