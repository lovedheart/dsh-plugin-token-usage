/**
 * Zstandard frame scanner for DSH session logs.
 *
 * DSH persists each session as a concatenation of independent, checksummed
 * zstd frames (one header frame + one frame per append batch). Node's
 * `zstdDecompressSync` decodes a single frame, so we locate frame boundaries
 * first and decode each range separately.
 *
 * The scan logic mirrors `scanZstdFrames` from
 * `@deepseek-ai/dsh-session-persistence-jsonl` (the package that writes these
 * files) so the walker is structurally identical to the authoritative reader.
 *
 * @module dsh-plugin-token-usage/frames
 */

const ZSTD_MAGIC = 0xfd2fb528;

/**
 * Locate complete zstd frames in a concatenated stream.
 *
 * @param {Uint8Array} buffer - raw file contents
 * @returns {{start:number, end:number}[]} inclusive-exclusive byte ranges,
 *   in file order. A torn trailing frame (write interrupted) is simply not
 *   included — callers treat it as "nothing new yet".
 * @throws {Error} on corrupt structure (bad magic / reserved bits / reserved
 *   block type) — the caller should skip the file and report the error.
 */
export function splitZstdFrames(buffer) {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZSTD_MAGIC) {
    throw new Error('not a zstd file: bad magic');
  }
  const ranges = [];
  let offset = 0;
  // `torn` abandons the in-progress trailing frame (write interrupted) while
  // keeping every frame completed before it — mirroring DSH's tornStart.
  let torn = false;
  while (offset < buffer.length && !torn) {
    const start = offset;
    if (buffer.length - offset < 4) {
      torn = true;
      break;
    }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt zstd: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset >= buffer.length) {
      torn = true;
      break;
    }
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt zstd: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) {
      torn = true;
      break;
    }
    offset += remainingHeaderBytes;
    let lastBlock = false;
    for (;;) {
      if (buffer.length - offset < 3) {
        torn = true;
        break;
      }
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`corrupt zstd: reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) {
        torn = true;
        break;
      }
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (torn) break;
    if (checksum) {
      if (buffer.length - offset < 4) {
        torn = true;
        break;
      }
      offset += 4;
    }
    ranges.push(buffer.subarray(start, offset));
  }
  return ranges;
}
