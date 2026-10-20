// Renders the SVG app icons to the PNG sizes needed by the PWA manifest, iOS
// and electron-builder. Needs Playwright with Chromium: `npx playwright install chromium`.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { chromium } = await import('playwright');

const jobs = [
  { svg: 'app/icons/icon.svg', out: 'app/icons/icon-192.png', size: 192 },
  { svg: 'app/icons/icon.svg', out: 'app/icons/icon-512.png', size: 512 },
  { svg: 'app/icons/icon-maskable.svg', out: 'app/icons/icon-maskable-512.png', size: 512 },
  { svg: 'app/icons/icon-maskable.svg', out: 'app/icons/apple-touch-icon.png', size: 180 },
  { svg: 'app/icons/icon.svg', out: 'build/icon.png', size: 1024 },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const job of jobs) {
  const svg = await readFile(path.join(root, job.svg), 'utf8');
  await page.setViewportSize({ width: job.size, height: job.size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${job.size}" height="${job.size}" `)}</body></html>`,
  );
  await page.screenshot({ path: path.join(root, job.out), omitBackground: true, clip: { x: 0, y: 0, width: job.size, height: job.size } });
  console.log(`${job.out} (${job.size}px)`);
}
await browser.close();
