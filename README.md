# my-portfolio

Personal portfolio of [Inamul Hasan](https://github.com/HackX-IN). One HTML page, vanilla JS, Tailwind CSS compiled at build time (no runtime CDN).

Live: https://hackx-in.github.io/

## Features

- Signature SVG preloader, scroll-drawn "thread" that links the sections, pull-to-untangle contact interaction, inline section links on wide screens, a trailing-ring cursor that turns into a labelled disc over actions (mouse only)
- Interactive project cards with small micro-animations
- Optional ambient space score, played from an astronaut badge next to MENU: synthesised live with the Web Audio API, so there are no audio files and no copyright. Off by default, never autoplays
- Keyboard accessible (focus trap in the modal, Esc to close) and honors `prefers-reduced-motion`
- Single output file, about 90 KB, no framework and no runtime dependencies

## Develop

```bash
npm ci
npm run build      # -> dist/index.html (Tailwind purged, minified, inlined)
npm run verify     # sanity checks on the built file
npm run check      # tests + build + verify (this is what CI runs)
npm test           # unit tests for the score engine and the pull gesture (node:test, no extra deps)
npm run preview    # build and serve dist/ locally
```

Edit `src/index.html`. Tailwind is configured in `tailwind.config.js` (palette and fonts); `src/tailwind.css` only holds the directives. The `<!--TAILWIND_CSS-->` placeholder in `<head>` is replaced with the compiled stylesheet by `scripts/build.mjs`. Bespoke effects (thread, preloader, tangle) live in the page's own `<style>`/`<script>`. The pull-to-untangle gesture maths (`src/pull.js`, tested in `tests/pull.test.mjs`) is inlined the same way: the pull counts in any direction, the throw is short and scales with the viewport, and a tap or quick flick also finishes it, because on phones the handle sits only ~100px above the bottom edge.

## Deploy

Pushing to `main` runs `.github/workflows/pages.yml` (install, build, verify, deploy `dist/` to GitHub Pages). In the repo go to Settings > Pages and set Source to **GitHub Actions**.

## Music

`src/score.js` is a small generative engine that plays an original, endlessly evolving piece in the spirit of cinematic space-organ music: a cathedral-organ pad, a slow rolling arpeggio in 12/8, a ticking clock, a sub drone, a rare breathy lead and the odd deep boom. Four chords (Am(add9), Fmaj7, Dm9, Esus4) loop, while a 16-bar intensity arc fades layers in and out and opens the filter as it builds, so it swells and recedes over about 75 seconds. It is inlined into the page at build time.

Tune it through the constants at the top (`BPM`, `PROGRESSION`, `ARP_PATTERNS`, `INTENSITY_CYCLE_BARS`) and the levels in the `play*` functions. The pure parts (timing, intensity arc, layer gating, melody picking, bar planning) are covered by `tests/score.test.mjs`.

Browsers only allow audio after a user gesture, so playback starts when a visitor presses the badge. The preference is remembered in `localStorage` and resumed on the first tap or key press. Audio is suspended in background tabs and the context is closed when stopped.

The astronaut badge spins while the music plays and rests when paused (no icons, one animation). It sits outside `#nav` on purpose: the header uses `mix-blend-mode: difference`, which would invert the artwork. Its classes are prefixed `sb-` because the page already has a `.chip` component.

## Security

- No backend, API keys or secrets. The contact form builds a `mailto:` link, validates input, uses a honeypot, and never writes user input via `innerHTML`.
- All external links use `rel="noopener noreferrer"`.
- Dev dependencies are minimal (Tailwind CLI only) and pinned; run `npm audit` before upgrading.

## License

Code is MIT-licensed (see `LICENSE`). The personal content (name, biography, project descriptions, copy and the signature mark) is not covered by that license: please don't reuse it as your own.

## Notes

- Contact form is `mailto:` only (no backend), with a honeypot and length limits.
- Al-Islam rating/installs are hardcoded; update them by hand.
- Tailwind is pinned to 3.4.17. v4 uses a different config model, so upgrade deliberately.
- Fonts load from Google Fonts; self-host them to remove the last third-party request.
- `prefers-reduced-motion` is honored; the preloader has JS and CSS failsafes.
- iOS Safari mutes Web Audio while the hardware silent switch is on; that is an OS behaviour, not a bug.

## Credits

- Signature: the strokes are traced from the outlines of [Great Vibes](https://fonts.google.com/specimen/Great+Vibes) by Robert Leuschke (SIL Open Font License 1.1), reduced to single pen lines and inlined as SVG paths. No font file is shipped.
