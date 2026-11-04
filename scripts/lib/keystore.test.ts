import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAddress } from "viem/accounts";
import { decryptKeystore, encryptKeystore, keystoreAddress } from "./keystore.ts";

const KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

await test("a keystore decrypts to the key it encrypted and names its address", () => {
  const keystore = encryptKeystore(KEY, "correct horse");
  assert.equal(decryptKeystore(keystore, "correct horse"), KEY);
  assert.equal(keystoreAddress(keystore), privateKeyToAddress(KEY).toLowerCase());
  assert.equal(keystore.crypto.kdf, "scrypt");
  assert.equal(keystore.crypto.cipher, "aes-128-ctr");
});

await test("a wrong password is refused by the MAC", () => {
  const keystore = encryptKeystore(KEY, "correct horse");
  assert.throws(() => decryptKeystore(keystore, "battery staple"), /MAC mismatch/);
});

await test("the encryption is deterministic for a fixed salt and iv", () => {
  const fixed = { salt: new Uint8Array(32).fill(1), iv: new Uint8Array(16).fill(2), id: "00000000-0000-4000-8000-000000000000" };
  assert.deepEqual(encryptKeystore(KEY, "pw", fixed), encryptKeystore(KEY, "pw", fixed));
});
