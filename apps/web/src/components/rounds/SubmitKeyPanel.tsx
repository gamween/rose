"use client";

/**
 * "Submit the key" (spec 5.1 fallback): a round waiting for its key can take it from anyone. The
 * pasted key, `(big_y, big_c)` pair or `respond_ckd` arguments are unwrapped and verified in this
 * browser, then `submit_key` is sent (30 Tgas; the engine runs the same pairing check).
 */

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Input";
import { nearAccountUrl } from "@/lib/explorer";
import { useNearAction } from "./actions";
import { checkRoundKey, unwrapKey } from "./ibe";
import { Notice } from "./shared";
import { parseKeyInput, resolveRoundKey } from "./submit-key";
import type { RoundDetail } from "./useRoundDetail";

export function SubmitKeyPanel({ detail, onChanged }: { detail: RoundDetail; onChanged: () => void }) {
  const { round, engine, config, viewer } = detail;
  const { run, status } = useNearAction();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const input = parseKeyInput(text);
  const busy = checking || status.status === "busy";

  const submit = async () => {
    if (!input) return;
    setProblem(null);
    setChecking(true);
    const resolved = await resolveRoundKey(input, { mpk: config.ckd_public_key, engineAccount: engine.account, roundId: round.roundId }, { unwrap: unwrapKey, verify: checkRoundKey });
    setChecking(false);
    if (!resolved.ok) {
      setProblem(resolved.message);
      return;
    }
    const result = await run({
      label: `Submitting the key of round #${round.roundId.toString()}`,
      call: engine.calls.submitKey(round.roundId, resolved.key),
      success: "Round key stored: the reveal window is open",
      receipt: { engine: engine.account, roundId: round.roundId, kind: "close", label: "submit_key" },
    });
    if (result.ok) {
      setText("");
      setOpen(false);
      onChanged();
    }
  };

  if (!open) {
    return (
      <button type="button" className="mt-2 text-[12px] text-ink-300 underline underline-offset-2 hover:text-ink-50" onClick={() => setOpen(true)} data-submit-key-open>
        The MPC answered but the callback failed? Submit the key yourself
      </button>
    );
  }

  return (
    <form
      className="mt-3 flex flex-col gap-2 rounded-md border border-ink-750 bg-ink-900 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      data-submit-key
    >
      <p className="text-[12px] text-ink-400">
        The MPC&apos;s answer <code className="font-mono text-ink-200">(big_y, big_c)</code> is public in its <code className="font-mono text-ink-200">respond_ckd</code> transaction on{" "}
        <a href={nearAccountUrl(config.mpc_account)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          {config.mpc_account} ↗
        </a>
        . Paste the two points, the transaction&apos;s JSON arguments or the unwrapped <code className="font-mono text-ink-200">bls12381g1:</code> key: this browser unwraps it with the round&apos;s public scalar and checks it before you sign.
      </p>
      <Field label="CKD response or round key" error={text.trim() !== "" && !input ? "Paste a bls12381g1: key, the big_y and big_c points, or JSON that contains them." : problem}>
        {({ inputId, describedBy, invalid }) => (
          <textarea
            id={inputId}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setProblem(null);
            }}
            rows={3}
            spellCheck={false}
            className="w-full rounded-md border border-ink-700 bg-ink-950 px-3 py-2 font-mono text-[12px] text-ink-50 [overflow-wrap:anywhere] hover:border-ink-600 focus:border-ember-500 focus:outline-none"
            data-submit-key-input
          />
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={!input || !viewer} loading={busy} loadingLabel={checking ? "Checking the key…" : "Signing…"} data-submit-key-run>
          Check and submit the key
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {status.status === "error" ? <Notice tone="danger">{status.error.message}</Notice> : null}
    </form>
  );
}
