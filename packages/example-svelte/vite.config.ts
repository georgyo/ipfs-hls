import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import stdLibBrowser from 'node-stdlib-browser'

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: Object.fromEntries(
      ['buffer', 'crypto', 'stream', 'util', 'process', 'events'].flatMap(
        (mod) => {
          const resolved = stdLibBrowser[mod]
          if (!resolved) return []
          return [
            [mod, resolved],
            [`node:${mod}`, resolved],
          ]
        },
      ),
    ),
  },
  oxc: {
    inject: {
      Buffer: ['buffer', 'Buffer'],
      global: ['globalThis'],
      process: ['process', 'default'],
    },
  },
  build: {
    target: 'esnext',
  },
})
