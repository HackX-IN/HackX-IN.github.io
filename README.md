# my-portfolio

Personal portfolio of [Inamul Hasan](https://github.com/HackX-IN). One HTML page, vanilla JS, Tailwind CSS compiled at build time (no runtime CDN).

Live: https://hackx-in.github.io/my-portfolio/

## Features

- Signature SVG preloader, scroll-drawn "thread" that links the sections, pull-to-untangle contact interaction
- Interactive project cards with small micro-animations
- Keyboard accessible (focus trap in the modal, Esc to close) and honors `prefers-reduced-motion`
- Single output file, about 90 KB, no framework and no runtime dependencies

## Develop

```bash
npm ci
npm run build      # -> dist/index.html (Tailwind purged, minified, inlined)
npm run verify     # sanity checks on the built file
npm run check      # build + verify
npm run preview    # build and serve dist/ locally
```

Edit `src/index.html`. Tailwind is configured in `tailwind.config.js` (palette and fonts); `src/tailwind.css` only holds the directives. The `<!--TAILWIND_CSS-->` placeholder in `<head>` is replaced with the compiled stylesheet by `scripts/build.mjs`. Bespoke effects (thread, preloader, tangle) live in the page's own `<style>`/`<script>`.

## Deploy

Pushing to `main` runs `.github/workflows/pages.yml` (install, build, verify, deploy `dist/` to GitHub Pages). In the repo go to Settings > Pages and set Source to **GitHub Actions**.

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
