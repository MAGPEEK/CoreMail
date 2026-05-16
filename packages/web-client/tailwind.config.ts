import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // CSS-Variable-basierter Accent — ermöglicht dynamische Farbwechsel.
        // RGB-Werte werden via --color-accent auf <html> gesetzt.
        // Das /[alpha] Opacity-Modifier Pattern (bg-accent/10) funktioniert
        // mit dem "<channels> / <alpha-value>" Tailwind-Muster.
        accent: {
          DEFAULT: 'rgb(var(--color-accent, 0 120 212) / <alpha-value>)',
          hover:   'rgb(var(--color-accent, 0 120 212) / 0.85)',
          active:  'rgb(var(--color-accent, 0 120 212) / 0.7)',
          light:   'rgb(var(--color-accent, 0 120 212) / 0.08)',
        },
      },
      fontFamily: {
        sans: ['"Segoe UI"', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
