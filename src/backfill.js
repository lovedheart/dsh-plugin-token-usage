/**
 * Incremental backfill of historical usage from persisted session logs.
 *
 * DSH writes each session as `<root>/<project>/<escaped-id>/session.jsonl.zstd`
 * (or `.jsonl` with compression disabled): a concatenation of independent
 * zstd frames, one per append batch. Backfill walks the frame boundaries
 * (cheap header parsing, no decompression) and only decodes frames that were
 * not ingested before, so a large active session costs a few new frames per
 * pass.
 *
 * The per-file watermark `{hiSeq, framesIngested}` lives in `store.progress`
 * and is persisted with the aggregate buckets, so a restart resumes exactly
 * where the last run left off — history is counted once, even across the
 * crash-recovery case where the log tail is re-encoded (detected by a frame
 * count shrink and handled by re-walking from frame 0 while the hiSeq dedup
 * keeps the stable prefix from double-counting).
 *
 * @module dsh-plugin-token-usage/backfill
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { splitZstdFrames } from './frames.js';

const PACKED_ROW_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks']);

/**
 * One incremental pass over every persisted session log.
 *
 * @param {object} opts
 * @param {object} opts.store - a TokenUsageStore (progress map is read+written)
 * @param {string} opts.root - session persistence root
 * @param {(level:string, msg:string)=>void} [opts.log]
 * @returns {{scanned:number, ingested:number, skipped:number, errors:number}}
 */
export function backfillOnce({ store, root, log = () => {} }) {
  const result = { scanned: 0, ingested: 0, skipped: 0, errors: 0 };
  let files;
  try {
    files = listSessionFiles(root);
  } catch (err) {
    log('warn', `token-usage: cannot list ${root}: ${err.message}`);
    return result;
  }
  for (const file of files) {
    const mark = store.progress[file] ?? { hiSeq: -1, framesIngested: 0 };
    result.scanned += 1;
    try {
      const r = processFile(file, mark, store);
      store.progress[file] = r.mark;
      result.ingested += r.ingested;
      result.skipped += r.skipped;
    } catch (err) {
      result.errors += 1;
      log('warn', `token-usage: backfill ${file}: ${err.message}`);
    }
  }
  // Persist watermark movement even when this pass added no new usage
  // (e.g. files that grew with only packed chunk runs).
  store.flushNow();
  return result;
}

/**
 * @param {string} file
 * @param {{hiSeq:number, framesIngested:number}} mark
 * @param {object} store
 * @returns {{mark:{hiSeq:number, framesIngested?:number}, ingested:number, skipped:number}}
 */
function processFile(file, mark, store) {
  let lines;
  let frameCount;
  if (file.endsWith('.zstd')) {
    const buf = readFileSync(file);
    const frames = splitZstdFrames(buf);
    frameCount = frames.length;
    if (frameCount < mark.framesIngested) {
      // Tail was re-encoded (crash recovery) — re-walk from frame 0; the
      // hiSeq watermark still dedups the stable prefix.
      mark = { ...mark, framesIngested: 0 };
    }
    // Frame 0 always carries the header line (session id); re-decode it on
    // later passes — it is tiny (a few hundred bytes).
    const toDecode = mark.framesIngested > 0 ? [frames[0], ...frames.slice(mark.framesIngested)] : frames;
    lines = toDecode.map((f) => zstdDecompressSync(f).toString('utf8')).join('\n').split('\n');
  } else {
    frameCount = undefined;
    lines = readFileSync(file, 'utf8').split('\n');
  }
  let sessionId;
  let hiSeq = mark.hiSeq;
  let ingested = 0;
  let skipped = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue; // partial/foreign line — skip
    }
    if (ev.type === 'session') {
      sessionId = ev.id;
      continue;
    }
    if (typeof ev.type !== 'string' || typeof ev.seq !== 'number') continue;
    if (PACKED_ROW_TYPES.has(ev.type)) continue; // packed delta runs never carry usage
    if (ev.seq <= hiSeq) {
      skipped += 1;
      continue;
    }
    if (!sessionId) continue;
    ev.sessionId = sessionId;
    store.ingestEvent(ev, { key: sessionId, hiSeq });
    hiSeq = ev.seq;
    ingested += 1;
  }
  return {
    mark: frameCount !== undefined ? { hiSeq, framesIngested: frameCount } : { hiSeq },
    ingested,
    skipped,
  };
}

/** @param {string} root @returns {string[]} all session transcript files */
export function listSessionFiles(root) {
  const out = [];
  const projects = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  for (const project of projects) {
    const sessions = readdirSync(join(root, project), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const s of sessions) {
      for (const name of ['session.jsonl.zstd', 'session.jsonl']) {
        const p = join(root, project, s, name);
        try {
          if (statSync(p).isFile()) {
            out.push(p);
            break;
          }
        } catch {
          /* absent */
        }
      }
    }
  }
  return out;
}
