/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: {
          950: '#050d1a',
          900: '#0a1628',
          800: '#0d1b30',
          700: '#0f1d31',
          600: '#132238',
          500: '#1a2d45',
        },
        gold: {
          DEFAULT: '#c9a84c',
          light: '#d4b86a',
          dim: 'rgba(201,168,76,0.45)',
          faint: 'rgba(201,168,76,0.12)',
        },
        slate: {
          terminal: '#5e768f',
          light: '#8a9ab0',
          bright: '#dce3ed',
        },
        accent: {
          blue: '#1f5673',
          purple: '#7b5ea7',
          green: '#2f6b4b',
          orange: '#d97736',
          red: '#8c2e36',
        },
      },
      fontFamily: {
        serif: ['Lora', 'Georgia', 'serif'],
        display: ['Cinzel', 'Georgia', 'serif'],
        label: ['IBM Plex Sans', 'sans-serif'],
      },
      backgroundImage: {
        'card-gradient': 'linear-gradient(135deg, #0d1b30 0%, #0a1628 100%)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.4s ease-out',
        'shimmer': 'shimmer 2s infinite',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        slideUp: { '0%': { opacity: '0', transform: 'translateY(16px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        shimmer: { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
      },
    },
  },
  plugins: [],
}
