"use client";

/**
 * "Place bid" / "Place ask" (spec 8.3): live fee (30 bps) and collateral preview, bond
 * `max(1 USDC, 1%)`, storage deposit, the cash venue, the round's largest buy quantity (spec
 * 5.2), the NEP-145 storage an Exit bid needs for the units it buys (sent first, from the same
 * click), cash deposit when the venue balance is short, encryption in the browser with
 * `@rose/ibe-wasm` bound to (engine, round, bidder, side), and one order per side.
 */

import { BID_STORAGE_DEPOSIT, outcomeValue, type Side } from "@rose/sdk";
import { useMemo, useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { PendingCashDeposits } from "@/components/deposit/PendingCashDeposits";
import { Button } from "@/components/ui/Button";
import { Field, Input, NumberInput } from "@/components/ui/Input";
import { Tabs } from "@/components/ui/Tabs";
import { useWallets } from "@/components/wallet/WalletProvider";
import { readStorageNeed, type StorageNeed } from "@/lib/engine-storage";
import { formatUnits } from "@/lib/format";
import { formatStorageNear } from "@/lib/near-cash";
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
        {hint ? <span className="block text-[11px] text-ink-400">{hint}</span> : null}
      </dt>
      <dd className={strong ? "tabular text-[13px] text-ink-50" : "tabular text-ink-200"}>{value}</dd>
    </div>
  );
}

export function OrderForm({ detail, nowMs, onPlaced }: { detail: RoundDetail; nowMs: number; onPlaced: () => void }) {
  const { round, cls, viewer, engine, limits, config } = detail;
  const { near, restoring } = useWallets();
  const { run, status } = useNearAction();
  const isCreator = viewer?.account === round.creator;
  const sides = useMemo<Side[]>(() => {
    // The issuer is the buyer of its own Tender: `place_ask` refuses it.
    if (round.kind === "Tender") return isCreator ? [] : ["Sell"];
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
  /** The Advance holder's reserve must seal exactly the claim K: `open_bid` voids any other quantity (`ClaimMismatch`) and slashes the bond. */
  const fixedClaim = round.kind === "Advance" && side === "Sell" ? (round.advanceClaim ?? 0n) : null;
  const qty = fixedClaim ?? parseDecimal(quantity, decimals);
  const limit = parseDecimal(price, USDC_DECIMALS);
  const lockUnits = side === "Sell" ? (fixedClaim ?? parseDecimal(units === "" ? quantity : units, decimals)) : null;
  const escrowInput = parseDecimal(escrowText, USDC_DECIMALS);
  const existing = side === "Buy" ? viewer?.buyOrderId : viewer?.sellOrderId;
  const venueCash = viewer?.cash.find((c) => sameVenue(c.venue, round.venue))?.amount ?? 0n;
  const bondFloor = limits.bondFloor;

  const buyPreview = side === "Buy" && qty !== null && qty > 0n && limit !== null && limit > 0n ? previewBuy(pricing, qty, limit, escrowInput, bondFloor) : null;
  const sellPreview = side === "Sell" && qty !== null && qty > 0n && limit !== null && limit > 0n && lockUnits !== null && lockUnits > 0n ? previewSell(pricing, lockUnits, qty, limit, round.maxPrice, bondFloor) : null;
  const cashNeeded = side === "Buy" ? (buyPreview?.total ?? 0n) : (sellPreview?.bond ?? 0n);
  const shortfall = cashNeeded > venueCash ? cashNeeded - venueCash : 0n;
  const bidStorage = side === "Buy" ? (viewer?.bidStorage ?? null) : null;
  const freeUnits = viewer?.holding.balance ?? 0n;
  const maxBuy = round.maxBuyQuantity ?? (round.kind === "Advance" ? round.advanceClaim : null);

  const errors = {
    quantity:
      qty !== null && qty <= 0n
        ? "Enter a positive quantity."
        : side === "Buy" && maxBuy !== null && qty !== null && qty > maxBuy
          ? `At most ${formatQty(maxBuy, decimals)} ${round.kind === "Advance" ? "claimed tokens are on offer" : "units (the class supply when the round was created)"}: a larger bid is void at opening and its bond slashed.`
          : fixedClaim !== null && qty !== fixedClaim
            ? "The reserve must seal exactly the claim K: any other quantity is void at opening and its bond slashed."
            : side === "Sell" && lockUnits !== null && qty !== null && qty > lockUnits
              ? "The sealed quantity cannot exceed the units you lock."
              : null,
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
  const ready = open && viewer !== null && existing === null && preview !== null && !hasError && shortfall === 0n && !sealing && status.status !== "busy";

  /** Sends the storage deposit an Exit bid needs for the units it buys (spec 4), read live; false when it could not be sent. */
  const ensureBidStorage = async (account: string): Promise<boolean> => {
    let need: StorageNeed | null;
    try {
      need = await readStorageNeed(engine.views, account, { classId: round.classId });
    } catch (error) {
      setSealError(error instanceof Error ? `Your engine storage could not be read: ${error.message}` : "Your engine storage could not be read.");
      return false;
    }
    if (!need) return true;
    const stored = await run({
      label: need.kind === "register" ? "Registering your account in the engine (NEP-145)" : "Adding engine storage for the units you buy (NEP-145)",
      call: engine.calls.storageDeposit(need.deposit),
      success: `${formatStorageNear(need.deposit)} NEAR of storage deposited: the units you buy have room`,
      receipt: { engine: engine.account, roundId: round.roundId, kind: "cash", label: "storage_deposit (NEP-145)" },
    });
    return stored.ok;
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
    saveLocalOrder(engine.account, round.roundId, viewer.account, { side, quantity: qty.toString(), limitPrice: limit.toString(), salt: sealed.salt, ciphertextHex: sealed.ciphertextHex, bidId: null, txHash: null });
    setSealing(false);
    if (side === "Buy" && round.kind === "Exit" && !(await ensureBidStorage(viewer.account))) return;
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

  if (sides.length === 0) {
    return (
      <section aria-label="Your Tender" className="rounded-lg border border-ink-750 bg-ink-850 px-4 py-3" data-order-form="issuer">
        <h3 className="font-display text-[13px] uppercase tracking-wide text-ink-100">Your Tender</h3>
        <p className="mt-1 text-[12px] text-ink-400">
          You are the buyer of this Tender: your escrowed budget is the demand side, and holders of the class submit the sealed asks. The engine refuses an ask from the issuer, so there is no order to place here.
        </p>
      </section>
    );
  }

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
        {open && restoring ? <Notice tone="info">Restoring your wallet…</Notice> : null}
        {open && !restoring && near.status !== "connected" ? <Notice tone="warning">Connect a NEAR wallet (or use the demo wallet) to place a sealed order.</Notice> : null}
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
          {fixedClaim !== null ? (
            <Field label="Claim (tokens)" hint="Fixed to the claim K of the round: the reserve seals exactly this quantity, only its price is yours to set." error={errors.quantity}>
              {({ inputId, describedBy, invalid }) => <Input id={inputId} aria-describedby={describedBy} invalid={invalid} value={formatQty(fixedClaim, decimals)} readOnly className="tabular text-ink-300" data-order-quantity data-fixed-claim />}
            </Field>
          ) : (
            <Field label={side === "Buy" ? (round.kind === "Advance" ? "Claimed tokens" : "Quantity (units)") : "Quantity to sell (units)"} hint={side === "Sell" ? `Free units: ${formatQty(freeUnits, decimals)}` : maxBuy !== null ? `At most ${formatQty(maxBuy, decimals)} per bid` : undefined} error={errors.quantity}>
              {({ inputId, describedBy, invalid }) => <NumberInput id={inputId} aria-describedby={describedBy} invalid={invalid} value={quantity} onValueChange={setQuantity} decimals={decimals} placeholder="1000" unit={round.kind === "Advance" ? "tokens" : "units"} data-order-quantity />}
            </Field>
          )}
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
          {bidStorage ? <Row label={bidStorage.kind === "register" ? "Engine registration (NEP-145)" : "Engine storage top-up (NEP-145)"} value={`${formatStorageNear(bidStorage.deposit)} NEAR`} hint="room for the units you buy, sent first; withdrawable" /> : null}
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
        {viewer && open && round.venue !== "Near" && !showDeposit ? <PendingCashDeposits token={round.venue.Base.token} creditTo={viewer.account} onRegistered={onPlaced} /> : null}
        {sealError ? <Notice tone="danger">{sealError}</Notice> : null}
        {status.status === "error" ? <Notice tone="danger">{status.error.message}</Notice> : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <LearnMore topic="fees" label="Fees and bonds" />
          <Button type="submit" disabled={!ready} loading={sealing || status.status === "busy"} loadingLabel={sealing ? "Sealing in the browser…" : "Signing…"} data-order-submit>
            {side === "Buy" ? (bidStorage ? "Add storage, seal and place bid" : "Seal and place bid") : "Seal and place ask"}
          </Button>
        </div>
      </form>
    </section>
  );
}
