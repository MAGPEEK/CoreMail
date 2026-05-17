import type { Config } from 'tailwindcss';
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: 'rgb(var(--color-accent, 0 120 212) / <alpha-value>)',
          hover:   'rgb(var(--color-accent, 0 120 212) / 0.85)',
        },
        gray: {
          950: '#0a0f1a',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
