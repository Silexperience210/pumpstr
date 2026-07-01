/**
 * validation.ts — validation pure des entrées du node Pumpstr.
 * Aucune dépendance runtime ; testable sans réseau.
 */
import { nip19 } from "nostr-tools";

export const MAX_SATS = 100_000_000_000n;
export const MIN_SATS = 1n;
export const DUST_SATS = 330;

export function parseSats(value: unknown, opts: { min?: bigint; max?: bigint } = {}): bigint {
  const min = opts.min ?? MIN_SATS;
  const max = opts.max ?? MAX_SATS;

  let b: bigint;
  if (typeof value === "bigint") {
    b = value;
  } else if (typeof value === "string") {
    const n = Number(value.trim());
    if (!Number.isFinite(n) || Number.isNaN(n) || !Number.isInteger(n) || n <= 0) throw new Error("montant invalide");
    b = BigInt(n);
  } else if (typeof value === "number") {
    if (!Number.isFinite(value) || Number.isNaN(value) || !Number.isInteger(value)) throw new Error("montant invalide");
    if (value <= 0) throw new Error("montant doit être un entier positif");
    b = BigInt(value);
  } else {
    throw new Error("montant manquant");
  }

  if (b < min) throw new Error(`montant trop faible (min ${min} sats)`);
  if (b > max) throw new Error(`montant trop élevé (max ${max} sats)`);
  return b;
}

export function parsePubkey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return t.toLowerCase();
  try {
    const d = nip19.decode(t);
    if (d.type === "npub") return d.data as string;
  } catch { /* pas un npub */ }
  return null;
}

export function requirePubkey(value: unknown): string {
  const pk = parsePubkey(value);
  if (!pk) throw new Error("pubkey/npub invalide");
  return pk;
}

export function sanitizeString(value: unknown, maxLen: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, maxLen);
}

export function parseComment(value: unknown): string {
  return sanitizeString(value, 140);
}

export function parseName(value: unknown): string {
  const n = sanitizeString(value, 24, "anon");
  return n || "anon";
}

export function parseLnAddressUser(value: unknown): string {
  const s = sanitizeString(value, 32, "pay").toLowerCase();
  if (!/^[a-z0-9-_]+$/.test(s)) throw new Error("identifiant lightning address invalide");
  return s;
}

// H1 : helper d'échappement HTML (utilisé dans server.ts avant broadcast)
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
