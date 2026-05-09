import type { Config } from 'tailwindcss';
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: { colors: { accent: { DEFAULT: '#0078D4', hover: '#106EBE' } } } },
  plugins: [],
} satisfies Config;
