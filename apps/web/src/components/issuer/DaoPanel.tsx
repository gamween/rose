"use client";

import { outcomeValue, storageDepositCall, type FunctionCall, type TenderArgs, type Venue } from "@rose/sdk";
import Link from "next/link";
import { useCallback, useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/DetailsList";
import { Input } from "@/components/ui/Input";
import type { ExplorerLink } from "@/components/ui/Toast";
import { useWallets } from "@/components/wallet/WalletProvider";
import { formatUsdc, sameVenue, venueLabel } from "@/lib/amounts";
import { NEAR_TUSDC_ACCOUNT } from "@/lib/deployment";
import { nearRpc } from "@/lib/engine-client";
import { readStorageNeed, type StorageNeed } from "@/lib/engine-storage";
import { RoseActionError, toActionError } from "@/lib/errors";
import { nearTxUrl, txLinks } from "@/lib/explorer";
import { ROUTES } from "@/lib/routes";
import { useAction } from "@/lib/use-action";
import { BaseCashFunding } from "./BaseCashFunding";
import { daoNearFundingCall, daoShortfall, ftTransferCall, sputnikCliCommand, sputnikProposal, trezuSlug, trezuTemplate, type SputnikProposal } from "./dao";
import { isNearAccountId, readDaoAccounts, rememberDaoAccount } from "./dao-accounts";
import { ActionFeedback, classSymbol, CopyButton, FieldLabel, formatNear, Hint, Preview, type IssuerBase } from "./shared";

/** Storage registration on the tUSDC NEP-141 (`storage_balance_bounds().min`, read live 2026-11-04). */
const TUSDC_STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;
/** `add_proposal` stores the proposal; 100 Tgas is what the console and the near-cli command attach. */
export const ADD_PROPOSAL_GAS = 100n * 10n ** 12n;

/** A Sputnik `proposal_period` (ns) in days or hours. */
function formatVotePeriod(ns: bigint): string {
  const hours = Number(ns / 3_600_000_000_000n);
  return hours >= 24 && hours % 24 === 0 ? `${String(hours / 24)} ${hours === 24 ? "day" : "days"}` : `${String(hours)} h`;
}

type DaoState = {
  account: string;
  venue: Venue;
  proposalBond: bigint;
  /** How long a proposal stays open to votes (`get_policy().proposal_period`, ns). */
  proposalPeriodNs: bigint;
  version: string | null;
  /** The DAO's engine cash in the Tender's venue. */
  cash: bigint;
  /** Engine NEP-145 storage the NEAR funding needs first (null when covered). */
  storage: StorageNeed | null;
  /** The DAO's cash-token wallet on NEAR (NEAR venue only). */
  token: { balance: bigint; registered: boolean } | null;
};

/** One Sputnik proposal: its `add_proposal` JSON and near-cli command, and a button that files it from the connected wallet. */
export function ProposalBlock({ name, proposal, cli, onFile, filing, disabled, testId }: { name: string; proposal: SputnikProposal; cli: string; onFile: () => void; filing: boolean; disabled: string | null; testId: string }) {
  const json = JSON.stringify(proposal, null, 2);
  return (
    <div className="flex flex-col gap-2" data-proposal={testId}>
      <Disclosure summary={`${name} proposal: JSON and CLI command`}>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <FieldLabel>add_proposal arguments</FieldLabel>
            <CopyButton text={json} label="Copy JSON" />
          </div>
          <pre className="max-h-56 overflow-auto rounded-md border border-ink-750 bg-ink-950 p-3 font-mono text-[11px] text-ink-200" data-dao-json={testId}>
            {json}
          </pre>
          <div className="flex items-center justify-between gap-2">
            <FieldLabel>near-cli-rs command</FieldLabel>
            <CopyButton text={cli} label="Copy command" />
          </div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-ink-750 bg-ink-950 p-3 font-mono text-[11px] text-ink-200">{cli}</pre>
          <Hint>Members vote with act_proposal (Sputnik DAO has no testnet web UI today).</Hint>
        </div>
      </Disclosure>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onFile} disabled={disabled !== null || filing} loading={filing} loadingLabel="Filing" title={disabled ?? undefined} data-file-proposal={testId}>
          File from my wallet
        </Button>
        {disabled ? <Hint>{disabled}</Hint> : null}
      </div>
    </div>
  );
}

/**
 * "Run via DAO" (spec 8.3): the treasury, not the connected member, creates the Tender, so the
 * escrow must sit in the DAO's own engine cash. The panel reads the DAO (bond, cash, storage,
 * token wallet), funds it (NEAR venue: storage paid by the member, tUSDC sent by the member if
 * the treasury holds too little, then a proposal in which the DAO calls `ft_transfer_call`; Base
 * venue: the member deposits on Base with the DAO as the credited account), then files the
 * `create_tender` proposal. Sputnik executes approved proposals in the order they are approved.
 */
export function DaoPanel({ base, venue, ready, escrow, className }: { base: IssuerBase; venue: Venue; ready: { args: TenderArgs; call: FunctionCall } | null; escrow: bigint; className?: string }) {
  const wallets = useWallets();
  const [dao, setDao] = useState(() => readDaoAccounts()[0] ?? "");
  const [state, setState] = useState<DaoState | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [description, setDescription] = useState("rose Tender: buy back locked units at one uniform price");
  const storage = useAction();
  const send = useAction();
  const fundFile = useAction();
  const tenderFile = useAction();

  const account = dao.trim();
  /* A read is valid for the account and the venue it was made for. */
  const current = state !== null && state.account === account && sameVenue(state.venue, venue) ? state : null;
  const shortfall = current ? daoShortfall(escrow, current.cash) : null;
  const venueText = venueLabel(venue, base.symbols);
  const signer = wallets.near.accountId;

  const readDao = useCallback(async () => {
    setReadError(null);
    if (!isNearAccountId(account)) {
      setReadError("Enter the DAO's NEAR account id (for example treasury.sputnikv2.testnet).");
      return;
    }
    setReading(true);
    try {
      const rpc = nearRpc();
      const [policy, version, cash, need, token] = await Promise.all([
        rpc.viewFunction<{ proposal_bond: string; proposal_period: string }>(account, "get_policy", {}),
        rpc
          .viewFunction<string>(account, "version", {})
          .then((result) => result.value)
          .catch(() => null),
        base.engine.views.getCash(account),
        venue === "Near" ? readStorageNeed(base.engine.views, account, { cashVenue: "Near" }) : Promise.resolve(null),
        venue === "Near"
          ? Promise.all([rpc.viewFunction<string>(NEAR_TUSDC_ACCOUNT, "ft_balance_of", { account_id: account }), rpc.viewFunction<{ total: string } | null>(NEAR_TUSDC_ACCOUNT, "storage_balance_of", { account_id: account })]).then(([balance, registration]) => ({ balance: BigInt(balance.value), registered: registration.value !== null }))
          : Promise.resolve(null),
      ]);
      const inVenue = cash.find((entry) => sameVenue(entry.venue, venue))?.amount ?? 0n;
      setState({ account, venue, proposalBond: BigInt(policy.value.proposal_bond), proposalPeriodNs: BigInt(policy.value.proposal_period), version, cash: inVenue, storage: need, token });
      rememberDaoAccount(account);
    } catch (error) {
      setState(null);
      setReadError(`${toActionError(error).message} Is ${account} a Sputnik DAO v2 account?`);
    } finally {
      setReading(false);
    }
  }, [account, base.engine.views, venue]);

  const file = (action: ReturnType<typeof useAction>, label: string, proposal: SputnikProposal) =>
    action.run(label, async () => {
      if (!current) throw new RoseActionError("contract", "Read the DAO first", "The bond is read from the DAO's policy.");
      const outcome = await wallets.sendNearCall({ receiverId: current.account, methodName: "add_proposal", args: proposal, gas: ADD_PROPOSAL_GAS, deposit: current.proposalBond });
      rememberDaoAccount(current.account);
      const id = String(outcomeValue(outcome) ?? "");
      return { message: id ? `Proposal #${id} filed to ${current.account}` : `Proposal filed to ${current.account}`, links: txLinks("near", outcome.transaction.hash) };
    });

  const payStorage = () =>
    storage.run("Paying the DAO's engine storage", async () => {
      if (!current?.storage) throw new RoseActionError("contract", "Nothing to pay", "The DAO's engine storage already covers its cash row.");
      const outcome = await wallets.sendNearCall(base.engine.calls.storageDeposit(current.storage.deposit, current.account));
      await readDao();
      return { message: `${formatNear(current.storage.deposit)} NEAR of engine storage paid for ${current.account}`, links: txLinks("near", outcome.transaction.hash) };
    });

  const tokenGap = current?.token && shortfall !== null && current.token.balance < shortfall ? shortfall - current.token.balance : 0n;

  const sendTokens = () =>
    send.run("Sending tUSDC to the DAO", async () => {
      if (!current?.token || tokenGap === 0n) throw new RoseActionError("contract", "Nothing to send", "The DAO already holds the tUSDC its funding proposal transfers.");
      const mine = wallets.balances.nearTusdc;
      if (mine !== null && mine < tokenGap) throw new RoseActionError("insufficient_balance", "Not enough tUSDC", `Your wallet holds ${formatUsdc(mine)} tUSDC; mint more from "Get test funds".`);
      const links: ExplorerLink[] = [];
      if (!current.token.registered) {
        const registration = await wallets.sendNearCall(storageDepositCall(NEAR_TUSDC_ACCOUNT, current.account, TUSDC_STORAGE_DEPOSIT));
        links.push({ href: nearTxUrl(registration.transaction.hash), label: "Token registration on near.rocks" });
      }
      const outcome = await wallets.sendNearCall(ftTransferCall(NEAR_TUSDC_ACCOUNT, current.account, tokenGap, "rose: Tender escrow for the DAO"));
      await readDao();
      return { message: `${formatUsdc(tokenGap)} tUSDC sent to ${current.account}`, links: [...links, ...txLinks("near", outcome.transaction.hash)] };
    });

  const fundingProposal = shortfall && shortfall > 0n && venue === "Near" ? sputnikProposal(daoNearFundingCall(NEAR_TUSDC_ACCOUNT, base.engine.account, shortfall), `rose: move ${formatUsdc(shortfall)} tUSDC into the DAO's engine cash for a Tender (ft_transfer_call)`) : null;
  const tenderProposal = ready ? sputnikProposal(ready.call, description) : null;
  const bond = current?.proposalBond ?? 10n ** 24n;
  const cliFor = (proposal: SputnikProposal) => sputnikCliCommand(account || "<dao>.sputnikv2.testnet", proposal, bond, signer ?? "<your-account>.testnet");
  const fileDisabled = !signer ? "Connect a NEAR wallet: it files the proposal and pays the bond." : !current ? "Read the DAO first: the bond comes from its policy." : null;
  const classInfo = ready ? base.classes.find((item) => item.classId === ready.args.classId) : undefined;
  const trezu = ready && classInfo ? JSON.stringify(trezuTemplate({ id: trezuSlug(classInfo.classId, `tender-${classSymbol(classInfo, base.symbols)}`), title: `rose Tender · ${classSymbol(classInfo, base.symbols)}`, engine: base.engine.account, call: ready.call, tender: ready.args, classLabel: classSymbol(classInfo, base.symbols), venueLabel: venueText }), null, 2) : null;

  return (
    <Card data-dao-panel className={className}>
      <CardHeader
        title="Run via DAO"
        description="The DAO creates the Tender from its own engine cash after a vote."
        action={<Badge tone="info">Sputnik v2</Badge>}
      />
      <CardBody className="flex flex-col gap-5">
        <section className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="dao-account">1 · DAO account</FieldLabel>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input id="dao-account" value={dao} onChange={(event) => setDao(event.target.value)} placeholder="treasury.sputnikv2.testnet" />
            <Button variant="secondary" onClick={() => void readDao()} disabled={!account || reading} loading={reading} loadingLabel="Reading" data-read-policy>
              Read the DAO
            </Button>
          </div>
          {current ? (
            <Hint>
              Proposal bond {formatNear(current.proposalBond)} NEAR (attached exactly, refunded on approval) · votes stay open {formatVotePeriod(current.proposalPeriodNs)}: the Tender must close after its execution{current.version ? ` · contract version ${current.version}` : ""}.
            </Hint>
          ) : readError ? (
            <Hint tone="danger">{readError}</Hint>
          ) : (
            <Hint>Reads its proposal bond, engine cash and token wallet.</Hint>
          )}
        </section>

        <section className="flex flex-col gap-3" data-dao-funding>
          <FieldLabel>2 · Fund the DAO&apos;s engine cash in {venueText}</FieldLabel>
          <Preview
            rows={[
              { label: "Escrow create_tender debits (budget + 30 bps)", value: `${formatUsdc(escrow)} USDC` },
              { label: "DAO cash in this venue", value: current ? `${formatUsdc(current.cash)} USDC` : "—" },
              { label: "Still to fund", value: shortfall === null ? "—" : `${formatUsdc(shortfall)} USDC`, emphasis: true },
            ]}
          />
          {shortfall === null ? (
            <Hint>Read the DAO to see what its cash misses.</Hint>
          ) : shortfall === 0n ? (
            <Hint>The DAO&apos;s cash covers the escrow: file the Tender proposal.</Hint>
          ) : venue === "Near" && current ? (
            <>
              <div className="flex flex-col gap-2">
                <p className="text-[12px] text-ink-300">
                  a. Engine storage for the DAO:{" "}
                  {current.storage ? `${formatNear(current.storage.deposit)} NEAR is missing (anyone may pay it).` : "covered."}
                </p>
                {current.storage ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <Button variant="secondary" onClick={() => void payStorage()} disabled={!signer || storage.state.status === "loading"} loading={storage.state.status === "loading"} loadingLabel="Paying" data-dao-storage>
                      Pay it from my wallet
                    </Button>
                  </div>
                ) : null}
                <ActionFeedback state={storage.state} onRetry={() => void payStorage()} />
              </div>
              <div className="flex flex-col gap-2">
                <p className="text-[12px] text-ink-300">
                  b. tUSDC in the treasury: {current.token ? `${formatUsdc(current.token.balance)} tUSDC` : "—"}
                  {tokenGap > 0n ? `, ${formatUsdc(tokenGap)} short of the funding.` : ", enough for the funding."}
                </p>
                {tokenGap > 0n ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <Button variant="secondary" onClick={() => void sendTokens()} disabled={!signer || send.state.status === "loading"} loading={send.state.status === "loading"} loadingLabel="Sending" data-dao-send>
                      Send {formatUsdc(tokenGap)} tUSDC from my wallet
                    </Button>
                    <Hint>{current.token && !current.token.registered ? "Registers the DAO on the token first (0.00125 NEAR)." : "ft_transfer to the DAO."}</Hint>
                  </div>
                ) : null}
                <ActionFeedback state={send.state} onRetry={() => void sendTokens()} />
              </div>
              {fundingProposal ? (
                <>
                  <p className="text-[12px] text-ink-300">c. A proposal moves the DAO&apos;s tUSDC into its engine cash.</p>
                  <ProposalBlock name="Funding" proposal={fundingProposal} cli={cliFor(fundingProposal)} onFile={() => void file(fundFile, "Filing the funding proposal", fundingProposal)} filing={fundFile.state.status === "loading"} disabled={fileDisabled} testId="funding" />
                  <ActionFeedback state={fundFile.state} onRetry={() => void file(fundFile, "Filing the funding proposal", fundingProposal)} />
                </>
              ) : null}
            </>
          ) : venue !== "Near" && current ? (
            <>
              <p className="text-[12px] text-ink-300">Deposit on Base with the DAO as the credited account (no vote needed).</p>
              <BaseCashFunding base={base} token={venue.Base.token} amount={shortfall} creditTo={current.account} roundId={0n} onDone={() => void readDao()} />
            </>
          ) : null}
        </section>

        <section className="flex flex-col gap-3" data-dao-tender>
          <FieldLabel htmlFor="dao-description">3 · The Tender proposal</FieldLabel>
          <Input id="dao-description" value={description} onChange={(event) => setDescription(event.target.value)} aria-label="Proposal description" />
          {tenderProposal ? (
            <>
              {shortfall !== null && shortfall > 0n ? <Hint tone="warning">Approve the funding first: create_tender fails while the DAO&apos;s cash is short of the escrow.</Hint> : null}
              <ProposalBlock name="Tender" proposal={tenderProposal} cli={cliFor(tenderProposal)} onFile={() => void file(tenderFile, "Filing the Tender proposal", tenderProposal)} filing={tenderFile.state.status === "loading"} disabled={fileDisabled} testId="tender" />
              <ActionFeedback state={tenderFile.state} onRetry={() => void file(tenderFile, "Filing the Tender proposal", tenderProposal)} />
              {trezu ? (
                <Disclosure summary="Trezu custom proposal template">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-start justify-between gap-2">
                      <Hint>Paste it in the Code tab of /&lt;dao&gt;/custom-templates/create (Trezu manifest DSL v1). Class, venue and retire-to are fixed; budget, prices and closing time are member inputs.</Hint>
                      <CopyButton text={trezu} label="Copy manifest" />
                    </div>
                    <pre className="max-h-56 overflow-auto rounded-md border border-ink-750 bg-ink-950 p-3 font-mono text-[11px] text-ink-200" data-trezu-json>
                      {trezu}
                    </pre>
                  </div>
                </Disclosure>
              ) : null}
            </>
          ) : (
            <Hint tone="warning">Fill the Tender form to build the proposal.</Hint>
          )}
        </section>
        <p className="text-[12px] text-ink-400">
          Once approved, the round appears in <Link href={ROUTES.rounds} className="underline-offset-2 hover:underline">Rounds</Link> and in Results. <LearnMore topic="issuer" anchor="5-run-via-dao" />
        </p>
      </CardBody>
    </Card>
  );
}
