// Fixture template schemas: the template lookup stub until phase 03's registry exists.
import { mapTemplateLookup, type TemplateInfo } from '../../src/ops/templates.ts';

export const TEMPLATES: TemplateInfo[] = [
  {
    id: 'test/title',
    version: '1.2.0',
    kind: 'scene',
    durationMs: { min: 500, default: 3000, max: 10000 },
    variables: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 60 },
        subtitle: { type: 'string' },
        bg: { enum: ['paper', 'dark'] },
      },
      required: ['title'],
      additionalProperties: false,
    },
    slots: {},
    sfxCues: [
      { name: 'pop', atMs: 'entrance', sfx: 'paper-pop', type: 'appear' },
      { name: 'land', atMs: 900, sfx: 'thump', type: 'land' },
    ],
  },
  {
    id: 'test/card',
    version: '2.0.0',
    kind: 'scene',
    durationMs: { min: 1000, default: 4000, max: 8000 },
    variables: {
      type: 'object',
      properties: { title: { type: 'string' }, photo: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    },
    slots: { photo: 'image' },
  },
  {
    id: 'test/number',
    version: '1.0.0',
    kind: 'scene',
    durationMs: { min: 500, default: 2000, max: 6000 },
    variables: { type: 'object', properties: { title: { type: 'number' } }, required: ['title'] },
    slots: {},
  },
  {
    id: 'test/map',
    version: '1.0.0',
    kind: 'scene',
    durationMs: { min: 500, default: 2000, max: 6000 },
    variables: {
      type: 'object',
      properties: { title: { type: 'string' }, photo: { type: 'object' } },
      required: ['title'],
    },
    slots: { photo: 'geo' },
  },
  {
    id: 'test/stack',
    version: '1.0.0',
    kind: 'scene',
    durationMs: { min: 1000, default: 5000, max: 12000 },
    variables: {
      type: 'object',
      properties: {
        panels: {
          type: 'array',
          minItems: 2,
          maxItems: 3,
          items: {
            type: 'object',
            properties: { template: { type: 'string' }, variables: { type: 'object' } },
            required: ['template', 'variables'],
          },
        },
      },
      required: ['panels'],
    },
    slots: { 'panels/*': 'template' },
  },
  {
    id: 'test/crossfade',
    version: '1.0.0',
    kind: 'transition',
    durationMs: { min: 100, default: 500, max: 2000 },
    variables: { type: 'object' },
    slots: {},
    blendsShots: true,
  },
  {
    id: 'test/wipe',
    version: '1.0.0',
    kind: 'transition',
    durationMs: { min: 100, default: 500, max: 2000 },
    variables: { type: 'object' },
    slots: {},
  },
];

export const templates = mapTemplateLookup(TEMPLATES);
