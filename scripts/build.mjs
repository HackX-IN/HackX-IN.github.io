// Compiles Tailwind (purged + minified) and inlines it, plus the small JS modules, into
// src/index.html -> dist/index.html. Output stays a single self-contained file:
// no CDN, no runtime CSS compiler, no extra requests.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAILWIND_PLACEHOLDER = '<!--TAILWIND_CSS-->';

/** JS modules inlined as <script id="..."> at their placeholder, in this order. */
const INLINE_SCRIPTS = [
  { placeholder: '<!--PULL_JS-->', file: 'src/pull.js', id: 'pull' },
  { placeholder: '<!--SCORE_JS-->', file: 'src/score.js', id: 'score' }
];

/** Run the Tailwind CLI and return the minified CSS (the CLI prints to stdout when -o is omitted). */
function compileTailwind() {
  const bin = resolve(root, 'node_modules/.bin/tailwindcss' + (process.platform === 'win32' ? '.cmd' : ''));
  return execFileSync(bin, ['-c', 'tailwind.config.js', '-i', 'src/tailwind.css', '--minify'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === 'win32'
  });
}

function assertSinglePlaceholder(source, placeholder) {
  if (source.split(placeholder).length !== 2) throw new Error(`src/index.html must contain exactly one ${placeholder}`);
}

/** Read a module and make sure it is safe to put inside a <script> tag. */
function readInlineScript({ file }) {
  const code = readFileSync(resolve(root, file), 'utf8');
  if (/<\/script/i.test(code)) throw new Error(`${file} must not contain "</script" (it is inlined into a <script> tag)`);
  return code;
}

function build() {
  let html = readFileSync(resolve(root, 'src/index.html'), 'utf8');
  assertSinglePlaceholder(html, TAILWIND_PLACEHOLDER);
  INLINE_SCRIPTS.forEach(({ placeholder }) => assertSinglePlaceholder(html, placeholder));

  const css = compileTailwind().trim();
  if (css.length < 2000) throw new Error('Tailwind output looks empty; check tailwind.config.js content globs');

  // Replacer functions (not strings) so "$&"-style patterns in code or CSS are never interpreted.
  html = html.replace(TAILWIND_PLACEHOLDER, () => `<style id="tailwind">${css}</style>`);
  const sizes = INLINE_SCRIPTS.map(script => {
    const code = readInlineScript(script);
    html = html.replace(script.placeholder, () => `<script id="${script.id}">${code}</script>`);
    return `${script.id} ${(code.length / 1024).toFixed(1)} KB`;
  });

  const dist = resolve(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(resolve(dist, 'index.html'), html);
  writeFileSync(resolve(dist, '.nojekyll'), '');
  console.log(`dist/index.html  ${(html.length / 1024).toFixed(1)} KB  (Tailwind CSS ${(css.length / 1024).toFixed(1)} KB; inlined: ${sizes.join(', ')})`);
}

try { build(); } catch (err) { console.error('Build failed:', err.message); process.exit(1); }
