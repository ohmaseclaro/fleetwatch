/**
 * In-memory store for image attachments extracted from agent JSONL files.
 *
 * Why a store instead of just passing base64 over the WebSocket?
 *  - Photos can be 3–5 MB; our WS payload cap is 1 MB
 *  - We don't want to re-transmit the same image on every list refresh
 *  - HTTP fetch gives us caching + range support for free
 *
 * Strategy: dedupe by sha256, LRU evict to keep memory bounded, serve via
 * authed HTTP endpoint. Lives only in process memory — never persisted.
 */
import { createHash } from "node:crypto";

/** Hard cap on total cached bytes; oldest entries get evicted first. */
const MAX_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MB
/** Skip any single attachment larger than this — base64 round-trip protection. */
const MAX_SINGLE_BYTES = 20 * 1024 * 1024; // 20 MB

export interface AttachmentEntry {
  buffer: Buffer;
  mediaType: string;
  sizeBytes: number;
  /** Last-accessed timestamp for LRU. */
  lastAccess: number;
}

export class AttachmentStore {
  private entries = new Map<string, AttachmentEntry>();
  private totalBytes = 0;

  /**
   * Store an attachment and return its content-addressed hash. Returns null
   * if the attachment is too large to keep.
   */
  put(buffer: Buffer, mediaType: string): string | null {
    if (buffer.byteLength > MAX_SINGLE_BYTES) return null;
    const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 32);

    // Dedupe: if we already have this hash, just refresh the LRU timestamp.
    const existing = this.entries.get(hash);
    if (existing) {
      existing.lastAccess = Date.now();
      return hash;
    }

    this.entries.set(hash, {
      buffer,
      mediaType,
      sizeBytes: buffer.byteLength,
      lastAccess: Date.now(),
    });
    this.totalBytes += buffer.byteLength;
    this.evictIfNeeded();
    return hash;
  }

  get(hash: string): AttachmentEntry | null {
    const entry = this.entries.get(hash);
    if (!entry) return null;
    entry.lastAccess = Date.now();
    return entry;
  }

  /** Drop oldest-accessed entries until under the byte cap. */
  private evictIfNeeded(): void {
    if (this.totalBytes <= MAX_TOTAL_BYTES) return;
    const sorted = Array.from(this.entries.entries()).sort(
      (a, b) => a[1].lastAccess - b[1].lastAccess,
    );
    while (this.totalBytes > MAX_TOTAL_BYTES && sorted.length > 0) {
      const [hash, entry] = sorted.shift()!;
      this.entries.delete(hash);
      this.totalBytes -= entry.sizeBytes;
    }
  }

  stats(): { count: number; bytes: number } {
    return { count: this.entries.size, bytes: this.totalBytes };
  }
}

/** Module-level singleton — one store per daemon process. */
export const attachmentStore = new AttachmentStore();
