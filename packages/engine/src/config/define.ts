import type { AidaConfig } from "./types.js";

/**
 * Identity helper that gives `aida.config.ts`/`.mjs` authors type-checking
 * and editor completion. `export default defineConfig({...})`.
 */
export function defineConfig(config: AidaConfig): AidaConfig {
  return config;
}
