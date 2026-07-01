/**
 * http-helpers.ts — fonctions utilitaires HTTP pures pour le node Pumpstr.
 * Permet de les importer dans les tests sans charger tout server.ts.
 */
import type { ServerResponse, IncomingMessage } from "node:http";

export function sendJson(res: ServerResponse, code: number, body: object) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

// H8 : limite de taille du body (1 MB par défaut)
export function readBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<string> {
  return new Promise((resolve) => {
    let d = "";
    let len = 0;
    req.on("data", (c: Buffer) => {
      len += c.length;
      if (len > maxBytes) {
        req.destroy();
        resolve("");
        return;
      }
      d += c;
    });
    req.on("end", () => resolve(d));
    req.on("error", () => resolve(""));
  });
}

export function parseJson(s: string): any {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

export function parseUrl(req: IncomingMessage, defaultPort = 4242): URL {
  return new URL(req.url ?? "/", `http://localhost:${defaultPort}`);
}
