/**
 * Encrypted JSON keystores (Web3 Secret Storage v3: scrypt, aes-128-ctr, keccak-256 MAC), the
 * format Foundry's `--keystore <file> --password-file <file>` reads. The bash scripts sign through
 * a keystore so an EVM private key never appears on a command line (where `ps` shows it to every
 * local user); `scripts/evm-keystore.ts` writes one from a key file of `~/.config/rose`.
 */

import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { bytesToHex, hexToBytes, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";

export interface KeystoreV3 {
  version: 3;
  id: string;
  address: string;
  crypto: {
    cipher: "aes-128-ctr";
    cipherparams: { iv: string };
    ciphertext: string;
    kdf: "scrypt";
    kdfparams: { dklen: number; n: number; r: number; p: number; salt: string };
    mac: string;
  };
}

/** scrypt cost of new keystores: 2^14, the "light" parameters of geth, decrypted in well under a second. */
export const SCRYPT = { n: 16_384, r: 8, p: 1, dklen: 32 } as const;

function derive(password: string, salt: Uint8Array, params: { n: number; r: number; p: number; dklen: number }): Buffer {
  return scryptSync(password.normalize("NFKC"), salt, params.dklen, { N: params.n, r: params.r, p: params.p, maxmem: 2 ** 30 });
}

function mac(derived: Uint8Array, ciphertext: Uint8Array): Hex {
  const input = new Uint8Array(16 + ciphertext.length);
  input.set(derived.subarray(16, 32), 0);
  input.set(ciphertext, 16);
  return keccak256(input);
}

function strip(hex: Hex): string {
  return hex.slice(2);
}

/** Encrypts `privateKey` under `password`. `salt`, `iv` and `id` are random unless given (tests). */
export function encryptKeystore(privateKey: Hex, password: string, fixed: { salt?: Uint8Array; iv?: Uint8Array; id?: string } = {}): KeystoreV3 {
  const salt = fixed.salt ?? randomBytes(32);
  const iv = fixed.iv ?? randomBytes(16);
  const derived = derive(password, salt, SCRYPT);
  const cipher = createCipheriv("aes-128-ctr", derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(hexToBytes(privateKey)), cipher.final()]);
  return {
    version: 3,
    id: fixed.id ?? randomUUID(),
    address: strip(privateKeyToAddress(privateKey)).toLowerCase(),
    crypto: {
      cipher: "aes-128-ctr",
      cipherparams: { iv: strip(bytesToHex(iv)) },
      ciphertext: strip(bytesToHex(ciphertext)),
      kdf: "scrypt",
      kdfparams: { ...SCRYPT, salt: strip(bytesToHex(salt)) },
      mac: strip(mac(derived, ciphertext)),
    },
  };
}

/** Decrypts a v3 scrypt keystore; throws on a wrong password (MAC mismatch). */
export function decryptKeystore(keystore: KeystoreV3, password: string): Hex {
  const { kdfparams, cipherparams } = keystore.crypto;
  const derived = derive(password, hexToBytes(`0x${kdfparams.salt}`), kdfparams);
  const ciphertext = hexToBytes(`0x${keystore.crypto.ciphertext}`);
  const expected = hexToBytes(`0x${keystore.crypto.mac}`);
  const actual = hexToBytes(mac(derived, ciphertext));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error("wrong keystore password (MAC mismatch)");
  const decipher = createDecipheriv("aes-128-ctr", derived.subarray(0, 16), hexToBytes(`0x${cipherparams.iv}`));
  return bytesToHex(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}

export function keystoreAddress(keystore: KeystoreV3): Address {
  return `0x${keystore.address}`;
}
