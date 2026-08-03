import { defineConfig } from 'tsup'

// Bundling (rather than plain `tsc`) because the source uses extensionless
// relative imports, which Node's ESM loader rejects. Dependencies stay external
// — several are native (sharp, patchright) and must resolve at runtime.
export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true
  // No shebang banner here: src/cli.ts already starts with one and esbuild
  // preserves it. Adding a banner too emits a second, which is a syntax error.
})
