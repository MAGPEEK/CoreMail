import type { Config } from 'tailwindcss';
import { themeColors } from './src/theme/tailwind-colors';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      // Semantic, WCAG-checked tokens (src/theme/tokens.css). The accent channels are
      // set at runtime (--color-accent / --color-accent-fg, see App.tsx ThemeApplier).
      colors: themeColors,
      fontFamily: {
        sans: ['"Segoe UI"', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
