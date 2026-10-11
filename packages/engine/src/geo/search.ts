// Offline place search over the bundled Natural Earth populated places (public domain).
// Pure: no engine imports (no errors.ts, no api.ts). Phase 03 wires this into `engine.geo.search`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../resources.ts';

/** `data/places.json`, built by `data/build-places.mjs` from ne_10m_populated_places_simple. */
export interface PlacesFile {
  format: 'vox-places/1';
  source: string;
  columns: string[];
  rows: (string | number)[][];
}

/** A `geo` slot only needs `{ name, lat, lon }`; the rest helps to pick between homonyms. */
export interface Place {
  name: string;
  country: string;
  iso2: string;
  admin1: string;
  lat: number;
  lon: number;
  population: number;
  capital: boolean;
}

interface Entry {
  place: Place;
  names: string[]; // normalised: primary name first, then aliases
  qualifiers: string[]; // normalised country, iso2, admin1
}

export interface PlaceIndex {
  entries: Entry[];
}

export interface SearchOptions {
  limit?: number;
}

export const DEFAULT_LIMIT = 10;

/** Lowercase, strip diacritics, turn punctuation into single spaces. */
export function normalise(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function createPlaceIndex(file: PlacesFile): PlaceIndex {
  const col = (name: string): number => {
    const i = file.columns.indexOf(name);
    if (i < 0) throw new Error(`places file has no column "${name}"`);
    return i;
  };
  const c = {
    name: col('name'),
    aliases: col('aliases'),
    country: col('country'),
    iso2: col('iso2'),
    admin1: col('admin1'),
    lat: col('lat'),
    lon: col('lon'),
    population: col('population'),
    capital: col('capital'),
  };
  const entries: Entry[] = file.rows.map((r) => {
    const place: Place = {
      name: String(r[c.name]),
      country: String(r[c.country]),
      iso2: String(r[c.iso2]),
      admin1: String(r[c.admin1]),
      lat: Number(r[c.lat]),
      lon: Number(r[c.lon]),
      population: Number(r[c.population]),
      capital: Number(r[c.capital]) === 1,
    };
    const aliases = String(r[c.aliases])
      .split('|')
      .filter((a) => a !== '');
    const names = [place.name, ...aliases].map(normalise).filter((n) => n !== '');
    const qualifiers = [place.country, place.iso2, place.admin1].map(normalise);
    return { place, names, qualifiers };
  });
  return { entries };
}

// Match quality of one normalised name against the normalised query (0 = no match).
function nameScore(name: string, q: string): number {
  if (name === q) return 1000;
  if (name.startsWith(q)) return 600;
  if (name.split(' ').some((w) => w.startsWith(q))) return 300;
  if (name.includes(` ${q}`)) return 300;
  return 0;
}

/**
 * Search places by name. `"lisbon"`, `"São Paulo"`, `"bombay"` and the prefix `"new y"` work;
 * `"paris, us"` or `"lisbon, portugal"` narrows by country, ISO code or first-level region.
 * Ranking: exact name, then prefix, then word prefix; primary name beats an alias; bigger and
 * capital places first. Returns at most `limit` places (default 10).
 */
export function searchPlaces(index: PlaceIndex, query: string, opts: SearchOptions = {}): Place[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const [namePart = '', ...rest] = query.split(',');
  const q = normalise(namePart);
  const qualifier = normalise(rest.join(' '));
  if (q === '' || limit <= 0) return [];

  const scored: { place: Place; score: number }[] = [];
  for (const e of index.entries) {
    if (
      qualifier !== '' &&
      !e.qualifiers.some((x) => x !== '' && (x === qualifier || x.startsWith(qualifier)))
    ) {
      continue;
    }
    let best = 0;
    for (let i = 0; i < e.names.length; i++) {
      const s = nameScore(e.names[i]!, q);
      if (s > 0) best = Math.max(best, i === 0 ? s : s - 50);
    }
    if (best === 0) continue;
    const { population, capital } = e.place;
    scored.push({
      place: e.place,
      score: best + Math.log10(population + 1) * 10 + (capital ? 15 : 0),
    });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Number(a.place.name > b.place.name) - Number(a.place.name < b.place.name) ||
      a.place.lat - b.place.lat,
  );
  return scored.slice(0, limit).map((s) => s.place);
}

let defaultIndex: { file: string; index: PlaceIndex } | undefined;

/** Search the bundled `data/places.json` (loaded once, on first use). */
export function search(query: string, opts: SearchOptions = {}): Place[] {
  const file = join(dataDir(), 'places.json');
  if (defaultIndex?.file !== file) {
    defaultIndex = {
      file,
      index: createPlaceIndex(JSON.parse(readFileSync(file, 'utf8')) as PlacesFile),
    };
  }
  return searchPlaces(defaultIndex.index, query, opts);
}
