/** @type {import('tailwindcss').Config} */
module.exports = {
  // Every Tailwind class lives in static markup; the JS only toggles hand-written classes,
  // so scanning the one source file is enough to purge everything else.
  content: ['./src/index.html'],
  theme: {
    extend: {
      colors: { ink: '#060606', cream: '#f0ebe4', thread: '#fc3814' },
      fontFamily: {
        display: ['"Inter Tight"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif']
      }
    }
  }
};
