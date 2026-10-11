// Early package A1 (D-19): static checks on the committed fonts, geo data, texture, SFX candidates and
// vendored d3. Phase 03/07 own the style loader and the kit check; these only guard the files.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const root = new URL('../../../../', import.meta.url);
const file = (p: string) => new URL(p, root);
const read = (p: string) => readFileSync(file(p));
const sha256 = (p: string) => createHash('sha256').update(read(p)).digest('hex');
const text = (p: string) => read(p).toString('utf8');

describe('fonts (OFL)', () => {
  const sets: Record<string, string[]> = {
    'styles/base/assets/fonts': [
      'Inter-Variable.ttf',
      'IBMPlexMono-Regular.ttf',
      'IBMPlexMono-Bold.ttf',
    ],
    'styles/vox/assets/fonts': [
      'DMSerifDisplay-Regular.ttf',
      'LibreCaslonText-Variable.ttf',
      'LibreCaslonText-Italic.ttf',
      'IBMPlexMono-Regular.ttf',
      'IBMPlexMono-Bold.ttf',
    ],
  };

  for (const [dir, files] of Object.entries(sets)) {
    test.each(files)(`${dir}/%s is a TrueType font whose SHA-256 is in SOURCES.md`, (name) => {
      const buf = read(`${dir}/${name}`);
      // 0x00010000 = TrueType outlines
      expect(buf.readUInt32BE(0)).toBe(0x00010000);
      expect(text(`${dir}/SOURCES.md`)).toContain(sha256(`${dir}/${name}`));
    });

    test(`${dir} has an OFL text for every family and nothing else unlisted`, () => {
      const ofl = readdirSync(file(`${dir}/`)).filter((n) => n.startsWith('OFL-'));
      expect(ofl.length).toBeGreaterThanOrEqual(2);
      for (const n of ofl) {
        expect(text(`${dir}/${n}`)).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/i);
        expect(text(`${dir}/SOURCES.md`)).toContain(n);
      }
      const listed = readdirSync(file(`${dir}/`)).filter((n) => n.endsWith('.ttf'));
      expect(listed.sort()).toEqual([...files].sort());
    });
  }

  test('the word-reveal emphasis font is a WOFF2 subset of Inter whose SHA-256 is in SOURCES.md', () => {
    const dir = 'styles/vox/assets/fonts';
    const name = 'Inter-ExtraBold-subset.woff2';
    expect(read(`${dir}/${name}`).subarray(0, 4).toString('latin1')).toBe('wOF2');
    expect(statSync(file(`${dir}/${name}`)).size).toBeLessThan(40_000);
    expect(text(`${dir}/SOURCES.md`)).toContain(sha256(`${dir}/${name}`));
  });

  test('phase 07 kept DM Serif Display as fonts.display and removed the other candidate', () => {
    const names = readdirSync(file('styles/vox/assets/fonts/'));
    expect(names).not.toContain('LibreCaslonDisplay-Regular.ttf');
    expect(names).toContain('DMSerifDisplay-Regular.ttf');
    const style = JSON.parse(text('styles/vox/style.json')) as {
      tokens: { fonts: { display: { family: string; file: string } } };
    };
    expect(style.tokens.fonts.display).toMatchObject({
      family: 'DM Serif Display',
      file: 'assets/fonts/DMSerifDisplay-Regular.ttf',
    });
  });
});

describe('vendored d3-geo and topojson-client (map-route)', () => {
  const vendor = 'styles/vox/templates/map-route/vendor';
  type D3 = {
    geoNaturalEarth1: () => { fitSize: (s: [number, number], o: unknown) => unknown };
    geoPath: (p: unknown) => (o: unknown) => string | null;
    geoCentroid: (o: unknown) => [number, number];
  };
  type Topo = {
    feature: (
      t: unknown,
      o: unknown,
    ) => { features: { id: string; properties: { name: string } }[] };
  };

  test('are self-contained ES modules (no imports, no network)', () => {
    for (const f of ['d3-geo.mjs', 'topojson-client.mjs']) {
      const src = text(`${vendor}/${f}`);
      expect(src).not.toMatch(/^\s*import\s/m);
      expect(src).not.toMatch(/\brequire\(/);
      expect(src).not.toMatch(/https?:\/\/(?!github\.com|d3js\.org|bost\.ocks)/);
    }
  });

  test('versions and hashes are recorded', () => {
    const lic = text(`${vendor}/LICENSES.md`);
    expect(lic).toContain('d3-geo@3.1.1');
    expect(lic).toContain('topojson-client@3.1.0');
    for (const f of ['d3-geo.mjs', 'topojson-client.mjs'])
      expect(lic).toContain(sha256(`${vendor}/${f}`));
    expect(lic).toMatch(/Permission to use, copy, modify, and\/or distribute/);
  });

  test('project Natural Earth 1:50m Portugal to an SVG path offline', async () => {
    const d3 = (await import(file(`${vendor}/d3-geo.mjs`).href)) as D3;
    const topo = (await import(file(`${vendor}/topojson-client.mjs`).href)) as Topo;
    const t = JSON.parse(text('styles/vox/assets/geo/countries-50m.json')) as {
      objects: { countries: unknown };
    };
    const fc = topo.feature(t, t.objects.countries);
    const pt = fc.features.find((f) => f.properties.name === 'Portugal');
    expect(pt).toBeDefined();
    const path = d3.geoPath(d3.geoNaturalEarth1().fitSize([400, 300], pt));
    const d = path(pt);
    expect(d).toMatch(/^M[\d.,-]+/);
    expect(d!.length).toBeGreaterThan(200);
    const [lon, lat] = d3.geoCentroid(pt);
    expect(lat).toBeGreaterThan(37);
    expect(lat).toBeLessThan(40.5);
    expect(lon).toBeGreaterThan(-9.5);
    expect(lon).toBeLessThan(-7);
  });
});

describe('Natural Earth countries (TopoJSON)', () => {
  test('1:50m, 241 countries with names, land object, size under 1 MB', () => {
    const p = 'styles/vox/assets/geo/countries-50m.json';
    expect(statSync(file(p)).size).toBeLessThan(1_000_000);
    const t = JSON.parse(text(p)) as {
      type: string;
      objects: { countries: { geometries: { properties: { name: string } }[] }; land: unknown };
    };
    expect(t.type).toBe('Topology');
    expect(t.objects.countries.geometries).toHaveLength(241);
    expect(t.objects.countries.geometries.every((g) => g.properties.name)).toBe(true);
    expect(t.objects.land).toBeDefined();
    expect(text('styles/vox/ASSETS.md')).toContain(sha256(p));
  });
});

describe('paper texture (CC0)', () => {
  test('is a 1024x1024 JPEG under 500 kB with its source recorded', () => {
    const p = 'styles/vox/assets/textures/paper.jpg';
    const buf = read(p);
    expect(statSync(file(p)).size).toBeLessThan(500_000);
    expect(buf.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    // find the SOF0/SOF2 marker for the dimensions
    let i = 2;
    let dims: [number, number] | undefined;
    while (i < buf.length) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1]!;
      const len = buf.readUInt16BE(i + 2);
      if (marker === 0xc0 || marker === 0xc2) {
        dims = [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
        break;
      }
      i += 2 + len;
    }
    expect(dims).toEqual([1024, 1024]);
    const assets = text('styles/vox/ASSETS.md');
    expect(assets).toContain('commons.wikimedia.org/wiki/File:Papier_aquarelle');
    expect(assets).toMatch(/CC0/);
    expect(assets).toContain(sha256(p));
  });
});

describe('SFX kit (real recordings, D-14; accepted in phase 07)', () => {
  // GATE 3 round 2 added the accent sounds snip, type-key and timpani
  const names = [
    'paper-pop',
    'paper-slide',
    'whoosh',
    'stamp',
    'thump-tap',
    'snip',
    'type-key',
    'timpani',
  ];
  // phase 07 re-processing: sample peak -1.2 dBFS; the hero thump 11 dB lower (audio QA
  // sfxUnderSpeech)
  const peakDbfs: Record<string, number> = { 'thump-tap': -12.0 };
  const dir = 'styles/vox/assets/sfx';

  test('the folder holds exactly the eight kit files and CREDITS.md (typewriter removed)', () => {
    expect(readdirSync(file(`${dir}/`)).sort()).toEqual(
      [...names.map((n) => `${n}.wav`), 'CREDITS.md'].sort(),
    );
  });

  test.each(names)(
    '%s.wav is mono 48 kHz 16-bit, at most 3 s, at its recorded peak, listed with a source',
    (name) => {
      const b = read(`${dir}/${name}.wav`);
      expect(b.toString('ascii', 0, 4)).toBe('RIFF');
      expect(b.toString('ascii', 8, 12)).toBe('WAVE');
      expect(b.toString('ascii', 12, 16)).toBe('fmt ');
      expect(b.readUInt16LE(20)).toBe(1); // PCM
      expect(b.readUInt16LE(22)).toBe(1); // mono
      expect(b.readUInt32LE(24)).toBe(48000);
      expect(b.readUInt16LE(34)).toBe(16);
      // locate the data chunk
      let off = 12;
      let dataOff = -1;
      let dataLen = 0;
      while (off + 8 <= b.length) {
        const id = b.toString('ascii', off, off + 4);
        const len = b.readUInt32LE(off + 4);
        if (id === 'data') {
          dataOff = off + 8;
          dataLen = len;
          break;
        }
        off += 8 + len + (len % 2);
      }
      expect(dataOff).toBeGreaterThan(0);
      const n = dataLen / 2;
      expect(n / 48000).toBeLessThanOrEqual(3);
      let peak = 0;
      for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(b.readInt16LE(dataOff + i * 2)));
      const dbfs = 20 * Math.log10(peak / 32768);
      const want = peakDbfs[name] ?? -1.2;
      expect(dbfs).toBeLessThanOrEqual(want + 0.1);
      expect(dbfs).toBeGreaterThanOrEqual(want - 0.1);
      // fades: the first and last samples are near zero
      expect(Math.abs(b.readInt16LE(dataOff))).toBeLessThan(64);
      expect(Math.abs(b.readInt16LE(dataOff + (n - 1) * 2))).toBeLessThan(64);

      const credits = text(`${dir}/CREDITS.md`);
      expect(credits).toContain(`\`${name}.wav\``);
      const row = credits.split('\n').find((l) => l.startsWith(`| \`${name}.wav\``))!;
      expect(row).toMatch(/commons\.wikimedia\.org\/wiki\/File:|freesound\.org\/people\//);
      // Freesound files come from the public lossy preview until the owner fetches the original
      if (row.includes('freesound.org/people/')) {
        expect(row).toContain('preview-only, original needs Freesound login');
      }
      expect(row).toMatch(/\| (CC0|Public domain \(`CC0` in style\.json\))\s+\|/);
    },
  );

  test('CREDITS.md records the acceptance and names no licence outside CC0 / public domain', () => {
    const credits = text(`${dir}/CREDITS.md`);
    expect(credits).toMatch(/accepted in phase 07/);
    const rows = credits.split('\n').filter((l) => /^\| `[a-z-]+\.wav`/.test(l));
    expect(rows).toHaveLength(9);
    for (const r of rows) expect(r).not.toMatch(/CC BY|CC-BY|NonCommercial/i);
  });
});

describe('total size of the new assets stays reasonable', () => {
  const walk = (rel: string, skip: (name: string) => boolean = () => false): number =>
    readdirSync(file(rel), { withFileTypes: true }).reduce(
      (sum, e) =>
        skip(e.name)
          ? sum
          : sum +
            (e.isDirectory()
              ? walk(`${rel}${e.name}/`, skip)
              : statSync(file(`${rel}${e.name}`)).size),
      0,
    );

  // previews/ are generated by `vox style validate` (D-34) and bounded on their own below
  test('styles/ under 6 MB without the generated previews', () => {
    expect(walk('styles/', (n) => n === 'previews')).toBeLessThan(6_000_000);
  });

  test('each style previews/ folder under 8 MB', () => {
    for (const id of readdirSync(file('styles/'))) {
      if (!statSync(file(`styles/${id}`)).isDirectory()) continue;
      const rel = `styles/${id}/previews/`;
      if (readdirSync(file(`styles/${id}/`)).includes('previews')) {
        expect(walk(rel), rel).toBeLessThan(8_000_000);
      }
    }
  });
});
