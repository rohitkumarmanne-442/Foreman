import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const FOREMAN_HOME =
  process.env.FOREMAN_HOME || path.join(os.homedir(), ".foreman");

export const EVENTS_DIR = () => path.join(FOREMAN_HOME, "events");
export const KEYS_DIR = () => path.join(FOREMAN_HOME, "keys");
export const BASELINES_DIR = () => path.join(FOREMAN_HOME, "mcp-baselines");

export function ensureDirs(): void {
  for (const d of [FOREMAN_HOME, EVENTS_DIR(), KEYS_DIR(), BASELINES_DIR()]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export const DEFAULT_PORT = 4517;
