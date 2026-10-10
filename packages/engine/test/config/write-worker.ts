// Child process for the cross-process config write test: writes `<prefix>_<i>` = i, one patch each.
import { writeConfig } from '../../src/config.ts';

const [prefix, count] = process.argv.slice(2);
const n = Number(count);
await Promise.all(Array.from({ length: n }, (_, i) => writeConfig({ [`${prefix}_${i}`]: i })));
