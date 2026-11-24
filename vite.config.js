import { defineConfig } from 'vite'
import { libraryApi } from './server/library-api.js'

export default defineConfig({
  base: './',
  plugins: [libraryApi()],
  server: {
    port: 5181,
    open: false,
    // Texts a reader adds are written here while a build runs; a change in
    // this folder must not reload the page under them.
    watch: { ignored: ['**/data/library/**'] }
  }
})
