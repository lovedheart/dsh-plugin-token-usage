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
    let mark = store.progress[file] ?? { hiSeq: -1, framesIngested: 0 };
    if (store.progress[file] === undefined && file.includes('.v4.')) {
      // First pass over a format-migrated session. Its earlier generations
      // (v2/v3) were already counted and either still sit next to the v4 file
      // or were dropped by the migration, leaving their watermark only under
      // the old path. Inherit the highest seq ever recorded for this session
      // directory, then re-decode from frame 0 (the existing crash-recovery
      // path) so migrated history is skipped by seq, never counted twice.
      const dir = file.slice(0, file.lastIndexOf('/'));
      let inherited = -1;
      for (const [path, prev] of Object.entries(store.progress)) {
        if (path.startsWith(dir + '/') && prev && typeof prev.hiSeq === 'number' && prev.hiSeq > inherited) {
          inherited = prev.hiSeq;
        }
      }
      if (inherited >= 0) mark = { hiSeq: inherited, framesIngested: 0 };
    }
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
      // Newest format first (never both, never twice): v4 roots (dsh >= 0.2.x
      // session-format migration) are authoritative and complete, so a
      // directory that has a v4 file never falls back to its frozen v3
      // snapshot; v3 roots (dsh >= 0.1.6) are picked up only when no v4 file
      // exists; v2 roots last (their watermarks already exist in
      // store.progress).
      for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl.zstd', 'session.jsonl', 'session.v3.jsonl.zstd', 'session.v3.jsonl']) {
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
