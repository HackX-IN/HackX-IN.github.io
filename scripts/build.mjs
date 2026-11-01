// Compiles Tailwind (purged + minified) and inlines it into src/index.html -> dist/index.html.
// Output stays a single self-contained file: no CDN, no runtime CSS compiler.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLACEHOLDER = '<!--TAILWIND_CSS-->';
const LOFI_PLACEHOLDER = '<!--LOFI_JS-->';

/** Run the Tailwind CLI and return the minified CSS (the CLI prints to stdout when -o is omitted). */
function compileTailwind() {
  const bin = resolve(root, 'node_modules/.bin/tailwindcss' + (process.platform === 'win32' ? '.cmd' : ''));
  return execFileSync(bin, ['-c', 'tailwind.config.js', '-i', 'src/tailwind.css', '--minify'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === 'win32'
  });
}

function build() {
  const source = readFileSync(resolve(root, 'src/index.html'), 'utf8');
  if (source.split(PLACEHOLDER).length !== 2) throw new Error(`src/index.html must contain exactly one ${PLACEHOLDER}`);
  const css = compileTailwind().trim();
  if (css.length < 2000) throw new Error('Tailwind output looks empty; check tailwind.config.js content globs');
  if (source.split(LOFI_PLACEHOLDER).length !== 2) throw new Error(`src/index.html must contain exactly one ${LOFI_PLACEHOLDER}`);
  const lofi = readFileSync(resolve(root, 'src/lofi.js'), 'utf8');
  if (/<\/script/i.test(lofi)) throw new Error('src/lofi.js must not contain "</script" (it is inlined into a <script> tag)');
  const html = source
    .replace(PLACEHOLDER, () => `<style id="tailwind">${css}</style>`)       // fn avoids $-pattern surprises
    .replace(LOFI_PLACEHOLDER, () => `<script id="lofi">${lofi}</script>`);
  const dist = resolve(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(resolve(dist, 'index.html'), html);
  writeFileSync(resolve(dist, '.nojekyll'), '');
  console.log(`dist/index.html  ${(html.length / 1024).toFixed(1)} KB  (Tailwind CSS ${(css.length / 1024).toFixed(1)} KB, lofi engine ${(lofi.length / 1024).toFixed(1)} KB inlined)`);
}

try { build(); } catch (err) { console.error('Build failed:', err.message); process.exit(1); }
