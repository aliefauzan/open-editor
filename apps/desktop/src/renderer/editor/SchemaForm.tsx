// Scene inspector form generated from a template's variables JSON Schema (app spec "Inspector"; styles
// spec "template.json"): text fields with `maxLength` counters, numbers, switches, enums, arrays with
// add/remove, media pickers for `image` / `cutout` / `video` slots, place search for `geo` slots and
// nested forms for `template` slots (depth 1, like `stack`).
import { useEffect, useId, useState } from 'react';
import type { JsonSchema, MediaItem, SlotKind, TemplateData } from '../../shared/project.ts';
import { useCtx } from './context.tsx';

export interface FormEnv {
  media: readonly MediaItem[];
  /** Templates a `template` slot may name (scene templates of the sequence style). */
  templates: Record<string, TemplateData>;
  /** Slot path (`photo`, `items/*\/media`) → kind. */
  slots: Record<string, SlotKind>;
}

type Path = (string | number)[];

/** `items/*\/media` form of a value path (array indices become `*`). */
export const slotPath = (p: Path) => p.map((s) => (typeof s === 'number' ? '*' : s)).join('/');

const typeOf = (s: JsonSchema): string | undefined =>
  Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;

/** A fresh value for a schema (default, first enum, empty). */
export function emptyValue(s: JsonSchema): unknown {
  if (s.default !== undefined) return structuredClone(s.default);
  if (s.enum) return s.enum[0];
  switch (typeOf(s)) {
    case 'string':
      return '';
    case 'number':
    case 'integer':
      return s.minimum ?? 0;
    case 'boolean':
      return false;
    case 'array':
      return Array.from({ length: s.minItems ?? 0 }, () => emptyValue(s.items ?? {}));
    case 'object': {
      const o: Record<string, unknown> = {};
      for (const k of s.required ?? []) o[k] = emptyValue(s.properties?.[k] ?? {});
      return o;
    }
    default:
      return null;
  }
}

const label = (name: string, s: JsonSchema) => s.title ?? name.replace(/([a-z])([A-Z])/g, '$1 $2');
const input = 'w-full rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-100';

function MediaPicker(props: {
  kind: SlotKind;
  value: unknown;
  env: FormEnv;
  name: string;
  onChange: (v: unknown) => void;
}) {
  const want = props.kind === 'video' ? ['video'] : ['image', 'video'];
  const options = props.env.media.filter((m) => want.includes(m.kind));
  return (
    <select
      aria-label={props.name}
      className={input}
      value={typeof props.value === 'string' ? props.value : ''}
      onChange={(e) => props.onChange(e.target.value || null)}
    >
      <option value="">Choose {props.kind === 'video' ? 'a video' : 'an image'}…</option>
      {options.map((m) => (
        <option key={m.id} value={m.id}>
          {m.path.split('/').pop()} ({m.kind})
        </option>
      ))}
    </select>
  );
}

interface Place {
  name: string;
  lat: number;
  lon: number;
  country?: string;
}

function GeoPicker(props: { value: unknown; name: string; onChange: (v: unknown) => void }) {
  const { vox } = useCtx();
  const v = props.value as Partial<Place> | null;
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Place[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) return setHits([]);
    let live = true;
    vox.geo
      .search(q)
      .then((r) => live && setHits((r as Place[]).slice(0, 8)))
      .catch(() => live && setHits([]));
    return () => {
      live = false;
    };
  }, [vox, q]);
  return (
    <div className="space-y-1">
      <div className="text-xs text-neutral-300" data-testid="geo-value">
        {v?.name ? `${v.name} (${v.lat?.toFixed(2)}, ${v.lon?.toFixed(2)})` : 'No place'}
      </div>
      <input
        aria-label={`Search a place for ${props.name}`}
        className={input}
        placeholder="Search a place"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {hits.length > 0 && (
        <ul
          role="listbox"
          aria-label="Places"
          className="max-h-40 overflow-y-auto rounded border border-neutral-700"
        >
          {hits.map((h) => (
            <li key={`${h.name}-${h.lat}-${h.lon}`}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="w-full px-2 py-1 text-left text-xs hover:bg-neutral-700"
                onClick={() => {
                  props.onChange({ name: h.name, lat: h.lat, lon: h.lon });
                  setQ('');
                }}
              >
                {h.name}
                {h.country ? `, ${h.country}` : ''}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TemplateSlot(props: {
  value: unknown;
  env: FormEnv;
  depth: number;
  path: Path;
  onChange: (v: unknown) => void;
}) {
  const v = (props.value ?? {}) as { template?: string; variables?: Record<string, unknown> };
  const scenes = Object.values(props.env.templates).filter((t) => t.kind === 'scene');
  const t = v.template ? props.env.templates[v.template] : undefined;
  return (
    <div className="space-y-2 rounded border border-neutral-700 p-2">
      <select
        aria-label="Panel template"
        className={input}
        value={v.template ?? ''}
        onChange={(e) => {
          const next = props.env.templates[e.target.value];
          props.onChange({
            template: e.target.value,
            variables: next ? (emptyValue(next.variables) as Record<string, unknown>) : {},
          });
        }}
      >
        <option value="">Choose a template…</option>
        {scenes.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
      {t && (
        <SchemaForm
          schema={t.variables}
          value={v.variables ?? {}}
          env={{ ...props.env, slots: t.slots }}
          depth={props.depth}
          onChange={(vars) => props.onChange({ template: v.template, variables: vars })}
        />
      )}
    </div>
  );
}

function Field(props: {
  name: string;
  schema: JsonSchema;
  value: unknown;
  path: Path;
  env: FormEnv;
  depth: number;
  required: boolean;
  onChange: (v: unknown) => void;
}) {
  const id = useId();
  const { schema: s, value } = props;
  const slot = props.env.slots[slotPath(props.path)];
  const lab = label(props.name, s);
  const head = (
    <label htmlFor={id} className="mb-0.5 flex justify-between text-[11px] text-neutral-400">
      <span>
        {lab}
        {props.required ? ' *' : ''}
      </span>
      {typeOf(s) === 'string' && s.maxLength !== undefined && !slot && (
        <span
          data-testid={`count-${slotPath(props.path)}`}
          className={String(value ?? '').length > s.maxLength ? 'text-red-400' : ''}
        >
          {String(value ?? '').length}/{s.maxLength}
        </span>
      )}
    </label>
  );
  if (slot === 'template') {
    // depth 1 only (like `stack`): a template slot inside a panel is not opened further
    if (props.depth >= 1)
      return (
        <p className="text-[11px] text-neutral-500">{lab}: nested panels open one level deep.</p>
      );
    return (
      <div>
        {head}
        <TemplateSlot
          value={value}
          env={props.env}
          depth={props.depth + 1}
          path={props.path}
          onChange={props.onChange}
        />
      </div>
    );
  }
  if (slot === 'geo') {
    return (
      <div>
        {head}
        <GeoPicker value={value} name={lab} onChange={props.onChange} />
      </div>
    );
  }
  if (slot === 'image' || slot === 'cutout' || slot === 'video') {
    return (
      <div>
        {head}
        <MediaPicker
          kind={slot}
          value={value}
          env={props.env}
          name={lab}
          onChange={props.onChange}
        />
      </div>
    );
  }
  if (s.enum) {
    return (
      <div>
        {head}
        <select
          id={id}
          className={input}
          value={String(value ?? s.default ?? s.enum[0])}
          onChange={(e) => props.onChange(s.enum!.find((x) => String(x) === e.target.value))}
        >
          {s.enum.map((x) => (
            <option key={String(x)} value={String(x)}>
              {String(x)}
            </option>
          ))}
        </select>
      </div>
    );
  }
  switch (typeOf(s)) {
    case 'string': {
      const long = (s.maxLength ?? 0) > 80;
      const common = {
        id,
        className: input,
        value: String(value ?? ''),
        maxLength: s.maxLength,
        onChange: (e: { target: { value: string } }) => props.onChange(e.target.value),
      };
      return (
        <div>
          {head}
          {long ? <textarea rows={3} {...common} /> : <input type="text" {...common} />}
        </div>
      );
    }
    case 'number':
    case 'integer':
      return (
        <div>
          {head}
          <input
            id={id}
            type="number"
            className={input}
            value={typeof value === 'number' ? value : ''}
            min={s.minimum}
            max={s.maximum}
            step={typeOf(s) === 'integer' ? 1 : 'any'}
            onChange={(e) => props.onChange(e.target.value === '' ? null : Number(e.target.value))}
          />
        </div>
      );
    case 'boolean':
      return (
        <label className="flex items-center gap-2 text-xs">
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(e) => props.onChange(e.target.checked)}
          />
          {lab}
        </label>
      );
    case 'array': {
      const list = Array.isArray(value) ? value : [];
      const item = s.items ?? {};
      const canAdd = s.maxItems === undefined || list.length < s.maxItems;
      const canRemove = list.length > (s.minItems ?? 0);
      return (
        <fieldset className="space-y-2 rounded border border-neutral-800 p-2">
          <legend className="px-1 text-[11px] text-neutral-400">
            {lab} ({list.length})
          </legend>
          {list.map((v, i) => (
            <div key={i} className="relative space-y-1 border-b border-neutral-800 pb-2">
              <Field
                name={`${lab} ${i + 1}`}
                schema={item}
                value={v}
                path={[...props.path, i]}
                env={props.env}
                depth={props.depth}
                required={false}
                onChange={(nv) => props.onChange(list.map((x, j) => (j === i ? nv : x)))}
              />
              <button
                type="button"
                disabled={!canRemove}
                aria-label={`Remove ${lab} ${i + 1}`}
                className="text-[11px] text-red-300 disabled:opacity-40"
                onClick={() => props.onChange(list.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={!canAdd}
            className="rounded bg-neutral-800 px-2 py-0.5 text-[11px] disabled:opacity-40"
            onClick={() => props.onChange([...list, emptyValue(item)])}
          >
            Add {lab.replace(/s$/, '')}
          </button>
        </fieldset>
      );
    }
    case 'object':
      return (
        <fieldset className="space-y-2 rounded border border-neutral-800 p-2">
          <legend className="px-1 text-[11px] text-neutral-400">{lab}</legend>
          <ObjectFields
            schema={s}
            value={(value ?? {}) as Record<string, unknown>}
            path={props.path}
            env={props.env}
            depth={props.depth}
            onChange={props.onChange}
          />
        </fieldset>
      );
    default:
      return null;
  }
}

function ObjectFields(props: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  path: Path;
  env: FormEnv;
  depth: number;
  onChange: (v: Record<string, unknown>) => void;
}) {
  const req = new Set(props.schema.required ?? []);
  return (
    <>
      {Object.entries(props.schema.properties ?? {}).map(([k, s]) => (
        <Field
          key={k}
          name={k}
          schema={s}
          value={props.value[k]}
          path={[...props.path, k]}
          env={props.env}
          depth={props.depth}
          required={req.has(k)}
          onChange={(v) => {
            const next = { ...props.value };
            if (v === null || v === undefined || (v === '' && !req.has(k))) delete next[k];
            else next[k] = v;
            props.onChange(next);
          }}
        />
      ))}
    </>
  );
}

export function SchemaForm(props: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  env: FormEnv;
  depth?: number;
  onChange: (v: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-2">
      <ObjectFields
        schema={props.schema}
        value={props.value}
        path={[]}
        env={props.env}
        depth={props.depth ?? 0}
        onChange={props.onChange}
      />
    </div>
  );
}
