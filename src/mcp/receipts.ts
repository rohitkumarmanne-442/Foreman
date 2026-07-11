import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { KEYS_DIR, ensureDirs } from "../paths.js";

const PRIV = () => path.join(KEYS_DIR(), "ed25519-private.pem");
const PUB = () => path.join(KEYS_DIR(), "ed25519-public.pem");

export function loadOrCreateKeys(): { privateKey: crypto.KeyObject; publicKeyB64: string } {
  ensureDirs();
  if (!fs.existsSync(PRIV())) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    fs.writeFileSync(PRIV(), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    fs.writeFileSync(PUB(), publicKey.export({ type: "spki", format: "pem" }));
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(PRIV(), "utf8"));
  const publicKey = crypto.createPublicKey(privateKey);
  const publicKeyB64 = (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
  return { privateKey, publicKeyB64 };
}

export function sha256(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

/** Stable stringify — sorted keys so hashes/signatures are canonical. */
export function canonical(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export interface ReceiptBody {
  receipt_id: string;
  ts: string;
  server: string;
  method: string;
  tool?: string;
  params_hash: string;
  result_hash: string;
  ms: number;
  ok: boolean;
}

export function signReceipt(body: ReceiptBody): { sig: string; pk: string } {
  const { privateKey, publicKeyB64 } = loadOrCreateKeys();
  const sig = crypto.sign(null, Buffer.from(canonical(body), "utf8"), privateKey).toString("base64");
  return { sig, pk: publicKeyB64 };
}

export function verifyReceipt(body: ReceiptBody, sigB64: string, pkB64: string): boolean {
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(pkB64, "base64"),
      format: "der",
      type: "spki",
    });
    return crypto.verify(
      null,
      Buffer.from(canonical(body), "utf8"),
      publicKey,
      Buffer.from(sigB64, "base64")
    );
  } catch {
    return false;
  }
}
