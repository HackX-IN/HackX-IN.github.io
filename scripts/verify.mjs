// Production smoke test: fails the build if the output regresses to the Play CDN or ships broken CSS.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/index.html');
const html = readFileSync(file, 'utf8');
const css = (html.match(/<style id="tailwind">([\s\S]*?)<\/style>/) || [])[1] || '';

const checks = [
  ['no Tailwind Play CDN script', !/cdn\.tailwindcss\.com/.test(html)],
  ['no runtime tailwind.config', !/tailwind\.config\s*=/.test(html)],
  ['Tailwind CSS is inlined', css.length > 2000],
  ['preflight present', /box-sizing:border-box/.test(css)],
  ['nav utility compiled (z-[60])', /\.z-\\\[60\\\]\{z-index:60\}/.test(css)],
  ['custom font families compiled', /\.font-sans\{font-family:/.test(css)],
  ['no placeholder left behind', !html.includes('<!--TAILWIND_CSS-->')],
  ['single file under 200 KB', html.length < 200 * 1024],
  ['tab title is just the name', /<title>Inamul Hasan<\/title>/.test(html)],
  ['inline section links in the header', /class="nav-links"/.test(html) && /href="#stack">Capabilities/.test(html)],
  ['custom cursor present, mouse-only', /id="cursor"/.test(html) && /hover: hover\) and \(pointer: fine/.test(html)],
  ['hero thread cannot start above the viewport', /loopY > startY \+ 50/.test(html)],
  ['no innerHTML (XSS surface)', !/\.innerHTML\s*=/.test(html)],
  ['pull gesture module inlined, placeholder gone', /<script id="pull">[\s\S]*releaseAction[\s\S]*<\/script>/.test(html) && !html.includes('<!--PULL_JS-->')],
  ['untangle uses the shared gesture maths (any-direction pull)', /Pull\.pullProgress\(/.test(html) && /Pull\.releaseAction\(/.test(html) && !/Math\.max\(0, e\.clientY - startY\)/.test(html)],
  ['score engine inlined, placeholder gone', /<script id="score">[\s\S]*createPlayer[\s\S]*<\/script>/.test(html) && !html.includes('<!--SCORE_JS-->')],
  ['music is synthesised: no <audio> tag or audio file URLs', !/<audio\b|\.(mp3|ogg|wav|m4a|flac)\b/i.test(html)],
  ['music badge present and opt-in (no autoplay)', html.includes('id="sound-btn"') && !/<[^>]*\bautoplay\b/i.test(html)]
];
let failed = 0;
for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failed++; }
process.exit(failed ? 1 : 0);
