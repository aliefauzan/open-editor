// Style data for the style panel, the inspector and the timeline (template names and colours).
// `styles.get` answers are cached per editor; `styles.reload` in later phases can clear the cache.
import { useEffect, useState } from 'react';
import type { ResolvedStyleData, StyleSummaryData, TemplateData } from '../../shared/project.ts';
import { useCtx } from './context.tsx';

const cache = new WeakMap<object, Map<string, Promise<ResolvedStyleData>>>();

export function useResolvedStyle(styleId: string | undefined): ResolvedStyleData | null {
  const { vox } = useCtx();
  const [style, setStyle] = useState<ResolvedStyleData | null>(null);
  useEffect(() => {
    if (!styleId) return setStyle(null);
    let live = true;
    let byVox = cache.get(vox);
    if (!byVox) cache.set(vox, (byVox = new Map()));
    let p = byVox.get(styleId);
    if (!p) {
      p = vox.styles.get(styleId) as Promise<ResolvedStyleData>;
      byVox.set(styleId, p);
      p.catch(() => byVox.delete(styleId));
    }
    p.then((s) => live && setStyle(s)).catch(() => live && setStyle(null));
    return () => {
      live = false;
    };
  }, [vox, styleId]);
  return style;
}

/** Installed styles; a new `version` reads the list again (after an extraction, accept or remove). */
export function useStyleList(version = 0): StyleSummaryData[] {
  const { vox } = useCtx();
  const [list, setList] = useState<StyleSummaryData[]>([]);
  useEffect(() => {
    let live = true;
    vox.styles
      .list()
      .then((l) => live && setList(l as StyleSummaryData[]))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [vox, version]);
  return list;
}

/** A stable colour per template id (scene clips show their template's colour). */
export function templateColor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 38%)`;
}

export const templateName = (t: TemplateData | undefined, id: string) =>
  t?.name ?? id.slice(id.indexOf('/') + 1);

/** `vox-media://styles/<styleId>/previews/<name>.jpg` (the style's fixture preview). */
export const previewUrl = (templateId: string, ext: 'jpg' | 'gif' = 'jpg') => {
  const [style, name] = templateId.split('/') as [string, string];
  return `vox-media://styles/${encodeURIComponent(style)}/previews/${encodeURIComponent(name)}.${ext}`;
};
