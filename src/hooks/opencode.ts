import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** Install the OpenCode adapter: copy the plugin into the auto-loaded
 * plugins directory (project .opencode/plugins/ or global ~/.config/...). */
export function installOpenCodeAdapter(opts: { global: boolean }): string {
  const dest = opts.global
    ? path.join(os.homedir(), ".config", "opencode", "plugins", "foreman.mjs")
    : path.join(process.cwd(), ".opencode", "plugins", "foreman.mjs");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(adapterSource(), dest);
  return dest;
}

export function uninstallOpenCodeAdapter(opts: { global: boolean }): boolean {
  const dest = opts.global
    ? path.join(os.homedir(), ".config", "opencode", "plugins", "foreman.mjs")
    : path.join(process.cwd(), ".opencode", "plugins", "foreman.mjs");
  if (!fs.existsSync(dest)) return false;
  fs.rmSync(dest);
  return true;
}

export function adapterSource(): string {
  const here = new URL(import.meta.url).pathname;
  const decoded = decodeURIComponent(here.replace(/^\/([A-Za-z]:)/, "$1"));
  // dist/hooks/opencode.js -> <pkg root>/adapters/opencode/foreman.mjs
  return path.join(path.dirname(path.dirname(path.dirname(decoded))), "adapters", "opencode", "foreman.mjs");
}
