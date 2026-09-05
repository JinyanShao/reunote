/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          bg: 'var(--ink-bg)',
          panel: 'var(--ink-panel)',
          panel2: 'var(--ink-panel-2)',
          border: 'var(--ink-border)',
          text: 'var(--ink-text)',
          muted: 'var(--ink-muted)',
          accent: 'var(--ink-accent)',
          accentSoft: 'var(--ink-accent-soft)',
          canvas: 'var(--ink-canvas)',
        },
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Text"',
          '"PingFang SC"',
          '"Helvetica Neue"',
          'Inter',
          'sans-serif',
        ],
        serif: ['"Songti SC"', 'Georgia', 'serif'],
        mono: ['"SF Mono"', 'Menlo', 'Consolas', 'monospace'],
        hand: ['"Xingkai SC"', '"Hanzipen SC"', 'Bradley Hand', 'cursive'],
      },
      boxShadow: {
        panel: '0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.08)',
        float: '0 2px 6px rgba(0,0,0,0.06), 0 12px 36px rgba(0,0,0,0.14)',
        card: '0 1px 3px rgba(0,0,0,0.06)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'pop-in': {
          from: { opacity: '0', transform: 'scale(0.96) translateY(4px)' },
          to: { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-400px 0' },
          '100%': { backgroundPosition: '400px 0' },
        },
      },
      animation: {
        'fade-in': 'fade-in .16s ease-out',
        'pop-in': 'pop-in .14s cubic-bezier(.2,.9,.3,1.2)',
        shimmer: 'shimmer 1.4s linear infinite',
      },
    },
  },
  plugins: [],
}
