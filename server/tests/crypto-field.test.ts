import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
const { decryptBuffer, encryptBuffer } = await import("../src/crypto-field.js");

test("文档二进制使用 AES-GCM 加密并可完整解密", () => {
  const source = Buffer.from("家庭合同测试\u0000\u0001", "utf8");
  const encrypted = encryptBuffer(source);
  assert.notDeepEqual(encrypted, source);
  assert.equal(encrypted.subarray(0, 4).toString("ascii"), "paf1");
  assert.deepEqual(decryptBuffer(encrypted), source);
});

test("篡改后的文档密文无法解密", () => {
  const encrypted = encryptBuffer(Buffer.from("sensitive"));
  encrypted[encrypted.length - 1] ^= 1;
  assert.throws(() => decryptBuffer(encrypted));
});
