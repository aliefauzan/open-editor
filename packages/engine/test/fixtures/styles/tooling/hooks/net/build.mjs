import http from 'node:http';
export function build(vars) {
  return { vars: { ...vars, h: typeof http, f: typeof fetch, hr: process.hrtime } };
}
