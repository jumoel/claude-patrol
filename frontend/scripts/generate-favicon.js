#!/usr/bin/env node

/**
 * Generates PNG favicons from the SVG source.
 * Requires: pnpm add -D sharp
 * Usage: node scripts/generate-favicon.js
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, '..', 'public');
const svgPath = resolve(publicDir, 'favicon.svg');

// index.html links only these two; add a size here and in index.html together.
const sizes = [16, 32];

async function main() {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.error('sharp is not installed. Run: pnpm add -D sharp');
    process.exit(1);
  }

  const svgBuffer = readFileSync(svgPath);

  for (const size of sizes) {
    const png = await sharp(svgBuffer).resize(size, size).png().toBuffer();

    const outPath = resolve(publicDir, `favicon-${size}.png`);
    writeFileSync(outPath, png);
    console.log(`Generated favicon-${size}.png`);
  }

  console.log('Done.');
}

main();
