// vox/map-route compile hook (styles spec "Compile hook"): projects the bundled Natural Earth 1:50m
// countries around the places and writes `map.svg` (sea, land, borders) in a 1080x1920 viewBox, plus
// the pin positions and the route path in the same coordinates. Pure and deterministic: no clock,
// no randomness, no network; the data file is read with ctx.readAsset.
import { geoMercator, geoPath } from './vendor/d3-geo.mjs';
import { feature, mesh } from './vendor/topojson-client.mjs';

const VW = 1080;
const VH = 1920;
// pins stay inside this box, so their tags stay inside the 9:16 caption safe area
const INNER = [
  [170, 330],
  [910, 1330],
];
const PAD_DEG = { world: 20, region: 6, city: 0.6 };
const PALETTES = {
  vox: { sea: '#1D4FA0', land: '#F5C518', border: 'rgb(20 20 20 / 45%)' },
  paper: { sea: '#D9D2C3', land: '#EDE8DF', border: 'rgb(20 20 20 / 55%)' },
};

let topo;

function bboxFeature(places, pad) {
  const lons = places.map((p) => p.lon);
  const lats = places.map((p) => p.lat);
  const w = Math.max(-180, Math.min(...lons) - pad);
  const e = Math.min(180, Math.max(...lons) + pad);
  const s = Math.max(-80, Math.min(...lats) - pad * 0.8);
  const n = Math.min(84, Math.max(...lats) + pad * 0.8);
  return {
    type: 'MultiPoint',
    coordinates: [
      [w, s],
      [e, n],
      [w, n],
      [e, s],
    ],
  };
}

export function build(vars, ctx) {
  if (!topo) topo = JSON.parse(ctx.readAsset('assets/geo/countries-50m.json').toString('utf8'));
  const places = vars.places;
  const zoom = vars.zoom ?? 'region';
  const palette = PALETTES[vars.palette ?? 'vox'];
  const projection = geoMercator()
    .fitExtent(INNER, bboxFeature(places, PAD_DEG[zoom]))
    .clipExtent([
      [-20, -20],
      [VW + 20, VH + 20],
    ]);
  const path = geoPath(projection).digits(1);
  const land = path(feature(topo, topo.objects.land)) ?? '';
  const borders = path(mesh(topo, topo.objects.countries, (a, b) => a !== b)) ?? '';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${VH}" width="${VW}" height="${VH}">` +
    `<rect width="${VW}" height="${VH}" fill="${palette.sea}"/>` +
    `<path d="${land}" fill="${palette.land}"/>` +
    `<path d="${borders}" fill="none" stroke="${palette.border}" stroke-width="1.6" stroke-linejoin="round"/>` +
    `</svg>`;
  const pins = places.map((p) => {
    const [x, y] = projection([p.lon, p.lat]);
    return { name: p.name, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
  });
  let routePath = '';
  if (vars.route && places.length > 1) {
    // great-circle legs, without the clip so a leg is never cut
    const line = { type: 'LineString', coordinates: places.map((p) => [p.lon, p.lat]) };
    routePath = geoPath(projection.clipExtent(null)).digits(1)(line) ?? '';
  }
  return {
    vars: { ...vars, map: ctx.fileUrl('map.svg'), pins, routePath },
    files: { 'map.svg': svg },
  };
}
