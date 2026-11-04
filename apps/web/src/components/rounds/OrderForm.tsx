"use client";

/**
 * "Place bid" / "Place ask" (spec 8.3): live fee (30 bps) and collateral preview, bond
 * `max(1 USDC, 1%)`, storage deposit, the cash venue, NEP-145 registration when the order can
 * receive units, cash deposit when the venue balance is short, encryption in the browser with
 * `@rose/ibe-wasm` bound to (engine, round, bidder, side), and one order per side.
 */

import { BID_STORAGE_DEPOSIT, outcomeValue, type Side } from "@rose/sdk";
import { useMemo, useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Button } from "@/components/ui/Button";
import { Field, NumberInput } from "@/components/ui/Input";
import { Tabs } from "@/components/ui/Tabs";
import { useWallets } from "@/components/wallet/WalletProvider";
import { formatUnits } from "@/lib/format";
import { useNearAction } from "./actions";
import { CashDeposit } from "./CashDeposit";
import { orderIdentity, sealOrder } from "./ibe";
import { saveLocalOrder } from "./localOrders";
import { formatQty, formatUsdc, parseDecimal, previewBuy, previewSell, roundPricing, sameVenue, USDC_DECIMALS, venueLabel } from "./model";
import { Notice } from "./shared";
import type { RoundDetail } from "./useRoundDetail";

function Row({ label, value, strong = false, hint }: { label: string; value: string; strong?: boolean; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12px]">
      <dt className="text-ink-400">
        {label}
        {hint ? <span className="block text-[11px] text-ink-500">{hint}</span> : null}
      </dt>
      <dd className={strong ? "tabular text-[13px] text-ink-50" : "tabular text-ink-200"}>{value}</dd>
    </div>
  );
}

export function OrderForm({ detail, nowMs, onPlaced }: { detail: RoundDetail; nowMs: number; onPlaced: () => void }) {
  const { round, cls, viewer, engine, limits, config } = detail;
  const { near } = useWallets();
  const { run, status } = useNearAction();
  const isCreator = viewer?.account === round.creator;
  const sides = useMemo<Side[]>(() => {
    if (round.kind === "Tender") return ["Sell"];
    if (round.kind === "Advance") return isCreator ? ["Sell"] : ["Buy"];
    return ["Buy", "Sell"];
  }, [isCreator, round.kind]);
  const [chosenSide, setSide] = useState<Side>(sides[0] ?? "Buy");
  const side: Side = sides.includes(chosenSide) ? chosenSide : (sides[0] ?? "Buy");

  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [units, setUnits] = useState("");
  const [escrowText, setEscrowText] = useState("");
  const [sealing, setSealing] = useState(false);
  const [sealError, setSealError] = useState<string | null>(null);
  const [showDeposit, setShowDeposit] = useState(false);

  const pricing = roundPricing(round, cls.decimals);
  const open = round.status === "Open" && nowMs < Number(round.closesAt / 1_000_000n);
  const decimals = cls.decimals;
  const qty = parseDecimal(quantity, decimals);
  const limit = parseDecimal(price, USDC_DECIMALS);
  const lockUnits = side === "Sell" ? (round.kind === "Advance" ? (round.advanceClaim ?? 0n) : parseDecimal(units === "" ? quantity : units, decimals)) : null;
  const escrowInput = parseDecimal(escrowText, USDC_DECIMALS);
  const existing = side === "Buy" ? viewer?.buyOrderId : viewer?.sellOrderId;
  const venueCash = viewer?.cash.find((c) => sameVenue(c.venue, round.venue))?.amount ?? 0n;
  const bondFloor = limits.bondFloor;

  const buyPreview = side === "Buy" && qty !== null && qty > 0n && limit !== null && limit > 0n ? previewBuy(pricing, qty, limit, escrowInput, bondFloor) : null;
  const sellPreview = side === "Sell" && qty !== null && qty > 0n && limit !== null && limit > 0n && lockUnits !== null && lockUnits > 0n ? previewSell(pricing, lockUnits, qty, limit, round.maxPrice, bondFloor) : null;
  const cashNeeded = side === "Buy" ? (buyPreview?.total ?? 0n) : (sellPreview?.bond ?? 0n);
  const shortfall = cashNeeded > venueCash ? cashNeeded - venueCash : 0n;
  const needsRegistration = side === "Buy" && round.kind === "Exit" && viewer !== null && viewer.storage === null;
  const freeUnits = viewer?.holding.balance ?? 0n;

  const errors = {
    quantity: qty !== null && qty <= 0n ? "Enter a positive quantity." : side === "Buy" && round.kind === "Advance" && qty !== null && round.advanceClaim !== null && qty > round.advanceClaim ? `At most ${formatQty(round.advanceClaim, decimals)} claimed tokens are on offer.` : side === "Sell" && lockUnits !== null && qty !== null && qty > lockUnits ? "The sealed quantity cannot exceed the units you lock." : null,
    price:
      limit !== null && limit <= 0n
        ? "Enter a positive price."
        : limit !== null && limit > round.maxPrice
          ? `Above the round's max price (${formatUsdc(round.maxPrice)}): the order would sit outside the book.`
          : null,
    units: side === "Sell" && round.kind !== "Advance" && lockUnits !== null && lockUnits > freeUnits ? `You hold ${formatQty(freeUnits, decimals)} free units of this class.` : null,
    escrow: side === "Buy" && buyPreview && escrowInput !== null && escrowInput < buyPreview.escrowRequired ? `At least ${formatUsdc(buyPreview.escrowRequired)} (limit × quantity + fee), or the bid is void at opening.` : null,
  };
  const hasError = Object.values(errors).some((e) => e !== null);
  const preview = side === "Buy" ? buyPreview : sellPreview;
  const ready = open && viewer !== null && existing === null && preview !== null && !hasError && shortfall === 0n && !needsRegistration && !sealing && status.status !== "busy";

  const register = async () => {
    const minimum = await engine.views.storageMinimum();
    const result = await run({ label: "Registering your account in the engine (NEP-145)", call: engine.calls.storageDeposit(minimum), success: "Account registered: it can now receive units", receipt: { engine: engine.account, roundId: round.roundId, kind: "cash", label: "storage_deposit (NEP-145)" } });
    if (result.ok) onPlaced();
  };

  const submit = async () => {
    if (!ready || !viewer || qty === null || limit === null) return;
    setSealError(null);
    setSealing(true);
    let sealed;
    try {
      sealed = await sealOrder(orderIdentity(config.ckd_public_key, engine.account, round.roundId, viewer.account, side), qty, limit);
    } catch (error) {
      setSealing(false);
      setSealError(error instanceof Error ? `The order could not be sealed in this browser: ${error.message}` : "The order could not be sealed in this browser.");
      return;
    }
    setSealing(false);
    saveLocalOrder(engine.account, round.roundId, viewer.account, { side, quantity: qty.toString(), limitPrice: limit.toString(), salt: sealed.salt, ciphertextHex: sealed.ciphertextHex, bidId: null, txHash: null });
    const call =
      side === "Buy"
        ? engine.calls.placeBid(round.roundId, sealed.ciphertextHex, buyPreview ? (escrowInput !== null && escrowInput >= buyPreview.escrowRequired ? escrowInput : buyPreview.escrowRequired) : 0n)
        : engine.calls.placeAsk(round.roundId, sealed.ciphertextHex, lockUnits ?? 0n);
    const result = await run({
      label: side === "Buy" ? "Placing the sealed bid" : "Placing the sealed ask",
      call,
      success: (outcome) => {
        const id = outcomeValue(outcome);
        return `Sealed ${side === "Buy" ? "bid" : "ask"}${typeof id === "number" ? ` #${String(id)}` : ""} placed`;
      },
      receipt: { engine: engine.account, roundId: round.roundId, kind: "place", label: side === "Buy" ? "place_bid" : "place_ask" },
    });
    if (result.ok) {
      const id = outcomeValue(result.outcome);
      saveLocalOrder(engine.account, round.roundId, viewer.account, { side, quantity: qty.toString(), limitPrice: limit.toString(), salt: sealed.salt, ciphertextHex: sealed.ciphertextHex, bidId: typeof id === "number" ? id : null, txHash: result.hash });
      setQuantity("");
      setPrice("");
      setUnits("");
      setEscrowText("");
      onPlaced();
    }
  };

  const title = round.kind === "Tender" ? "Place ask" : round.kind === "Advance" ? (isCreator ? "Place your reserve" : "Place bid") : side === "Buy" ? "Place bid" : "Place ask";

  return (
    <section aria-label={title} className="rounded-lg border border-ink-750 bg-ink-850" data-order-form>
      <div className="border-b border-ink-750 px-4 py-3">
        <h3 className="font-display text-[13px] uppercase tracking-wide text-ink-100">{title}</h3>
        <p className="mt-0.5 text-[12px] text-ink-400">
          Sealed in this browser to the round identity; venue <span className="text-ink-200">{venueLabel(round.venue)}</span>.
        </p>
      </div>
      {sides.length > 1 ? (
        <Tabs
          label="Order side"
          items={[
            { id: "Buy", label: "Bid (buy units)" },
            { id: "Sell", label: "Ask (sell units)" },
          ]}
          value={side}
          onChange={setSide}
          className="px-4"
        />
      ) : null}
      <form
        className="flex flex-col gap-4 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {!open ? <Notice tone="info">{round.status === "Scheduled" ? "The round is not open yet." : "Bidding is closed for this round."}</Notice> : null}
        {open && near.status !== "connected" ? <Notice tone="warning">Connect a NEAR wallet (or use the demo wallet) to place a sealed order.</Notice> : null}
        {open && viewer && existing !== null && existing !== undefined ? (
          <Notice tone="info">
            You already placed {side === "Buy" ? "a bid" : "an ask"} in this round (#{String(existing)}). One sealed order per side per account; see &quot;My orders&quot;.
          </Notice>
        ) : null}
        {round.kind === "Advance" && !isCreator ? (
          <p className="text-[12px] text-ink-400">
            Bids are per claimed token: the holder offers a senior claim on the first {formatQty(round.advanceClaim ?? 0n, decimals)} tokens unlocking from {formatQty(round.advanceUnits ?? 0n, decimals)} units; minimum fill {formatQty(round.advanceMinFill ?? 0n, decimals)}.
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={side === "Buy" ? (round.kind === "Advance" ? "Claimed tokens" : "Quantity (units)") : "Quantity to sell (units)"} hint={side === "Sell" && round.kind !== "Advance" ? `Free units: ${formatQty(freeUnits, decimals)}` : undefined} error={errors.quantity}>
            {({ inputId, describedBy, invalid }) => <NumberInput id={inputId} aria-describedby={describedBy} invalid={invalid} value={quantity} onValueChange={setQuantity} decimals={decimals} placeholder="1000" unit={round.kind === "Advance" ? "tokens" : "units"} data-order-quantity />}
          </Field>
          <Field label={side === "Buy" ? "Limit price" : "Minimum price"} hint={`Per ${round.kind === "Advance" ? "claimed" : "locked"} token · max ${formatUsdc(round.maxPrice)}`} error={errors.price}>
            {({ inputId, describedBy, invalid }) => <NumberInput id={inputId} aria-describedby={describedBy} invalid={invalid} value={price} onValueChange={setPrice} decimals={USDC_DECIMALS} placeholder={formatUsdc(round.maxPrice)} unit="USDC" data-order-price />}
          </Field>
          {side === "Sell" && round.kind !== "Advance" ? (
            <Field label="Units to lock (public)" hint="Defaults to the quantity. Locking more hides the exact quantity you sell." error={errors.units}>
              {({ inputId, describedBy, invalid }) => <NumberInput id={inputId} aria-describedby={describedBy} invalid={invalid} value={units} onValueChange={setUnits} decimals={decimals} placeholder={quantity || "1000"} unit="units" />}
            </Field>
          ) : null}
          {side === "Buy" ? (
            <Field label="Escrow (public)" hint={buyPreview ? `Minimum ${formatUsdc(buyPreview.escrowRequired)}. A larger escrow hides your limit × quantity.` : "Minimum: limit × quantity + 30 bps fee."} error={errors.escrow}>
              {({ inputId, describedBy, invalid }) => <NumberInput id={inputId} aria-describedby={describedBy} invalid={invalid} value={escrowText} onValueChange={setEscrowText} decimals={USDC_DECIMALS} placeholder={buyPreview ? formatUsdc(buyPreview.escrowRequired) : "0.00"} unit="USDC" />}
            </Field>
          ) : null}
        </div>

        <dl className="flex flex-col gap-1.5 rounded-md border border-ink-750 bg-ink-900 p-3" data-order-preview>
          {side === "Buy" ? (
            <>
              <Row label="Cash at your limit" value={buyPreview ? `${formatUsdc(buyPreview.charge)} USDC` : "—"} hint={round.kind === "Advance" ? "quantity × limit" : "quantity × locked fraction × limit, rounded up"} />
              <Row label="Fee (30 bps, buyer)" value={buyPreview ? `${formatUsdc(buyPreview.fee)} USDC` : "—"} />
              <Row label="Escrow" value={buyPreview ? `${formatUsdc(escrowInput !== null && escrowInput >= buyPreview.escrowRequired ? escrowInput : buyPreview.escrowRequired)} USDC` : "—"} hint="refunded above your charge + fee" />
              <Row label="Bond" value={buyPreview ? `${formatUsdc(buyPreview.bond)} USDC` : "—"} hint={`max(${formatUsdc(bondFloor)}, 1% of escrow), back on a valid opening`} />
              <Row label="Debited from your cash" value={buyPreview ? `${formatUsdc(buyPreview.total)} USDC` : "—"} strong />
            </>
          ) : (
            <>
              <Row label="Units locked" value={lockUnits !== null && lockUnits > 0n ? formatQty(lockUnits, decimals) : "—"} hint="public; they keep accruing to you until the close" />
              <Row label="Proceeds at your minimum" value={sellPreview ? `${formatUsdc(sellPreview.proceedsAtMinimum)} USDC` : "—"} hint="sellers receive the clearing price, nothing deducted" />
              <Row label="Bond" value={sellPreview ? `${formatUsdc(sellPreview.bond)} USDC` : "—"} hint={`max(${formatUsdc(bondFloor)}, 1% of ${sellPreview ? formatUsdc(sellPreview.valuation) : "units at max price"})`} />
              <Row label="Debited from your cash" value={sellPreview ? `${formatUsdc(sellPreview.bond)} USDC` : "—"} strong />
            </>
          )}
          <Row label="Storage deposit" value={`${formatUnits(BID_STORAGE_DEPOSIT, 24, 2)} NEAR`} hint="returned when the order settles" />
          <Row label="Your cash in the venue" value={viewer ? `${formatUsdc(venueCash)} USDC` : "—"} />
        </dl>

        {viewer && open && shortfall > 0n && existing === null ? (
          <div className="flex flex-col gap-2">
            <Notice tone="warning">
              Cash short by <span className="tabular">{formatUsdc(shortfall)} USDC</span> in {venueLabel(round.venue)}.{" "}
              <button type="button" className="underline underline-offset-2" onClick={() => setShowDeposit((v) => !v)} data-show-deposit>
                {showDeposit ? "Hide deposit" : "Deposit cash"}
              </button>
            </Notice>
            {showDeposit ? <CashDeposit engine={engine} venue={round.venue} roundId={round.roundId} shortfall={shortfall} nearCashToken={config.near_cash_token} onDeposited={onPlaced} /> : null}
          </div>
        ) : null}
        {viewer && open && needsRegistration && existing === null ? (
          <Notice tone="warning">
            Exit buyers receive units, so the account must be registered in the engine (NEP-145, about 0.0022 NEAR, withdrawable).{" "}
            <Button type="button" size="sm" variant="secondary" className="ml-2" onClick={() => void register()} loading={status.status === "busy"} loadingLabel="Signing…" data-register>
              Register
            </Button>
          </Notice>
        ) : null}
        {sealError ? <Notice tone="danger">{sealError}</Notice> : null}
        {status.status === "error" ? <Notice tone="danger">{status.error.message}</Notice> : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <LearnMore topic="fees" label="Fees and bonds" />
          <Button type="submit" disabled={!ready} loading={sealing || status.status === "busy"} loadingLabel={sealing ? "Sealing in the browser…" : "Signing…"} data-order-submit>
            {side === "Buy" ? "Seal and place bid" : "Seal and place ask"}
          </Button>
        </div>
      </form>
    </section>
  );
}
