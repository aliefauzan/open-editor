// Resource folders for packaged builds (plan phase 09, R1 "Packaged app"): the places index, the vox
// runtime, the pinned HyperFrames + GSAP packages and the uv project resolve from the folders the app
// or the bundled CLI sets; unset keys keep the repo layout.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { search } from '../src/geo/search.ts';
import { vendorSources } from '../src/compile/write.ts';
import { repoPyProject } from '../src/py.ts';
import { hyperframesBin } from '../src/render/layers.ts';
import { dataDir, resourceDirs, setResourceDirs } from '../src/resources.ts';
import { tempDir } from './helpers/store.ts';

afterEach(() => setResourceDirs({}));

function fakePackage(modules: string, name: string, files: string[]): string {
  const dir = join(modules, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0-test' }));
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), '');
  }
  return dir;
}

describe('resource folders', () => {
  test('defaults are the repo layout', () => {
    expect(resourceDirs()).toEqual({});
    expect(dataDir()).toMatch(/packages\/engine\/data$/);
    expect(repoPyProject()).toMatch(/\/py$/);
    expect(search('lisbon')[0]?.name).toBe('Lisbon');
  });

  test('a set data folder replaces the bundled places index', () => {
    const data = tempDir();
    writeFileSync(
      join(data, 'places.json'),
      JSON.stringify({
        format: 'vox-places/1',
        source: 'test',
        columns: [
          'name',
          'aliases',
          'country',
          'iso2',
          'admin1',
          'lat',
          'lon',
          'population',
          'capital',
        ],
        rows: [['Testville', '', 'Nowhere', 'NW', '', 1, 2, 10, 0]],
      }),
    );
    setResourceDirs({ data });
    expect(search('testville')[0]).toMatchObject({ name: 'Testville', lat: 1, lon: 2 });
    expect(search('lisbon')).toEqual([]);
    setResourceDirs({});
    expect(search('lisbon')[0]?.name).toBe('Lisbon');
  });

  test('runtime, node packages and the uv project come from the set folders', () => {
    const root = realpathSync(tempDir());
    const modules = join(root, 'hyperframes');
    const hf = fakePackage(modules, 'hyperframes', ['dist/hyperframe.runtime.iife.js']);
    const gsap = fakePackage(modules, 'gsap', ['dist/gsap.min.js']);
    setResourceDirs({ modules, runtime: join(root, 'runtime'), py: join(root, 'py') });
    const v = vendorSources();
    expect(v['gsap.min.js']).toBe(join(gsap, 'dist', 'gsap.min.js'));
    expect(v['hyperframe.runtime.iife.js']).toBe(join(hf, 'dist', 'hyperframe.runtime.iife.js'));
    expect(v['vox-runtime.js']).toBe(join(root, 'runtime', 'vox-runtime.js'));
    expect(hyperframesBin()).toBe(join(hf, 'bin', 'hyperframes.mjs'));
    expect(repoPyProject()).toBe(join(root, 'py'));
  });
});
