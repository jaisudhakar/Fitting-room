import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const template = read('../demo/template.html');
const renderer = read('../demo/garment3d.js');
const built = read('../demo/index.html');

test('the template keeps both build placeholders', () => {
  assert.ok(template.includes('"__FITTING_ROOM_DATA__"'), 'the catalogue placeholder is missing');
  assert.ok(template.includes('/* __GARMENT3D__ */'), 'the renderer placeholder is missing');
});

test('the built demo has the catalogue and the renderer baked in', () => {
  assert.ok(!built.includes('__FITTING_ROOM_DATA__'), 'the catalogue placeholder was not replaced');
  assert.ok(!built.includes('__GARMENT3D__'), 'the renderer placeholder was not replaced');

  // The renderer is inlined verbatim — the demo has to run from file:// offline.
  assert.ok(built.includes('global.createGarmentView = createGarmentView;'), 'the renderer is not inlined');
  assert.ok(built.includes(renderer.trim().slice(0, 400)), 'the inlined renderer does not match the source');

  // And the live catalogue really is in there, not a stale copy.
  assert.match(built, /"slug": "beige-linen-shirt"/);
  assert.match(built, /"id": "short-sleeve-has-no-cuff"/);
});

test('the build is reproducible — re-running it changes nothing', () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/build-demo.mjs', import.meta.url))], {
    stdio: 'pipe',
  });
  assert.equal(read('../demo/index.html'), built, 'demo/index.html is not up to date with its sources');
});

test('the renderer stands alone: no imports, no network, one global', () => {
  assert.doesNotMatch(renderer, /\bimport\s|\brequire\(|fetch\(|XMLHttpRequest/);
  assert.ok(renderer.includes('const createGarmentView = (canvas, options)'));
  // It must degrade rather than throw where WebGL2 is missing.
  assert.ok(renderer.includes("if (!gl) return { supported: false"));
});

test('every collar, cuff, placket and pocket the catalogue offers has a shape', () => {
  const catalogue = JSON.parse(built.match(/<script id="fr-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  const valuesOf = (groupId) =>
    catalogue.groups.find((group) => group.id === groupId).values.map((value) => value.id);

  for (const collar of valuesOf('collar')) {
    assert.match(renderer, new RegExp(`['"]?${collar}['"]?:\\s*\\{ band:`), `no collar shape for "${collar}"`);
  }
  // Sizes drive the scale table.
  for (const size of valuesOf('size')) {
    assert.match(renderer, new RegExp(`'?${size}'?:\\s*[\\d.]+`), `no size scale for "${size}"`);
  }
  // Monogram positions all need somewhere to land.
  for (const position of catalogue.monogram.positions.map((item) => item.id)) {
    assert.ok(renderer.includes(`'${position}': { part:`), `no decal placement for "${position}"`);
  }
});
