import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = process.env.CACHE_FILE_PATH ?? path.join(__dirname, "..", "data", "cache.json");
const CACHE_DIR = path.dirname(CACHE_FILE);

fs.mkdirSync(CACHE_DIR, { recursive: true });

interface CacheEntry {
  data: unknown;
  ts: number;
}

interface CacheStore {
  [key: string]: CacheEntry;
}

export const TTL = {
  PRICE: 15 * 60 * 1000,
  OVERVIEW: 1 * 60 * 60 * 1000,
  HISTORY: 24 * 60 * 60 * 1000,
  FINANCIALS: 7 * 24 * 60 * 60 * 1000,
};

function readStore(): CacheStore {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as CacheStore;
  } catch {
    return {};
  }
}

function writeStore(store: CacheStore): void {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(store), "utf8");
}

export function cacheGet<T>(key: string, ttlMs: number): T | null {
  const store = readStore();
  const entry = store[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > ttlMs) return null;
  return entry.data as T;
}

export function cacheSet(key: string, data: unknown): void {
  const store = readStore();
  store[key] = { data, ts: Date.now() };
  writeStore(store);
}

export function cacheKey(...parts: string[]): string {
  return parts.join(":");
}
