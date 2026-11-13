// Bundles engine entry points into IIFE strings for injecting into a browser page.
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function bundle(contents, globalName) {
  const r = buildSync({
    stdin: { contents, resolveDir: resolve(root, 'packages/engine/src'), loader: 'ts' },
    bundle: true, write: false, format: 'iife', globalName, target: 'es2020',
  });
  return r.outputFiles[0].text;
}

/** Script that replaces Math.exp, Math.log and Math.cos with the engine's fixed math. */
export function fixedMathPatch() {
  return bundle("import { fexp, flog, fcos } from './fixedmath.ts'; Math.exp = fexp; Math.log = flog; Math.cos = fcos;", '__fixedMathPatch');
}

/** Script that exposes the whole engine package as window.ELE. */
export function engineBundle() {
  return bundle("export * from './index.ts';", 'ELE');
}
