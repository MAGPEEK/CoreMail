import type { Config } from 'tailwindcss';
import { themeColors } from './src/theme/tailwind-colors';

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Semantic, WCAG-checked tokens (src/theme/tokens.css).
      colors: themeColors,
    },
  },
  plugins: [],
} satisfies Config;
