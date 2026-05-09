/**
 * Response Store — persists assistant response bodies to disk so that
 * `clawrouter share last` can recover them across proxy restarts.
 *
 * Storage format: append-only daily JSONL, mirroring src/logger.ts.
 * Path: ~/.openclaw/blockrun/responses/responses-YYYY-MM-DD.jsonl
 *
 * Privacy: opt out by setting BLOCKRUN_RESPONSE_STORE=off. Errors during
 * append are swallowed so they never break the proxy request flow.
 */

import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface ResponseEntry {
  /** Stable id used by `share <id>`. Format: `resp_<ms>_<hex6>`. */
  id: string;
  /** ISO timestamp of when the entry was persisted. */
  timestamp: string;
  /** Session id (from x-session-id header) if available. */
  sessionId?: string;
  /** The model that produced the response. */
  model?: string;
  /** Truncated user prompt — surfaces in `share list`. */
  requestSummary: string;
  /** The full assistant response text. */
  responseText: string;
}

const STORE_DIR = join(homedir(), ".openclaw", "blockrun", "responses");
let dirReady = false;

function isEnabled(): boolean {
  const v = process.env.BLOCKRUN_RESPONSE_STORE;
  return !v || v.toLowerCase() !== "off";
}

async function ensureDir(): Promise<void> {
  if (dirReady) return;
  await mkdir(STORE_DIR, { recursive: true });
  dirReady = true;
}

function dailyFile(date: Date = new Date()): string {
  const iso = date.toISOString().slice(0, 10);
  return join(STORE_DIR, `responses-${iso}.jsonl`);
}

function genId(): string {
  return `resp_${Date.now()}_${randomBytes(3).toString("hex")}`;
}

export function summarizeRequest(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + "…";
}

/** Persist one response. Errors are swallowed; never throws. */
export async function appendResponse(
  entry: Omit<ResponseEntry, "id" | "timestamp">,
): Promise<string | null> {
  if (!isEnabled()) return null;
  if (!entry.responseText || entry.responseText.length === 0) return null;
  const id = genId();
  const timestamp = new Date().toISOString();
  const full: ResponseEntry = { id, timestamp, ...entry };
  try {
    await ensureDir();
    await appendFile(dailyFile(), JSON.stringify(full) + "\n");
    return id;
  } catch {
    return null;
  }
}

async function readDailyFile(file: string): Promise<ResponseEntry[]> {
  try {
    const text = await readFile(file, "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as ResponseEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is ResponseEntry => e !== null);
  } catch {
    return [];
  }
}

/** Returns most recent entries first, across the most recent N days of files. */
export async function listRecent(limit = 20, daysBack = 7): Promise<ResponseEntry[]> {
  if (!isEnabled()) return [];
  try {
    await ensureDir();
    const files = await readdir(STORE_DIR);
    const today = new Date();
    const candidateFiles: string[] = [];
    for (let i = 0; i < daysBack; i++) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      const iso = d.toISOString().slice(0, 10);
      const name = `responses-${iso}.jsonl`;
      if (files.includes(name)) candidateFiles.push(join(STORE_DIR, name));
    }
    const all: ResponseEntry[] = [];
    for (const f of candidateFiles) {
      all.push(...(await readDailyFile(f)));
    }
    all.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    return all.slice(0, limit);
  } catch {
    return [];
  }
}

/** Get the most recent entry, optionally preferring entries with a matching sessionId. */
export async function getLast(sessionId?: string): Promise<ResponseEntry | null> {
  const recent = await listRecent(50);
  if (recent.length === 0) return null;
  if (sessionId) {
    const match = recent.find((e) => e.sessionId === sessionId);
    if (match) return match;
  }
  return recent[0];
}

/** Get a specific entry by id. */
export async function getById(id: string): Promise<ResponseEntry | null> {
  const recent = await listRecent(500);
  return recent.find((e) => e.id === id) ?? null;
}
