import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { decryptBuffer, encryptBuffer } from "./crypto-field.js";

export const DOCUMENT_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
export const MAX_CHUNKED_DOCUMENT_SIZE = 1024 * 1024 * 1024;

interface UploadMetadata {
  id: string;
  ownerHash: string;
  fileName: string;
  mimeType: string;
  userNote: string;
  totalBytes: number;
  chunkSize: number;
  chunkCount: number;
  createdAt: string;
}

export interface CreateChunkedUploadInput {
  fileName: string;
  mimeType: string;
  userNote?: string;
  totalBytes: number;
}

function defaultUploadRoot(): string {
  const dbPath = process.env.DB_PATH || "./data.db";
  return process.env.DOCUMENT_CHUNK_UPLOAD_DIR
    || path.join(path.dirname(path.resolve(dbPath)), "document-upload-sessions");
}

function ownerHash(userId: string): string {
  return crypto.createHash("sha256").update(userId, "utf8").digest("hex");
}

function validUploadId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

export class ChunkedUploadStore {
  constructor(
    private readonly root = defaultUploadRoot(),
    private readonly expiresAfterMs = 24 * 60 * 60_000,
  ) {}

  create(userId: string, input: CreateChunkedUploadInput): UploadMetadata {
    if (!Number.isSafeInteger(input.totalBytes)
      || input.totalBytes <= 0
      || input.totalBytes > MAX_CHUNKED_DOCUMENT_SIZE) {
      throw new Error("invalid_total_bytes");
    }
    this.pruneExpired();
    const id = crypto.randomUUID();
    const metadata: UploadMetadata = {
      id,
      ownerHash: ownerHash(userId),
      fileName: input.fileName,
      mimeType: input.mimeType,
      userNote: input.userNote || "",
      totalBytes: input.totalBytes,
      chunkSize: DOCUMENT_UPLOAD_CHUNK_SIZE,
      chunkCount: Math.ceil(input.totalBytes / DOCUMENT_UPLOAD_CHUNK_SIZE),
      createdAt: new Date().toISOString(),
    };
    const directory = this.sessionPath(id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      this.metadataPath(id),
      encryptBuffer(Buffer.from(JSON.stringify(metadata), "utf8")),
      { mode: 0o600 },
    );
    return metadata;
  }

  writeChunk(userId: string, id: string, index: number, content: Buffer): void {
    const metadata = this.readOwned(userId, id);
    if (!Number.isSafeInteger(index) || index < 0 || index >= metadata.chunkCount) {
      throw new Error("invalid_chunk_index");
    }
    const expectedBytes = index === metadata.chunkCount - 1
      ? metadata.totalBytes - index * metadata.chunkSize
      : metadata.chunkSize;
    if (content.length !== expectedBytes) throw new Error("invalid_chunk_size");
    const finalPath = this.chunkPath(id, index);
    const temporaryPath = `${finalPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    fs.writeFileSync(temporaryPath, encryptBuffer(content), { mode: 0o600 });
    fs.renameSync(temporaryPath, finalPath);
  }

  assemble(userId: string, id: string): { metadata: UploadMetadata; content: Buffer } {
    const metadata = this.readOwned(userId, id);
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    for (let index = 0; index < metadata.chunkCount; index += 1) {
      const chunkPath = this.chunkPath(id, index);
      if (!fs.existsSync(chunkPath)) throw new Error("upload_incomplete");
      const chunk = decryptBuffer(fs.readFileSync(chunkPath));
      chunks.push(chunk);
      receivedBytes += chunk.length;
    }
    if (receivedBytes !== metadata.totalBytes) throw new Error("upload_size_mismatch");
    return { metadata, content: Buffer.concat(chunks, receivedBytes) };
  }

  remove(userId: string, id: string): void {
    this.readOwned(userId, id);
    fs.rmSync(this.sessionPath(id), { recursive: true, force: true });
  }

  private readOwned(userId: string, id: string): UploadMetadata {
    if (!validUploadId(id)) throw new Error("upload_not_found");
    const metadataPath = this.metadataPath(id);
    if (!fs.existsSync(metadataPath)) throw new Error("upload_not_found");
    const metadata = JSON.parse(
      decryptBuffer(fs.readFileSync(metadataPath)).toString("utf8"),
    ) as UploadMetadata;
    if (metadata.id !== id || metadata.ownerHash !== ownerHash(userId)) {
      throw new Error("upload_not_found");
    }
    return metadata;
  }

  private pruneExpired(): void {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const cutoff = Date.now() - this.expiresAfterMs;
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validUploadId(entry.name)) continue;
      const metadataPath = this.metadataPath(entry.name);
      try {
        if (fs.statSync(metadataPath).mtimeMs < cutoff) {
          fs.rmSync(this.sessionPath(entry.name), { recursive: true, force: true });
        }
      } catch {
        fs.rmSync(this.sessionPath(entry.name), { recursive: true, force: true });
      }
    }
  }

  private sessionPath(id: string): string {
    return path.join(this.root, id);
  }

  private metadataPath(id: string): string {
    return path.join(this.sessionPath(id), "metadata.paf");
  }

  private chunkPath(id: string, index: number): string {
    return path.join(this.sessionPath(id), `${index}.part`);
  }
}

export const chunkedUploadStore = new ChunkedUploadStore();
