/**
 * db.ts — persistance SQLite embarquée pour le node Pumpstr.
 *
 * Remplace les variables en mémoire (`recentTips`) et le fichier `.rewards.json`
 * par une base relationnelle locale, sans dépendance externe (Redis/Postgres).
 *
 * Tables :
 * - tips : tips reçus (temps réel + simulate)
 * - rewards : escrow réclamables créés par le créateur
 * - live_state : persistance de la cagnotte du live courant (M4)
 */
import Database from "better-sqlite3";
import { join } from "node:path";

export interface TipRow {
  id: number;
  amount: number;
  name: string;
  picture?: string | null;
  pubkey?: string | null;
  comment?: string | null;
  via: string;
  createdAt: number;
}

export interface RewardRow {
  id: string;
  to: string;
  npub: string;
  amount: number;
  reason: string;
  ref: string;
  createdAt: number;
  claimed: number;
}

export class PumpstrDb {
  db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
    // H7 : checkpoint WAL périodique (toutes les 10 min via setInterval externe)
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        amount INTEGER NOT NULL,
        name TEXT NOT NULL,
        picture TEXT,
        pubkey TEXT,
        comment TEXT,
        via TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tips_created ON tips(createdAt DESC);

      CREATE TABLE IF NOT EXISTS rewards (
        id TEXT PRIMARY KEY,
        "to" TEXT NOT NULL,
        npub TEXT NOT NULL,
        amount INTEGER NOT NULL,
        reason TEXT NOT NULL,
        ref TEXT NOT NULL UNIQUE,
        createdAt INTEGER NOT NULL,
        claimed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_rewards_to_claimed ON rewards("to", claimed);
      CREATE INDEX IF NOT EXISTS idx_rewards_created ON rewards(createdAt DESC);

      CREATE TABLE IF NOT EXISTS live_state (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  // M4 : persistance de la cagnotte du live
  getLivePot(): number {
    const row = this.db.prepare("SELECT value FROM live_state WHERE key = 'pot'").get() as { value: number } | undefined;
    return row?.value ?? 0;
  }
  setLivePot(value: number) {
    this.db.prepare("INSERT INTO live_state (key, value) VALUES ('pot', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value);
  }
  resetLivePot() {
    this.db.prepare("DELETE FROM live_state WHERE key = 'pot'").run();
  }

  // H7 : checkpoint WAL manuel
  checkpoint() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  addTip(tip: Omit<TipRow, "id">): TipRow {
    const stmt = this.db.prepare(
      "INSERT INTO tips (amount, name, picture, pubkey, comment, via, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    const info = stmt.run(tip.amount, tip.name ?? null, tip.picture ?? null, tip.pubkey ?? null, tip.comment ?? null, tip.via, tip.createdAt);
    return { id: Number(info.lastInsertRowid), ...tip };
  }

  recentTips(limit = 20): TipRow[] {
    return this.db
      .prepare("SELECT * FROM tips ORDER BY createdAt DESC LIMIT ?")
      .all(limit) as TipRow[];
  }

  addReward(r: RewardRow): RewardRow {
    const stmt = this.db.prepare(
      'INSERT INTO rewards (id, "to", npub, amount, reason, ref, createdAt, claimed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    stmt.run(r.id, r.to, r.npub, r.amount, r.reason, r.ref, r.createdAt, r.claimed ? 1 : 0);
    return r;
  }

  getRewardsFor(pubkey: string, onlyUnclaimed = true): RewardRow[] {
    if (onlyUnclaimed) {
      return this.db
        .prepare('SELECT * FROM rewards WHERE "to" = ? AND claimed = 0 ORDER BY createdAt DESC')
        .all(pubkey) as RewardRow[];
    }
    return this.db
      .prepare("SELECT * FROM rewards WHERE to = ? ORDER BY createdAt DESC")
      .all(pubkey) as RewardRow[];
  }

  getRewardById(id: string): RewardRow | undefined {
    return this.db.prepare("SELECT * FROM rewards WHERE id = ?").get(id) as RewardRow | undefined;
  }

  markRewardClaimed(id: string): boolean {
    const stmt = this.db.prepare("UPDATE rewards SET claimed = 1 WHERE id = ? AND claimed = 0");
    const info = stmt.run(id);
    return info.changes > 0;
  }

  countUnclaimedRewards(pubkey: string): number {
    const row = this.db.prepare('SELECT COUNT(*) as c FROM rewards WHERE "to" = ? AND claimed = 0').get(pubkey) as { c: number };
    return row.c;
  }

  allRewards(limit = 200): RewardRow[] {
    return this.db
      .prepare("SELECT * FROM rewards ORDER BY createdAt DESC LIMIT ?")
      .all(limit) as RewardRow[];
  }

  rewardStats(): { count: number; total: number; claimed: number; unclaimed: number; unclaimedTotal: number } {
    const r = this.db.prepare(`
      SELECT COUNT(*) AS count,
        COALESCE(SUM(amount), 0) AS total,
        COALESCE(SUM(claimed), 0) AS claimed,
        COALESCE(SUM(CASE WHEN claimed = 0 THEN amount ELSE 0 END), 0) AS unclaimedTotal
      FROM rewards
    `).get() as { count: number; total: number; claimed: number; unclaimedTotal: number };
    return { ...r, unclaimed: r.count - r.claimed };
  }

  tipStats(): { count: number; total: number } {
    return this.db
      .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total FROM tips")
      .get() as { count: number; total: number };
  }

  close() {
    this.db.close();
  }
}

export function defaultDbPath(here: string): string {
  return process.env.DB_PATH ?? join(here, "pumpstr.db");
}
