/**
 * Append-only JSONL store shared by the memory engines.
 * World Model spec 5.2: "Snapshot / observation store — append-only history".
 * H-MEM spec 11.1: the trust ledger is an append-only JSONL audit trail.
 * Every stream carries a sha256 hash chain so a rewritten line is refused
 * on read and a re-issued seq is refused on append. No mutation API exists.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export class AppendOnlyError extends Error {}
export class ChainTamperError extends Error {}

export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

export function contentHash(value) {
  return "sha256:" + createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 40);
}

/** World Model spec 3: "Stable IDs derived from content" — ent_${stableHash(name.toLowerCase())}. */
export function stableHash(str) {
  return createHash("sha256").update(String(str)).digest("hex").slice(0, 16);
}

export function openAppendOnlyStore(dir) {
  fs.mkdirSync(dir, { recursive: true });

  const fileOf = (stream) => path.join(dir, `${stream}.jsonl`);
  const genesisHash = (stream) => contentHash(`genesis:${stream}`);

  function readEntries(stream) {
    const file = fileOf(stream);
    if (!fs.existsSync(file)) return [];
    const lines = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    let prev = genesisHash(stream);
    lines.forEach((line, i) => {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        throw new ChainTamperError(
          `stream '${stream}' line ${i + 1} is not valid JSON — append-only store refuses corrupted history`
        );
      }
      if (entry.seq !== i + 1) {
        throw new ChainTamperError(
          `stream '${stream}' line ${i + 1} carries seq ${entry.seq} — history was reordered or truncated`
        );
      }
      if (entry.prev_hash !== prev) {
        throw new ChainTamperError(
          `stream '${stream}' line ${i + 1} breaks the hash chain — append-only store refuses rewritten history`
        );
      }
      if (entry.record_hash !== contentHash(entry.record)) {
        throw new ChainTamperError(
          `stream '${stream}' line ${i + 1} record does not match its content hash — rewrite refused`
        );
      }
      prev = entry.record_hash;
    });
    return lines.map((l) => JSON.parse(l));
  }

  return {
    dir,

    streams() {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.slice(0, -".jsonl".length))
        .sort();
    },

    /** Append one record. A record carrying _seq is a rewrite attempt and is refused. */
    append(stream, record) {
      const entries = readEntries(stream);
      const seq = entries.length + 1;
      if (record && typeof record._seq === "number" && record._seq !== seq) {
        throw new AppendOnlyError(
          `stream '${stream}' is append-only: rewrite of seq ${record._seq} refused (head is ${entries.length})`
        );
      }
      const { _seq, ...payload } = record || {};
      const prev_hash = entries.length ? entries[entries.length - 1].record_hash : genesisHash(stream);
      const entry = { seq, prev_hash, record: payload };
      entry.record_hash = contentHash(entry.record);
      fs.appendFileSync(fileOf(stream), JSON.stringify(entry) + "\n");
      return entry;
    },

    readRecords(stream) {
      return readEntries(stream).map((e) => e.record);
    },

    readEntries(stream) {
      return readEntries(stream);
    },

    count(stream) {
      return readEntries(stream).length;
    },

    /** Deterministic digest of all persisted state. No wall clock enters it. */
    stateHash() {
      const all = {};
      for (const s of this.streams()) all[s] = readEntries(s).map((e) => e.record);
      return contentHash(all);
    },
  };
}
