#!/usr/bin/env node

/**
 * Generates PNG favicons from the SVG source.
 * Requires: pnpm add -D sharp
 * Usage: node scripts/generate-favicon.js
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, '..', 'public');
const svgPath = resolve(publicDir, 'favicon.svg');

const sizes = [16, 32, 48, 180, 192, 512];

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
    const png = await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toBuffer();

    const outPath = resolve(publicDir, `favicon-${size}.png`);
    writeFileSync(outPath, png);
    console.log(`Generated favicon-${size}.png`);
  }

  // Also generate apple-touch-icon
  const apple = await sharp(svgBuffer)
    .resize(180, 180)
    .png()
    .toBuffer();
  writeFileSync(resolve(publicDir, 'apple-touch-icon.png'), apple);
  console.log('Generated apple-touch-icon.png');

  console.log('Done.');
}

main();
