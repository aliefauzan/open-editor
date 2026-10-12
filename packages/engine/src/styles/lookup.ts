// The registry as the ops' template lookup (replaces phase 02's fixture lookup).
import type { CaptionPresetInfo, TemplateInfo, TemplateLookup } from '../ops/templates.ts';
import type { StyleRegistry, TemplateDef } from './registry.ts';

export function templateInfo(t: TemplateDef): TemplateInfo {
  return {
    id: t.id,
    version: t.version,
    kind: t.kind,
    durationMs: t.durationMs,
    variables: t.variables,
    slots: t.slots,
    ...(t.sfxCues ? { sfxCues: t.sfxCues } : {}),
    ...(t.blendsShots === undefined ? {} : { blendsShots: t.blendsShots }),
    ...(t.minEntranceMs === undefined ? {} : { minEntranceMs: t.minEntranceMs }),
  };
}

/** A lookup over any valid installed style's templates; one info object per template def. */
export function registryTemplateLookup(registry: () => StyleRegistry): TemplateLookup {
  const cache = new WeakMap<TemplateDef, TemplateInfo>();
  return {
    get(id) {
      const def = registry().template(id);
      if (!def) return undefined;
      let info = cache.get(def);
      if (!info) {
        info = templateInfo(def);
        cache.set(def, info);
      }
      return info;
    },
    captionPreset(id) {
      return presetInfo(registry(), id);
    },
  };
}

/** A caption preset of the style its id names (`<styleId>/<preset>`); undefined when unknown. */
export function presetInfo(registry: StyleRegistry, id: string): CaptionPresetInfo | undefined {
  const styleId = id.split('/')[0] ?? '';
  let def;
  try {
    def = registry.get(styleId).captionPresets[id];
  } catch {
    return undefined;
  }
  if (!def) return undefined;
  return {
    position: { ...def.position },
    ...(def.track ? { track: { ...def.track } } : {}),
    ...(def.tiered === undefined ? {} : { tiered: def.tiered }),
  };
}
