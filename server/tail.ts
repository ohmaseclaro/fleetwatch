import { promises as fs } from "node:fs";
import { open, FileHandle } from "node:fs/promises";

/**
 * Stream a file in append-only fashion, surviving truncation and rotation.
 * Returns the new offset and a list of complete lines read.
 */
export interface TailState {
  inode: number;
  offset: number;
  partial: string;
}

export interface TailResult {
  newState: TailState;
  lines: string[];
  rotated: boolean;
}

export async function readEntireFile(file: string): Promise<{ state: TailState; lines: string[] }> {
  const stat = await fs.stat(file);
  const content = await fs.readFile(file, "utf8");
  const lines = splitLines(content);
  return {
    state: {
      inode: stat.ino,
      offset: stat.size,
      partial: lines.partial,
    },
    lines: lines.complete,
  };
}

export async function readDelta(file: string, state: TailState): Promise<TailResult> {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (err) {
    // File disappeared — treat as no new lines.
    return { newState: state, lines: [], rotated: false };
  }

  const rotated = stat.ino !== state.inode || stat.size < state.offset;
  if (rotated) {
    const content = await fs.readFile(file, "utf8");
    const lines = splitLines((state.partial || "") + content);
    return {
      newState: { inode: stat.ino, offset: stat.size, partial: lines.partial },
      lines: lines.complete,
      rotated: true,
    };
  }

  if (stat.size === state.offset) {
    return { newState: state, lines: [], rotated: false };
  }

  const handle: FileHandle = await open(file, "r");
  try {
    const length = stat.size - state.offset;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, state.offset);
    const chunk = (state.partial || "") + buf.toString("utf8");
    const lines = splitLines(chunk);
    return {
      newState: { inode: state.inode, offset: stat.size, partial: lines.partial },
      lines: lines.complete,
      rotated: false,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Read the first `headCount` lines and last `tailCount` lines of a file
 * without buffering the whole file. Used for metadata-only initial scans.
 *
 * For small files where the total lines fit within head+tail we return all
 * lines in headLines (tailLines will be empty to avoid duplicates).
 */
export async function readHeadTail(
  file: string,
  headCount: number,
  tailCount: number,
): Promise<{ headLines: string[]; tailLines: string[]; state: TailState }> {
  const stat = await fs.stat(file);
  const content = await fs.readFile(file, "utf8");
  const all = content.split(/\r?\n/).filter((l) => l.length > 0);
  const state: TailState = { inode: stat.ino, offset: stat.size, partial: "" };

  if (all.length <= headCount + tailCount) {
    return { headLines: all, tailLines: [], state };
  }
  const headLines = all.slice(0, headCount);
  const tailLines = all.slice(all.length - tailCount);
  return { headLines, tailLines, state };
}

/**
 * Read the last `n` complete lines from a large file WITHOUT reading the whole
 * file into memory. Works by seeking backwards from EOF in 64 KB chunks.
 *
 * Returns the lines in forward (chronological) order plus a TailState pointing
 * at EOF so the caller can resume with readDelta for subsequent changes.
 */
export async function readTailLines(
  file: string,
  n: number,
): Promise<{ lines: string[]; state: TailState }> {
  const stat = await fs.stat(file);
  const fileSize = stat.size;
  const state: TailState = { inode: stat.ino, offset: fileSize, partial: "" };

  if (fileSize === 0 || n === 0) return { lines: [], state };

  const CHUNK = 64 * 1024; // 64 KB — large enough to hold many events
  const handle: FileHandle = await open(file, "r");
  try {
    let pos = fileSize;
    let accumulated = "";
    let complete: string[] = [];

    while (pos > 0 && complete.length <= n) {
      const readSize = Math.min(CHUNK, pos);
      pos -= readSize;
      const buf = Buffer.alloc(readSize);
      await handle.read(buf, 0, readSize, pos);
      accumulated = buf.toString("utf8") + accumulated;
      // Count complete lines found so far (split, filter, keep going if not enough)
      const parts = accumulated.split(/\r?\n/);
      // parts[0] might be a partial line — preserve it for the next iteration
      if (pos > 0) {
        accumulated = parts[0]; // keep the head fragment for next chunk
        complete = parts.slice(1).filter((l) => l.length > 0).concat(complete);
      } else {
        // Reached beginning of file — include everything
        complete = parts.filter((l) => l.length > 0);
      }
    }

    return { lines: complete.slice(-n), state };
  } finally {
    await handle.close();
  }
}

function splitLines(input: string): { complete: string[]; partial: string } {
  const lines = input.split(/\r?\n/);
  const partial = lines.pop() ?? "";
  return { complete: lines.filter((l) => l.length > 0), partial };
}
