/**
 * Optimise the exported model library in place.
 *
 * Blender writes float positions, float normals and float colours, which is
 * roughly three times what any of them needs. Quantising to 14-bit positions,
 * 10-bit normals and 8-bit colours is visually lossless at our scale - the
 * models are chunky low-poly and the largest is twelve metres across - and
 * takes the library from around three megabytes to well under one.
 *
 * `KHR_mesh_quantization` is supported natively by three.js's GLTFLoader with
 * no decoder to ship, which is exactly why this is the compression we use and
 * Draco is not: Draco would save a little more and cost half a megabyte of
 * WASM to get it back.
 *
 *   node tools/build-assets.mjs [--check]
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeIO } from '@gltf-transform/core';
import { KHRMeshQuantization } from '@gltf-transform/extensions';
import { dedup, join as joinPrimitives, prune, quantize, weld } from '@gltf-transform/functions';

const MODEL_DIR = fileURLToPath(new URL('../public/models/', import.meta.url));
const CHECK_ONLY = process.argv.includes('--check');

const io = new NodeIO().registerExtensions([KHRMeshQuantization]);

/** Quantisation grid. Positions get the most bits; colours need the fewest. */
const QUANTIZE_OPTIONS = {
  quantizePosition: 14,
  quantizeNormal: 10,
  quantizeTexcoord: 12,
  quantizeColor: 8,
  quantizeWeight: 8,
  quantizeGeneric: 12,
};

function format(bytes) {
  return `${(bytes / 1024).toFixed(1)} kB`;
}

/** Quantising twice compounds the error, so an already-quantised file is skipped. */
async function isQuantised(path) {
  const bytes = await readFile(path);
  return bytes.includes(Buffer.from('KHR_mesh_quantization'));
}

async function optimise(file) {
  const path = join(MODEL_DIR, file);
  const before = (await stat(path)).size;
  if (await isQuantised(path)) return { file, before, after: before, skipped: true };
  const document = await io.read(path);

  await document.transform(
    // Welding first means dedup and quantize have less to chew on, and a
    // flat-shaded prop welds hard: every corner is its own vertex until the
    // tolerance says otherwise.
    weld({ tolerance: 0.0001 }),
    dedup(),
    joinPrimitives(),
    prune({ keepAttributes: false, keepLeaves: false }),
    quantize(QUANTIZE_OPTIONS),
  );

  const bytes = await io.writeBinary(document);
  if (!CHECK_ONLY) await writeFile(path, bytes);
  return { file, before, after: bytes.byteLength };
}

async function main() {
  const files = (await readdir(MODEL_DIR)).filter((name) => name.endsWith('.glb'));
  files.sort();

  let totalBefore = 0;
  let totalAfter = 0;
  const failures = [];

  for (const file of files) {
    try {
      const result = await optimise(file);
      totalBefore += result.before;
      totalAfter += result.after;
      if (result.skipped) {
        console.log(`  ${file.padEnd(24)} ${format(result.before).padStart(10)}  (already quantised)`);
      } else {
        const saved = 1 - result.after / result.before;
        console.log(
          `  ${file.padEnd(24)} ${format(result.before).padStart(10)} -> ${format(result.after).padStart(10)}` +
            `  (${(saved * 100).toFixed(0)}% smaller)`,
        );
      }
    } catch (error) {
      failures.push({ file, error });
      console.error(`  ${file.padEnd(24)} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log('');
  console.log(
    `  ${files.length} models: ${format(totalBefore)} -> ${format(totalAfter)} ` +
      `(${(100 - (totalAfter / totalBefore) * 100).toFixed(0)}% smaller)${CHECK_ONLY ? '  [check only]' : ''}`,
  );
  if (failures.length > 0) {
    console.error(`\n  ${failures.length} model(s) failed and were left untouched.`);
    process.exitCode = 1;
  }
}

await main();
