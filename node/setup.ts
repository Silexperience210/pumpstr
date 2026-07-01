/**
 * setup.ts — Wizard de première configuration du node Pumpstr.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sendJson, readBody, parseJson } from "./http-helpers.js";
import { RateLimiter, rateLimitKey } from "./rate-limit.js";
import type { PumpstrDb } from "./db.js";

export interface SetupDeps {
  db: PumpstrDb;
  envPath: string;
  here: string;
  onComplete: () => void;
}

function detectExposure(): { mode: "local" | "tailscale" | "public"; ips: string[]; tailscaleIp?: string } {
  const { networkInterfaces } = require("node:os");
  const ips: string[] = [];
  let tailscaleIp: string | undefined;
  const ifaces = networkInterfaces() ?? {};
  for (const key of Object.keys(ifaces)) {
    const nets = ifaces[key];
    for (const n of nets ?? []) {
      if (n.family === "IPv4" && !n.internal) {
        ips.push(n.address);
        if (n.address.startsWith("100.")) tailscaleIp = n.address;
      }
    }
  }
  const mode: "local" | "tailscale" | "public" = tailscaleIp ? "tailscale" : ips.length > 0 ? "public" : "local";
  return { mode, ips, tailscaleIp };
}

async function checkDomainAvailability(domain: string): Promise<{ available: boolean; price?: number; currency?: string }> {
  try {
    const r = await fetch(`https://api.whoisjson.com/v1/whois?domain=${encodeURIComponent(domain)}`, { timeout: 10000 } as any);
    const data: any = await r.json();
    const available = data?.raw?.includes("No match") || data?.raw?.includes("NOT FOUND") || data?.raw?.includes("Domain not found");
    return { available, price: 12.99, currency: "USD" };
  } catch {
    return { available: false };
  }
}

async function purchaseDomainNamecheap(
  domain: string,
  years: number,
  apiUser: string,
  apiKey: string,
  clientIp: string
): Promise<{ success: boolean; orderId?: string; error?: string }> {
  const endpoint = "https://api.namecheap.com/xml.response";
  const params = new URLSearchParams({
    ApiUser: apiUser,
    ApiKey: apiKey,
    UserName: apiUser,
    ClientIp: clientIp,
    Command: "namecheap.domains.create",
    DomainName: domain,
    Years: String(years),
  });
  try {
    const r = await fetch(`${endpoint}?${params.toString()}`);
    const text = await r.text();
    if (text.includes("<IsSuccess>true</IsSuccess>")) {
      const orderMatch = text.match(/<OrderId>(\d+)<\/OrderId>/);
      return { success: true, orderId: orderMatch?.[1] };
    }
    return { success: false, error: "Namecheap API error" };
  } catch (e: any) {
    return { success: false, error: e?.message ?? String(e) };
  }
}

function generateCaddyfile(domain: string, email: string, upstreamPort: number): string {
  return `${domain} {\n  reverse_proxy localhost:${upstreamPort}\n  tls ${email}\n  header /* {\n    X-Frame-Options "SAMEORIGIN"\n    X-Content-Type-Options "nosniff"\n    Referrer-Policy "strict-origin-when-cross-origin"\n  }\n}\n`;
}

export function createSetupHandler(deps: SetupDeps) {
  const { db, envPath, here, onComplete } = deps;
  const limiter = new RateLimiter();
  const isSetupComplete = () => db.getConfig("setup_complete") === "1";

  return async (req: any, res: any) => {
    if (isSetupComplete()) {
      res.statusCode = 404;
      return res.end("Setup already complete");
    }

    const url = new URL(req.url ?? "/", `http://localhost`);

    if (url.pathname === "/api/setup/status" && req.method === "GET") {
      const net = detectExposure();
      return sendJson(res, 200, {
        setupComplete: false,
        network: net,
        envExists: existsSync(envPath),
        steps: [
          { id: "wallet", label: "Configuration du wallet", done: false },
          { id: "network", label: "Exposition réseau", done: false },
          { id: "domain", label: "Nom de domaine (optionnel)", done: false },
          { id: "https", label: "Certificat HTTPS", done: false },
        ],
      });
    }

    if (url.pathname === "/api/setup/wallet" && req.method === "POST") {
      const rl = limiter.check(rateLimitKey(req, "setup-wallet"), { limit: 10, windowMs: 60_000 });
      if (rl.limited) return sendJson(res, 429, { error: "rate limit" });

      const body = parseJson(await readBody(req));
      const backend = body.backend ?? "arkade";
      const adminToken = body.adminToken?.trim();
      if (!adminToken || adminToken.length < 32) {
        return sendJson(res, 400, { error: "ADMIN_TOKEN doit faire au moins 32 caractères" });
      }

      if (backend === "nwc") {
        const nwcUri = body.nwcUri?.trim();
        if (!nwcUri || !nwcUri.startsWith("nostr+walletconnect://")) {
          return sendJson(res, 400, { error: "URI NWC invalide (format: nostr+walletconnect://...)" });
        }
        db.setConfig("wallet_backend", "nwc");
        db.setConfig("nwc_uri", nwcUri);
      } else if (backend === "lnd") {
        const lndHost = body.lndHost?.trim();
        const lndMacaroon = body.lndMacaroon?.trim();
        if (!lndHost || !lndMacaroon) {
          return sendJson(res, 400, { error: "LND host et macaroon requis" });
        }
        db.setConfig("wallet_backend", "lnd");
        db.setConfig("lnd_host", lndHost);
        db.setConfig("lnd_macaroon", lndMacaroon);
        if (body.lndCert) db.setConfig("lnd_cert", body.lndCert);
      } else {
        db.setConfig("wallet_backend", "arkade");
        db.setConfig("ark_server_url", body.arkServerUrl ?? "https://mutinynet.arkade.sh");
        db.setConfig("boltz_network", body.boltzNetwork ?? "mutinynet");
      }

      db.setConfig("admin_token", adminToken);
      db.setConfig("step_wallet", "1");
      return sendJson(res, 200, { ok: true, backend });
    }

    if (url.pathname === "/api/setup/network" && req.method === "POST") {
      const rl = limiter.check(rateLimitKey(req, "setup-network"), { limit: 10, windowMs: 60_000 });
      if (rl.limited) return sendJson(res, 429, { error: "rate limit" });

      const body = parseJson(await readBody(req));
      const mode = body.mode ?? "local";
      const port = Number(body.port ?? 4242);
      const httpsPort = Number(body.httpsPort ?? 4243);

      db.setConfig("network_mode", mode);
      db.setConfig("port", String(port));
      db.setConfig("https_port", String(httpsPort));
      db.setConfig("step_network", "1");

      return sendJson(res, 200, { ok: true, mode, port, httpsPort });
    }

    if (url.pathname === "/api/setup/domain/check" && req.method === "GET") {
      const domain = url.searchParams.get("domain")?.trim().toLowerCase();
      if (!domain || !/^[a-z0-9-]+\.[a-z]{2,}$/.test(domain)) {
        return sendJson(res, 400, { error: "domaine invalide (ex: monlive.com)" });
      }
      const result = await checkDomainAvailability(domain);
      return sendJson(res, 200, result);
    }

    if (url.pathname === "/api/setup/domain" && req.method === "POST") {
      const rl = limiter.check(rateLimitKey(req, "setup-domain"), { limit: 5, windowMs: 60_000 });
      if (rl.limited) return sendJson(res, 429, { error: "rate limit" });

      const body = parseJson(await readBody(req));
      const domain = body.domain?.trim().toLowerCase();
      const provider = body.provider ?? "namecheap";

      if (!domain || !/^[a-z0-9-]+\.[a-z]{2,}$/.test(domain)) {
        return sendJson(res, 400, { error: "domaine invalide" });
      }

      const check = await checkDomainAvailability(domain);
      if (!check.available) {
        return sendJson(res, 400, { error: "Domaine non disponible ou vérification impossible" });
      }

      if (provider === "namecheap") {
        const apiUser = body.namecheapApiUser?.trim();
        const apiKey = body.namecheapApiKey?.trim();
        if (!apiUser || !apiKey) {
          return sendJson(res, 400, {
            error: "Credentials Namecheap requis",
            help: "Crée un compte sur namecheap.com → Profile Tools → API Access → Enable API",
            paymentNote: "Namecheap accepte le paiement en Bitcoin (BTC) via BitPay lors du rechargement du compte",
          });
        }
        const purchase = await purchaseDomainNamecheap(domain, 1, apiUser, apiKey, req.socket?.remoteAddress ?? "127.0.0.1");
        if (!purchase.success) {
          return sendJson(res, 502, { error: purchase.error ?? "Échec de l'achat", details: purchase });
        }
        db.setConfig("domain", domain);
        db.setConfig("domain_provider", "namecheap");
        db.setConfig("domain_order_id", purchase.orderId ?? "");
        db.setConfig("step_domain", "1");
        return sendJson(res, 200, { ok: true, domain, orderId: purchase.orderId });
      }

      if (provider === "handshake") {
        db.setConfig("domain", domain);
        db.setConfig("domain_provider", "handshake");
        db.setConfig("step_domain", "1");
        return sendJson(res, 200, {
          ok: true,
          domain,
          note: "Handshake (HNS) : configure le DNS via hnsd ou un resolver HNS public. Paiement en HNS (pas en sats directement).",
        });
      }

      db.setConfig("domain", domain);
      db.setConfig("domain_provider", "manual");
      db.setConfig("step_domain", "1");
      return sendJson(res, 200, { ok: true, domain, note: "Configure un enregistrement A vers cette IP" });
    }

    if (url.pathname === "/api/setup/https" && req.method === "POST") {
      const rl = limiter.check(rateLimitKey(req, "setup-https"), { limit: 10, windowMs: 60_000 });
      if (rl.limited) return sendJson(res, 429, { error: "rate limit" });

      const body = parseJson(await readBody(req));
      const mode = body.mode ?? "auto";
      const email = body.email?.trim() ?? "admin@pumpstr.local";
      const domain = db.getConfig("domain") ?? "";
      const port = Number(db.getConfig("port") ?? 4242);

      if (mode === "auto") {
        if (!domain) {
          return sendJson(res, 400, { error: "Un nom de domaine est requis pour Let's Encrypt" });
        }
        const caddyfile = generateCaddyfile(domain, email, port);
        const caddyPath = join(here, "..", "Caddyfile");
        writeFileSync(caddyPath, caddyfile);
        db.setConfig("https_mode", "auto");
        db.setConfig("https_email", email);
        db.setConfig("step_https", "1");
        return sendJson(res, 200, { ok: true, mode: "auto", caddyfile, path: caddyPath });
      }

      if (mode === "selfsigned") {
        db.setConfig("https_mode", "selfsigned");
        db.setConfig("step_https", "1");
        return sendJson(res, 200, { ok: true, mode: "selfsigned", note: "Certificat auto-signé généré au démarrage" });
      }

      db.setConfig("https_mode", "none");
      db.setConfig("step_https", "1");
      return sendJson(res, 200, { ok: true, mode: "none" });
    }

    if (url.pathname === "/api/setup/complete" && req.method === "POST") {
      const rl = limiter.check(rateLimitKey(req, "setup-complete"), { limit: 5, windowMs: 60_000 });
      if (rl.limited) return sendJson(res, 429, { error: "rate limit" });

      const required = ["step_wallet", "step_network"];
      const missing = required.filter((k) => db.getConfig(k) !== "1");
      if (missing.length > 0) {
        return sendJson(res, 400, { error: "Étapes manquantes", missing });
      }

      const envLines: string[] = [
        "# === Pumpstr — Configuration Auto-Générée ===",
        `# Généré le ${new Date().toISOString()}`,
        "",
        `PORT=${db.getConfig("port") ?? 4242}`,
        `HTTPS_PORT=${db.getConfig("https_port") ?? 4243}`,
        `ADMIN_TOKEN=${db.getConfig("admin_token") ?? ""}`,
        `PLATFORM_SPLIT_BPS=${db.getConfig("platform_split_bps") ?? 0}`,
        "",
        "# Wallet",
        `WALLET_BACKEND=${db.getConfig("wallet_backend") ?? "arkade"}`,
      ];

      if (db.getConfig("wallet_backend") === "arkade") {
        envLines.push(`ARK_SERVER_URL=${db.getConfig("ark_server_url") ?? "https://mutinynet.arkade.sh"}`);
        envLines.push(`BOLTZ_NETWORK=${db.getConfig("boltz_network") ?? "mutinynet"}`);
      } else if (db.getConfig("wallet_backend") === "nwc") {
        envLines.push(`NWC_URI=${db.getConfig("nwc_uri") ?? ""}`);
      } else if (db.getConfig("wallet_backend") === "lnd") {
        envLines.push(`LND_HOST=${db.getConfig("lnd_host") ?? ""}`);
        envLines.push(`LND_MACAROON=${db.getConfig("lnd_macaroon") ?? ""}`);
        if (db.getConfig("lnd_cert")) envLines.push(`LND_CERT=${db.getConfig("lnd_cert")}`);
      }

      envLines.push("");
      envLines.push("# Network");
      envLines.push(`NETWORK_MODE=${db.getConfig("network_mode") ?? "local"}`);
      if (db.getConfig("domain")) {
        envLines.push(`DOMAIN=${db.getConfig("domain")}`);
        envLines.push(`LN_ADDRESS_BASE_URL=https://${db.getConfig("domain")}`);
      }

      envLines.push("");
      envLines.push("# HTTPS");
      envLines.push(`HTTPS_MODE=${db.getConfig("https_mode") ?? "none"}`);
      if (db.getConfig("https_email")) envLines.push(`HTTPS_EMAIL=${db.getConfig("https_email")}`);

      envLines.push("");
      envLines.push("# Nostr");
      envLines.push("NOSTR_RELAYS=wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net");

      envLines.push("");
      envLines.push("# Stream");
      envLines.push("STREAM_D=pumpstr-live");
      envLines.push("STREAM_TITLE=🔴 Pumpstr Live");
      envLines.push("STREAM_SUMMARY=Streaming souverain sur Bitcoin — tips en sats, en direct.");

      const nl = String.fromCharCode(10);
      writeFileSync(envPath, envLines.join(nl) + nl);
      db.setConfig("setup_complete", "1");
      onComplete();

      return sendJson(res, 200, { ok: true, message: "Setup terminé. Le serveur redémarre..." });
    }

    res.statusCode = 404;
    res.end("not found");
  };
}
