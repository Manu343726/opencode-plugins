/**
 * Package root entrypoint.
 *
 * OpenCode resolves a plugin package as `<package>/index.ts` — measured on
 * 2.0.31, and not through `package.json` `exports` or `main`: a package whose
 * only entrypoint was `exports["."]` was skipped silently, with no log line at
 * any level. The implementation stays in `src/`; this file only re-exports it
 * so both conventions work.
 */
export { default } from "./src/index.ts"
