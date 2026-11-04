/**
 * Writes the encrypted Foundry keystore of an EVM key file, so the bash scripts sign with
 * `--keystore <file> --password-file <file>` and the private key never appears on a command line:
 *
 *   node scripts/evm-keystore.ts <name>
 *
 * Reads `EVM_PRIVATE_KEY` (or `EVM_DEPLOYER_PRIVATE_KEY`) from `$ROSE_CONFIG_DIR/<name>.env` and
 * writes `$ROSE_CONFIG_DIR/keystores/<name>.json` and a random `<name>.password` (files mode 600,
 * directory 700), once: an existing keystore is reused when it still decrypts to the same key.
 * Prints `keystore=<path>`, `password_file=<path>` and `address=<0x…>` on stdout, never the key.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Hex } from "viem";
import { CONFIG_DIR, readEnvFile } from "./lib/env.ts";
import { decryptKeystore, encryptKeystore, keystoreAddress, type KeystoreV3 } from "./lib/keystore.ts";

const name = process.argv[2];
if (name === undefined || !/^[a-z0-9-]+$/.test(name) || process.argv.length > 3) {
  process.stderr.write("usage: node scripts/evm-keystore.ts <name of ~/.config/rose/<name>.env>\n");
  process.exit(2);
}

const values = readEnvFile(join(CONFIG_DIR, `${name}.env`));
const key = values.get("EVM_PRIVATE_KEY") ?? values.get("EVM_DEPLOYER_PRIVATE_KEY");
if (key === undefined || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  process.stderr.write(`no EVM_PRIVATE_KEY or EVM_DEPLOYER_PRIVATE_KEY in ${name}.env\n`);
  process.exit(1);
}
const privateKey = key.toLowerCase() as Hex;

const dir = join(CONFIG_DIR, "keystores");
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const keystoreFile = join(dir, `${name}.json`);
const passwordFile = join(dir, `${name}.password`);

function current(): KeystoreV3 | null {
  if (!existsSync(keystoreFile) || !existsSync(passwordFile)) return null;
  const keystore = JSON.parse(readFileSync(keystoreFile, "utf8")) as KeystoreV3;
  try {
    return decryptKeystore(keystore, readFileSync(passwordFile, "utf8")) === privateKey ? keystore : null;
  } catch {
    return null;
  }
}

let keystore = current();
if (keystore === null) {
  const password = randomBytes(32).toString("hex");
  keystore = encryptKeystore(privateKey, password);
  writeFileSync(passwordFile, password, { mode: 0o600 });
  writeFileSync(keystoreFile, `${JSON.stringify(keystore)}\n`, { mode: 0o600 });
}
chmodSync(passwordFile, 0o600);
chmodSync(keystoreFile, 0o600);
process.stdout.write(`keystore=${keystoreFile}\npassword_file=${passwordFile}\naddress=${keystoreAddress(keystore)}\n`);
