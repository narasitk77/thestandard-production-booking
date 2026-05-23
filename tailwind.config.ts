import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // App background — cool neutral for an operations-console feel.
        app: '#F6F7F9',
        // Brand accent (kept from the legacy palette — used as primary action color).
        brand: {
          primary: '#673ab7',
          'primary-hover': '#512da8',
          'primary-active': '#4527a0',
          black: '#0A0A0A',
          white: '#FFFFFF',
          gold: '#C9A84C',
          'gold-light': '#E8C96B',
        },
        // Canonical status palette — used by StatusPill and every list/badge.
        // 50 = soft surface, 500 = dot, 700 = text.
        status: {
          'requested-50': '#FEF2F2',
          'requested-500': '#EF4444',
          'requested-700': '#B91C1C',
          'assigned-50': '#FFFBEB',
          'assigned-500': '#F59E0B',
          'assigned-700': '#B45309',
          'confirmed-50': '#ECFDF5',
          'confirmed-500': '#10B981',
          'confirmed-700': '#047857',
          'completed-50': '#EFF6FF',
          'completed-500': '#3B82F6',
          'completed-700': '#1D4ED8',
          'cancelled-50': '#F8FAFC',
          'cancelled-500': '#94A3B8',
          'cancelled-700': '#475569',
        },
      },
      borderRadius: {
        // App-wide default is 8px ("rounded-lg" in Tailwind already equals 0.5rem = 8px).
        // Kept as a named alias for clarity in component code.
        card: '8px',
      },
      fontFamily: {
        sans: ['Google Sans', 'Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  // Status color names need to survive purge even when consumed via dynamic
  // class lookups (StatusPill builds class strings from the status string).
  safelist: [
    { pattern: /^(bg|text|border|ring)-status-(requested|assigned|confirmed|completed|cancelled)-(50|500|700)$/ },
  ],
  plugins: [],
}
export default config
