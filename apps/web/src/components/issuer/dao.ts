/**
 * "Run via DAO": the same `create_tender` call wrapped for treasuries that need an approval.
 *
 * - Sputnik DAO v2 `add_proposal` (verified live on testnet 2026-11-04, `test.sputnikv2.testnet`
 *   version 2.0.0: `{"proposal": {"description", "kind": {"FunctionCall": {"receiver_id",
 *   "actions": [{"method_name", "args": <base64 JSON>, "deposit": <yocto string>, "gas":
 *   <gas string>}]}}}}` with the attached deposit equal to `get_policy().proposal_bond`,
 *   `docs/verification.md`).
 * - A Trezu custom proposal template (manifest DSL version 1 of `NEAR-DevHub/trezu`,
 *   `docs/CUSTOM_PROPOSAL_TEMPLATES.md` at commit 7b063dd, read 2026-11-04): `binding`
 *   fixes the contract, method, deposit and gas; member inputs flow into `args` through
 *   `{{placeholders}}`, string values only.
 */

import { bytesToBase64, utf8ToBytes, type FunctionCall, type TenderArgs } from "@rose/sdk";

export type SputnikProposal = {
  proposal: {
    description: string;
    kind: { FunctionCall: { receiver_id: string; actions: { method_name: string; args: string; deposit: string; gas: string }[] } };
  };
};

/** The `add_proposal` arguments creating the Tender from the DAO account. */
export function sputnikProposal(call: FunctionCall, description: string): SputnikProposal {
  return {
    proposal: {
      description,
      kind: {
        FunctionCall: {
          receiver_id: call.receiverId,
          actions: [{ method_name: call.methodName, args: bytesToBase64(utf8ToBytes(JSON.stringify(call.args))), deposit: call.deposit.toString(), gas: call.gas.toString() }],
        },
      },
    },
  };
}

/** Yocto to a NEAR amount text accepted by near-cli-rs (`'1 NEAR'`, `'0.05 NEAR'`). */
export function yoctoToNearText(yocto: bigint): string {
  const whole = yocto / 10n ** 24n;
  const fraction = (yocto % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return fraction ? `${whole.toString()}.${fraction} NEAR` : `${whole.toString()} NEAR`;
}

/** The near-cli-rs 0.30 command filing the proposal (the bond is attached exactly, as the contract requires). */
export function sputnikCliCommand(dao: string, proposal: SputnikProposal, bondYocto: bigint, signer: string): string {
  const json = JSON.stringify(proposal).replace(/'/g, "'\\''");
  return [
    "near contract call-function as-transaction",
    dao,
    "add_proposal",
    `json-args '${json}'`,
    "prepaid-gas '100 Tgas'",
    `attached-deposit '${yoctoToNearText(bondYocto)}'`,
    `sign-as ${signer}`,
    "network-config testnet sign-with-keychain send",
  ].join(" \\\n  ");
}

export type TrezuField = { name: string; label: string; type: "account" | "token" | "uint" | "amount" | "number" | "text" | "select" | "bool" | "json"; required?: boolean; default?: string | number | boolean; help?: string };

export type TrezuManifest = {
  version: 1;
  id: string;
  title: string;
  description: string;
  summary: string;
  binding: { receiver_id: string; method_name: string; deposit: string; gas: string };
  fields: TrezuField[];
  args: Record<string, unknown>;
};

export type TrezuTemplateInput = {
  id: string;
  title: string;
  engine: string;
  call: FunctionCall;
  tender: TenderArgs;
  /** Human labels of the class and venue, for the description. */
  classLabel: string;
  venueLabel: string;
};

/**
 * A Trezu manifest for this Tender: the class, venue and retire-to are fixed by the template
 * author; budget, max price, reference price and closing time are member inputs defaulted to
 * the console's values (amounts and timestamps are digit strings, so `{{placeholders}}` resolve
 * inside string values as the DSL requires).
 */
export function trezuTemplate(input: TrezuTemplateInput): TrezuManifest {
  const { tender } = input;
  const reference = tender.referencePrice;
  return {
    version: 1,
    id: input.id,
    title: input.title,
    description: `Files engine.create_tender for class ${input.classLabel} with cash in ${input.venueLabel}; retired units pay to ${tender.retireTo}.`,
    summary: "Tender {{budget}} (cash base units) at most {{max_price}} per locked token, closing at {{closes_at}} (unix ns)",
    binding: { receiver_id: input.engine, method_name: input.call.methodName, deposit: input.call.deposit.toString(), gas: input.call.gas.toString() },
    fields: [
      { name: "budget", label: "Budget (cash base units, 6 decimals)", type: "amount", required: true, default: tender.budget.toString(), help: "The issuer escrows the budget plus 30 bps." },
      { name: "max_price", label: "Max price per whole locked token (cash base units)", type: "amount", required: true, default: tender.maxPrice.toString() },
      ...(reference !== undefined ? [{ name: "reference_price", label: "Declared reference price (cash base units)", type: "amount", required: true, default: reference.toString() } as TrezuField] : []),
      { name: "closes_at", label: "Closes at (unix nanoseconds)", type: "uint", required: true, default: tender.window.closesAt.toString(), help: "In the future, and within the engine's round horizon (get_limits max_round_horizon) of the moment the proposal executes." },
    ],
    args: {
      params: {
        class_id: tender.classId,
        venue: tender.venue,
        budget: "{{budget}}",
        max_price: "{{max_price}}",
        reference_price: reference !== undefined ? "{{reference_price}}" : null,
        retire_to: tender.retireTo,
        window: { opens_at: null, closes_at: "{{closes_at}}", key_timeout: tender.window.keyTimeout?.toString() ?? null, reveal_window: tender.window.revealWindow?.toString() ?? null },
      },
    },
  };
}

/** `[A-Za-z0-9_-]` slug for the manifest id. */
export function trezuSlug(classId: string, roundLabel: string): string {
  return `rose-tender-${roundLabel.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")}-${classId.slice(0, 8)}`;
}
