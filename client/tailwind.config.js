/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ground: {
          DEFAULT: '#EFF2EE',
          dark: '#0E1211'
        },
        surface: {
          DEFAULT: '#FFFFFF',
          dark: '#171C1A',
          2: '#E3E9E1',
          '2-dark': '#212824'
        },
        ink: {
          DEFAULT: '#14181A',
          dark: '#E6ECE7'
        },
        accent: {
          DEFAULT: '#1B7A5A',
          dark: '#46C296',
          soft: '#D9EDE5',
          'soft-dark': '#16342A'
        },
        wrong: {
          DEFAULT: '#B93E33',
          dark: '#E2726A',
          soft: '#F6DEDB',
          'soft-dark': '#3A201E'
        },
        line: {
          DEFAULT: '#D2DACF',
          dark: '#2A322E'
        }
      },
      fontFamily: {
        sans: ['Archivo', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['IBM Plex Mono', 'monospace'],
      }
    },
  },
  plugins: [],
}
