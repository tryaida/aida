import type { HostAdapter, HostName } from "../types.js";
import { createVercelAdapter } from "./vercel.js";
import { createNetlifyAdapter } from "./netlify.js";
import { createAmplifyAdapter } from "./amplify.js";
import { createCloudflareAdapter } from "./cloudflare.js";
import { createNodeAdapter } from "./node.js";
import { createStaticAdapter } from "./static.js";

const factories: Record<HostName, () => HostAdapter> = {
  vercel: () => createVercelAdapter(),
  netlify: () => createNetlifyAdapter(),
  amplify: () => createAmplifyAdapter(),
  cloudflare: () => createCloudflareAdapter(),
  node: () => createNodeAdapter(),
  static: () => createStaticAdapter(),
};

/** Looks up a host adapter by name. Throws on an unknown name (typo'd `--to`/config `host` is a build error). */
export function getHostAdapter(name: string): HostAdapter {
  const factory = factories[name as HostName];
  if (!factory) throw new Error(`Unknown publish host "${name}". Known: ${listHosts().join(", ")}`);
  return factory();
}

export function listHosts(): HostName[] {
  return Object.keys(factories) as HostName[];
}
