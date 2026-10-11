import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  createPlaceIndex,
  search as searchDefault,
  searchPlaces,
  type PlacesFile,
} from '../../src/geo/search.ts';

const dataUrl = new URL('../../data/places.json', import.meta.url);
const file = JSON.parse(readFileSync(dataUrl, 'utf8')) as PlacesFile;
const index = createPlaceIndex(file);
const search = (q: string, limit?: number) =>
  searchPlaces(index, q, limit === undefined ? {} : { limit });

describe('geo.search (offline Natural Earth populated places)', () => {
  test('lisbon is found with name, lat and lon', () => {
    const [first] = search('lisbon');
    expect(first).toBeDefined();
    expect(first!.name).toBe('Lisbon');
    expect(first!.country).toBe('Portugal');
    expect(first!.lat).toBeCloseTo(38.72, 1);
    expect(first!.lon).toBeCloseTo(-9.15, 1);
  });

  test('case, diacritics and punctuation are ignored', () => {
    expect(search('  LISBON ')[0]!.name).toBe('Lisbon');
    expect(search('sao paulo')[0]!.country).toBe('Brazil');
    expect(search('São Paulo')[0]!.country).toBe('Brazil');
  });

  test('local and old names (namepar / namealt) match', () => {
    expect(search('lisboa')[0]!.name).toBe('Lisbon');
    expect(search('bombay')[0]!.name).toBe('Mumbai');
  });

  test('prefix and word-prefix queries rank the bigger place first', () => {
    expect(search('new y')[0]!.name).toBe('New York');
    expect(search('york')[0]!.name).toMatch(/York/);
  });

  test('a qualifier after a comma narrows by country, code or admin1', () => {
    expect(search('paris, france')[0]!.country).toBe('France');
    const us = search('portland, us');
    expect(us.map((p) => p.admin1)).toEqual(['Oregon', 'Maine']);
    expect(search('portland, maine')[0]!.admin1).toBe('Maine');
    expect(us.every((p) => p.iso2 === 'US')).toBe(true);
    expect(search('lisbon, portugal')[0]!.name).toBe('Lisbon');
    expect(search('lisbon, japan')).toEqual([]);
  });

  test('limit, empty and unknown queries', () => {
    expect(search('san', 3)).toHaveLength(3);
    expect(search('')).toEqual([]);
    expect(search('   ')).toEqual([]);
    expect(search('zzzzqqqq')).toEqual([]);
    expect(search('san').length).toBeLessThanOrEqual(10);
  });

  test('results carry only plain data (name, lat, lon are enough for a geo slot)', () => {
    const p = search('tokyo')[0]!;
    expect(Object.keys(p).sort()).toEqual(
      ['admin1', 'capital', 'country', 'iso2', 'lat', 'lon', 'name', 'population'].sort(),
    );
    expect(typeof p.lat).toBe('number');
  });
});

describe('places.json', () => {
  test('format, provenance and size', () => {
    expect(file.format).toBe('vox-places/1');
    expect(file.source).toMatch(/naturalearthdata\.com/);
    expect(file.columns).toEqual([
      'name',
      'aliases',
      'country',
      'iso2',
      'admin1',
      'lat',
      'lon',
      'population',
      'capital',
    ]);
    expect(file.rows.length).toBeGreaterThan(7000);
  });

  test('every row is well formed', () => {
    for (const r of file.rows) {
      expect(r).toHaveLength(file.columns.length);
      expect(typeof r[0]).toBe('string');
      const lat = r[5] as number;
      const lon = r[6] as number;
      expect(lat).toBeGreaterThanOrEqual(-90);
      expect(lat).toBeLessThanOrEqual(90);
      expect(lon).toBeGreaterThanOrEqual(-180);
      expect(lon).toBeLessThanOrEqual(180);
    }
  });
});

describe('module hygiene', () => {
  test('the default search reads the bundled file offline', () => {
    expect(searchDefault('lisbon')[0]!.name).toBe('Lisbon');
  });

  test('search.ts stays pure: it imports nothing from errors.ts or api.ts (phase 03 wires it)', () => {
    const src = readFileSync(new URL('../../src/geo/search.ts', import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    // resources.ts (packaged data folder, phase 09) imports only node builtins
    expect(imports).toEqual(['node:fs', 'node:path', '../resources.ts']);
  });
});
