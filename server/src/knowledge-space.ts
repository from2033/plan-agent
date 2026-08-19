import crypto from "node:crypto";

// A stable, opaque directory key lets the Mac worker isolate each account
// without exposing an email address or accepting a client-selected path.
export function knowledgeSpaceIdForUser(userId: string): string {
  const encodedKey = String(process.env.DB_ENCRYPTION_KEY || "").trim();
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) throw new Error("knowledge_space_key_unavailable");
  return crypto.createHmac("sha256", key)
    .update("personal-assistant-knowledge-space\0", "utf8")
    .update(userId, "utf8")
    .digest("hex");
}
