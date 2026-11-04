#!/usr/bin/env node
// Sealed-bid helper for the end-to-end scripts: the rose-ibe wasm build (packages/ibe-wasm/pkg,
// the same artifact the browser loads) run under Node.
//
//   node scripts/ibe.mjs encrypt <mpk> <engine> <round_id> <bidder> <side 0|1> <quantity> <price>
//     -> {"ciphertext_hex": "<192 bytes>", "salt": "<16 bytes hex>"}
//   node scripts/ibe.mjs decrypt <mpk> <engine> <round_id> <key> <ciphertext_hex> <bidder> <side>
//     -> {"quantity", "limit_price", "salt", "sigma"}   (the opening is (plaintext, sigma))
//   node scripts/ibe.mjs plaintext <quantity> <price> <salt_hex>
//     -> the 48-byte plaintext hex the engine's open_bid takes
//   node scripts/ibe.mjs unwrap <engine> <round_id> <big_y> <big_c>
//     -> the round key (bls12381g1:...) unwrapped from a CKD response with the public scalar

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..", "packages", "ibe-wasm", "pkg");
const ibe = await import(join(pkg, "rose_ibe.js"));
ibe.initSync({ module: readFileSync(join(pkg, "rose_ibe_bg.wasm")) });

const [command, ...args] = process.argv.slice(2);
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const le128 = (value) => {
  const out = Buffer.alloc(16);
  let n = BigInt(value);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
};

let result;
switch (command) {
  case "encrypt": {
    const [mpk, engine, round, bidder, side, quantity, price] = args;
    const sealed = ibe.encrypt_bid(mpk, engine, BigInt(round), bidder, Number(side), quantity, price);
    result = { ciphertext_hex: hex(sealed.ciphertext), salt: sealed.salt };
    break;
  }
  case "decrypt": {
    const [mpk, engine, round, key, ciphertext, bidder, side] = args;
    result = ibe.decrypt_bid(mpk, engine, BigInt(round), key, Uint8Array.from(Buffer.from(ciphertext, "hex")), bidder, Number(side));
    break;
  }
  case "plaintext": {
    const [quantity, price, salt] = args;
    result = hex(Buffer.concat([le128(quantity), le128(price), Buffer.from(salt, "hex")]));
    break;
  }
  case "unwrap": {
    const [engine, round, bigY, bigC] = args;
    result = ibe.ckd_unwrap(engine, BigInt(round), bigY, bigC);
    break;
  }
  default:
    console.error("usage: ibe.mjs encrypt|decrypt|plaintext|unwrap ...");
    process.exit(2);
}
console.log(typeof result === "string" ? result : JSON.stringify(result));
