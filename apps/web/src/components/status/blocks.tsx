"use client";

import Link from "next/link";
import { useCallback } from "react";
import { Badge } from "@/components/ui/Badge";
import { FIXED_ADDRESSES, type Deployment } from "@/components/docs/deployment";
import { viewCall } from "@/lib/engine";
import { formatCount, formatUnits, formatUtcDateTime } from "@/lib/format";
import { fetchEngineConfig } from "./engineConfig";
import { fetchRecentEvents, nanosToMillis, type StoredEvent } from "./events";
import { baseAddressUrl, nearAccountUrl, nearBlockUrl, shorten, solanaAddressUrl } from "@/lib/explorer";
import { formatLatency, KEY_RELEASE, pairLatencies, type LatencyReport } from "./latency";
import { decodeAddress, decodeString, decodeUint, EMPTY_CODE_HASH, ethCall, ethGetCode, SELECTORS, solanaBalance, viewAccessKeyList, viewAccount } from "./rpc";
import { ExternalLink, RawResult, Row, Rows, StatusBlock } from "./StatusBlock";
import { NotDeployedError, useLiveQuery } from "./useLiveQuery";

type BlockProps = { deployment: Deployment; refreshKey: number; className?: string };

const NEAR_DECIMALS = 24;
const LAMPORTS_DECIMALS = 9;

function requireEngine(deployment: Deployment): string {
  if (!deployment.ENGINE_ACCOUNT) throw new NotDeployedError("No engine account is configured for this deployment (NEXT_PUBLIC_ENGINE_ACCOUNT).");
  return deployment.ENGINE_ACCOUNT;
}

const formatTime = formatUtcDateTime;

/** Engine account: keyless check with the raw `view_access_key_list` result. */
export function EngineKeysBlock({ deployment, refreshKey }: BlockProps) {
  const fetcher = useCallback(
    async (signal: AbortSignal) => {
      const account = requireEngine(deployment);
      const [keys, info] = await Promise.all([viewAccessKeyList(account, { signal }), viewAccount(account, { signal })]);
      if (info.code_hash === EMPTY_CODE_HASH) throw new NotDeployedError(`${account} exists but holds no contract yet.`);
      return { account, keys, info };
    },
    [deployment],
  );
  const query = useLiveQuery(fetcher, refreshKey);
  return (
    <StatusBlock
      title="Engine account"
      loadingHeight={207}
      description="Keyless after init: no key can upgrade, drain or stop it."
      notDeployedHint="Once the engine is deployed, this block shows its access key list (expected: empty) read live from the RPC."
      badge={({ keys }) => (keys.keys.length === 0 ? { tone: "success", label: "Keyless" } : { tone: "danger", label: `${keys.keys.length} ${keys.keys.length === 1 ? "key" : "keys"}` })}
      {...query}
    >
      {({ account, keys, info }) => (
        <>
          <Rows>
            <Row label="Account" mono>
              <ExternalLink href={nearAccountUrl(account)}>{account}</ExternalLink>
            </Row>
            <Row label="Access keys">
              {keys.keys.length === 0 ? "None: the contract has no full-access or function-call key." : `${keys.keys.length} key(s) still attached.`}
            </Row>
            <Row label="Balance">
              <span className="tabular">{formatUnits(BigInt(info.amount), NEAR_DECIMALS, 3)} NEAR</span>
            </Row>
            <Row label="Storage">
              <span className="tabular">{formatCount(info.storage_usage)} bytes</span>
            </Row>
            <Row label="Block">
              <ExternalLink href={nearBlockUrl(keys.block_height)} className="tabular">
                {formatCount(keys.block_height)}
              </ExternalLink>
            </Row>
          </Rows>
          <RawResult label="Raw view_access_key_list result" value={keys} />
        </>
      )}
    </StatusBlock>
  );
}

/** Contract versions: engine wasm hash and MPC contract version. */
export function VersionsBlock({ deployment, refreshKey }: BlockProps) {
  const fetcher = useCallback(
    async (signal: AbortSignal) => {
      const mpc = await viewCall<string>(FIXED_ADDRESSES.mpcContract, "version", {}, { signal });
      if (!deployment.ENGINE_ACCOUNT) return { mpcVersion: mpc.value, engine: null };
      const [info, config] = await Promise.all([viewAccount(deployment.ENGINE_ACCOUNT, { signal }), fetchEngineConfig(deployment.ENGINE_ACCOUNT, { signal })]);
      if (info.code_hash === EMPTY_CODE_HASH) return { mpcVersion: mpc.value, engine: null };
      return { mpcVersion: mpc.value, engine: { account: deployment.ENGINE_ACCOUNT, codeHash: info.code_hash, config: config.config } };
    },
    [deployment],
  );
  const query = useLiveQuery(fetcher, refreshKey);
  return (
    <StatusBlock
      title="Contract versions"
      loadingHeight={207}
      description="The engine is identified by the hash of its wasm; the MPC contract reports its own version."
      notDeployedHint="The MPC version is read live; the engine hash appears once the engine is deployed."
      {...query}
    >
      {({ mpcVersion, engine }) => (
        <Rows>
          <Row label="MPC contract" mono>
            <ExternalLink href={nearAccountUrl(FIXED_ADDRESSES.mpcContract)}>{FIXED_ADDRESSES.mpcContract}</ExternalLink>
          </Row>
          <Row label="MPC version">
            <span className="tabular">{mpcVersion}</span>
          </Row>
          {engine ? (
            <>
              <Row label="Engine wasm" mono>
                {engine.codeHash}
              </Row>
              <Row label="Domains">
                <span className="tabular">
                  sign {engine.config.sign_secp256k1_domain} (secp256k1), {engine.config.sign_ed25519_domain} (Ed25519) · CKD {engine.config.ckd_domain} · ForeignTx{" "}
                  {engine.config.foreign_tx_domain}
                </span>
              </Row>
              <Row label="Fee recipient" mono>
                <ExternalLink href={nearAccountUrl(engine.config.fee_recipient)}>{engine.config.fee_recipient}</ExternalLink>
              </Row>
            </>
          ) : (
            <Row label="Engine wasm">
              <Badge tone="warning">Not deployed yet</Badge>
            </Row>
          )}
        </Rows>
      )}
    </StatusBlock>
  );
}

function LatencyTable({ report, label }: { report: LatencyReport; label: string }) {
  const recent = [...report.samples].slice(-8).reverse();
  return (
    <div className="mt-3 overflow-x-auto rounded-md border border-ink-750">
      <table className="w-full border-collapse text-[12px]">
        <caption className="sr-only">{label}</caption>
        <thead className="bg-ink-900">
          <tr>
            <th scope="col" className="px-3 py-1.5 text-left font-display text-[11px] font-normal uppercase tracking-wide text-ink-400">
              Round
            </th>
            <th scope="col" className="px-3 py-1.5 text-left font-display text-[11px] font-normal uppercase tracking-wide text-ink-400">
              Requested
            </th>
            <th scope="col" className="px-3 py-1.5 text-left font-display text-[11px] font-normal uppercase tracking-wide text-ink-400">
              Source
            </th>
            <th scope="col" className="px-3 py-1.5 text-right font-display text-[11px] font-normal uppercase tracking-wide text-ink-400">
              Latency
            </th>
          </tr>
        </thead>
        <tbody>
          {recent.map((sample) => (
            <tr key={`${sample.key}-${sample.completedBlock}`} className="border-t border-ink-800">
              <td className="px-3 py-1.5">
                <Link href={`/app/rounds/${sample.key}`} className="text-ember-300 hover:text-ember-200">
                  #{sample.key}
                </Link>
              </td>
              <td className="whitespace-nowrap px-3 py-1.5 text-ink-300">{formatTime(sample.requestedAt)}</td>
              <td className="px-3 py-1.5 text-ink-300">{sample.source ?? "—"}</td>
              <td className="tabular px-3 py-1.5 text-right text-ink-50">{formatLatency(sample.latencyMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** MPC latency of recent key releases, from the engine's on-chain event timestamps. */
export function MpcLatencyBlock({ deployment, refreshKey, className }: BlockProps) {
  const fetcher = useCallback(
    async (signal: AbortSignal) => {
      const account = requireEngine(deployment);
      const history = await fetchRecentEvents(account, 600, { signal });
      return { history, keys: pairLatencies(history.events, KEY_RELEASE) };
    },
    [deployment],
  );
  const query = useLiveQuery(fetcher, refreshKey);
  return (
    <StatusBlock
      title="MPC latency"
      loadingHeight={334}
      description="Time from the engine's key request (after a round closes) to the key stored on chain, from event timestamps."
      notDeployedHint="Latencies are computed from the engine's event history (key_requested to key_received) once it is deployed."
      badge={({ keys }) => (keys.stats ? { tone: "success", label: `median ${formatLatency(keys.stats.medianMs)}` } : { tone: "neutral", label: "No request yet" })}
      className={className}
      {...query}
    >
      {({ history, keys }) => (
        <>
          <Rows>
            <Row label="Window">
              <span className="tabular">
                {formatCount(history.events.length)} of {formatCount(Number(history.total))} events (history keeps the last 1,024)
              </span>
            </Row>
            <Row label="Key releases">
              {keys.stats ? (
                <span className="tabular">
                  {keys.stats.count} measured · median {formatLatency(keys.stats.medianMs)} · p90 {formatLatency(keys.stats.p90Ms)} · min {formatLatency(keys.stats.minMs)} ·
                  max {formatLatency(keys.stats.maxMs)}
                </span>
              ) : (
                "No round has requested a key in this window yet."
              )}
            </Row>
            <Row label="Failed callbacks">
              <span className="tabular">{keys.failed}</span>
            </Row>
            <Row label="Pending">
              {keys.pending.length === 0 ? (
                "None"
              ) : (
                <span className="tabular">
                  {keys.pending.map((pending) => `#${pending.key} since ${formatTime(pending.requestedAt)}`).join(", ")}
                </span>
              )}
            </Row>
          </Rows>
          {keys.samples.length > 0 ? <LatencyTable report={keys} label="Most recent key releases" /> : null}
        </>
      )}
    </StatusBlock>
  );
}

type VaultReading = { address: string; signer: string; lockup: string; derivedSigner: string | null };

/** RoseVault on Base Sepolia: address, immutable signer and the lockup it accepts. */
export function RoseVaultBlock({ deployment, refreshKey }: BlockProps) {
  const fetcher = useCallback(
    async (signal: AbortSignal): Promise<VaultReading> => {
      let address = deployment.ROSE_VAULT;
      let derivedSigner: string | null = null;
      if (deployment.ENGINE_ACCOUNT) {
        try {
          const { config } = await fetchEngineConfig(deployment.ENGINE_ACCOUNT, { signal });
          address = config.rose_vault || address;
          derivedSigner = config.derived_addresses?.vault_base ?? null;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") throw error;
        }
      }
      if (!address) throw new NotDeployedError("RoseVault has no address yet (NEXT_PUBLIC_ROSE_VAULT or the engine config).");
      const code = await ethGetCode(address, { signal });
      if (code === "0x") throw new NotDeployedError(`No contract is deployed at ${address} on Base Sepolia yet.`);
      const [signer, lockup] = await Promise.all([ethCall(address, SELECTORS["SIGNER()"], { signal }), ethCall(address, SELECTORS["LOCKUP()"], { signal })]);
      return { address, signer: decodeAddress(signer), lockup: decodeAddress(lockup), derivedSigner };
    },
    [deployment],
  );
  const query = useLiveQuery(fetcher, refreshKey);
  return (
    <StatusBlock
      title="RoseVault (Base Sepolia)"
      loadingHeight={136}
      description="Immutable, no owner: the only signer is the engine's MPC-derived address."
      notDeployedHint="The vault's address, immutable signer and accepted lockup are read from Base Sepolia once it is deployed."
      badge={({ signer, derivedSigner }) =>
        derivedSigner ? (signer.toLowerCase() === derivedSigner.toLowerCase() ? { tone: "success", label: "Signer matches engine" } : { tone: "danger", label: "Signer mismatch" }) : { tone: "ember", label: "Immutable" }
      }
      {...query}
    >
      {({ address, signer, lockup, derivedSigner }) => (
        <Rows>
          <Row label="Address" mono>
            <ExternalLink href={baseAddressUrl(address)}>{address}</ExternalLink>
          </Row>
          <Row label="Signer" mono>
            <ExternalLink href={baseAddressUrl(signer)}>{signer}</ExternalLink>
            <span className="ml-2 font-sans text-[12px] text-ink-400">
              {derivedSigner ? "engine path vault/base" : "set in the constructor, cannot change"}
            </span>
          </Row>
          <Row label="Lockup" mono>
            <ExternalLink href={baseAddressUrl(lockup)}>{lockup}</ExternalLink>
            <span className="ml-2 font-sans text-[12px] text-ink-400">
              {lockup.toLowerCase() === FIXED_ADDRESSES.sablierLockup.toLowerCase() ? "canonical Sablier Lockup v4" : "not the canonical Sablier Lockup"}
            </span>
          </Row>
        </Rows>
      )}
    </StatusBlock>
  );
}

type SolanaReading = { vault: { address: string; lamports: bigint } | null; gas: { address: string; lamports: bigint }; slot: number };

/** Solana devnet: vault and gas payer addresses with their SOL balances. */
export function SolanaBlock({ deployment, refreshKey }: BlockProps) {
  const fetcher = useCallback(
    async (signal: AbortSignal): Promise<SolanaReading> => {
      let vault = deployment.SOLANA_VAULT;
      let gas = deployment.SOLANA_GAS_PAYER;
      if (deployment.ENGINE_ACCOUNT) {
        try {
          const { config } = await fetchEngineConfig(deployment.ENGINE_ACCOUNT, { signal });
          vault = config.derived_addresses?.vault_sol ?? vault;
          gas = config.derived_addresses?.gas_sol ?? gas;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") throw error;
        }
      }
      if (!gas) throw new NotDeployedError("The engine's Solana addresses are not derived yet (bootstrap not run, no NEXT_PUBLIC_SOLANA_* fallback).");
      const [gasBalance, vaultBalance] = await Promise.all([solanaBalance(gas, { signal }), vault ? solanaBalance(vault, { signal }) : null]);
      return {
        vault: vault && vaultBalance ? { address: vault, lamports: vaultBalance.lamports } : null,
        gas: { address: gas, lamports: gasBalance.lamports },
        slot: gasBalance.slot,
      };
    },
    [deployment],
  );
  const query = useLiveQuery(fetcher, refreshKey);
  return (
    <StatusBlock
      title="Solana devnet"
      loadingHeight={136}
      description="The vault holds deposited streams; gas/sol pays the fees of every engine-built transaction."
      notDeployedHint="Vault and gas payer balances are read from the devnet RPC once the engine has derived its Solana addresses."
      badge={({ gas }) => (gas.lamports >= 100_000_000n ? { tone: "success", label: "Gas funded" } : { tone: "warning", label: "Gas low" })}
      {...query}
    >
      {({ vault, gas, slot }) => (
        <Rows>
          <Row label="Vault" mono>
            {vault ? (
              <>
                <ExternalLink href={solanaAddressUrl(vault.address)}>{vault.address}</ExternalLink>
                <span className="tabular ml-2 font-sans text-[12px] text-ink-400">{formatUnits(vault.lamports, LAMPORTS_DECIMALS, 4)} SOL</span>
              </>
            ) : (
              <Badge tone="warning">Not derived yet</Badge>
            )}
          </Row>
          <Row label="Gas payer" mono>
            <ExternalLink href={solanaAddressUrl(gas.address)}>{gas.address}</ExternalLink>
            <span className="tabular ml-2 font-sans text-[12px] text-ink-400">{formatUnits(gas.lamports, LAMPORTS_DECIMALS, 4)} SOL</span>
          </Row>
          <Row label="Slot">
            <span className="tabular">{formatCount(slot)} (finalized)</span>
          </Row>
          <Row label="Streamflow" mono>
            <ExternalLink href={solanaAddressUrl(FIXED_ADDRESSES.streamflowProgram)}>{FIXED_ADDRESSES.streamflowProgram}</ExternalLink>
          </Row>
        </Rows>
      )}
    </StatusBlock>
  );
}

type TokenReading = {
  near: { account: string; symbol: string; decimals: number; totalSupply: bigint };
  base: { address: string; symbol: string; decimals: number; totalSupply: bigint } | null;
};

type FtMetadata = { symbol: string; decimals: number };

/** Test USDC on NEAR testnet and Base Sepolia. */
export function CashTokensBlock({ deployment, refreshKey }: BlockProps) {
  const fetcher = useCallback(
    async (signal: AbortSignal): Promise<TokenReading> => {
      const [metadata, supply] = await Promise.all([
        viewCall<FtMetadata>(FIXED_ADDRESSES.nearTusdc, "ft_metadata", {}, { signal }),
        viewCall<string>(FIXED_ADDRESSES.nearTusdc, "ft_total_supply", {}, { signal }),
      ]);
      const near = { account: FIXED_ADDRESSES.nearTusdc, symbol: metadata.value.symbol, decimals: metadata.value.decimals, totalSupply: BigInt(supply.value) };
      const baseAddress = deployment.BASE_TUSDC;
      if (!baseAddress) return { near, base: null };
      const code = await ethGetCode(baseAddress, { signal });
      if (code === "0x") return { near, base: null };
      const [symbol, decimals, totalSupply] = await Promise.all([
        ethCall(baseAddress, SELECTORS["symbol()"], { signal }),
        ethCall(baseAddress, SELECTORS["decimals()"], { signal }),
        ethCall(baseAddress, SELECTORS["totalSupply()"], { signal }),
      ]);
      return { near, base: { address: baseAddress, symbol: decodeString(symbol), decimals: Number(decodeUint(decimals)), totalSupply: decodeUint(totalSupply) } };
    },
    [deployment],
  );
  const query = useLiveQuery(fetcher, refreshKey);
  return (
    <StatusBlock
      title="Test USDC"
      loadingHeight={224}
      description="The cash venues: rose tUSDC on NEAR (NEP-141) and on Base Sepolia (ERC-20), public mint capped per day."
      notDeployedHint="Symbols, decimals and total supply are read live from both chains."
      {...query}
    >
      {({ near, base }) => (
        <Rows>
          <Row label="NEAR" mono>
            <ExternalLink href={nearAccountUrl(near.account)}>{near.account}</ExternalLink>
          </Row>
          <Row label="Supply">
            <span className="tabular">
              {formatUnits(near.totalSupply, near.decimals, 2)} {near.symbol}
            </span>
          </Row>
          <Row label="Base" mono>
            {base ? <ExternalLink href={baseAddressUrl(base.address)}>{base.address}</ExternalLink> : <Badge tone="warning">Not deployed yet</Badge>}
          </Row>
          {base ? (
            <Row label="Supply">
              <span className="tabular">
                {formatUnits(base.totalSupply, base.decimals, 2)} {base.symbol}
              </span>
            </Row>
          ) : null}
          <Row label="Circle USDC" mono>
            <ExternalLink href={baseAddressUrl(FIXED_ADDRESSES.circleUsdcBase)}>{FIXED_ADDRESSES.circleUsdcBase}</ExternalLink>
            <span className="ml-2 font-sans text-[12px] text-ink-400">also accepted on Base</span>
          </Row>
        </Rows>
      )}
    </StatusBlock>
  );
}

type Verification = { event: StoredEvent; depositor: string; classId: string; allocation: string; positionId: string; decimals: number | null };

function toVerification(event: StoredEvent): Verification | null {
  if (event.event !== "position_registered") return null;
  const { depositor, class_id, allocation, position_id } = event.data;
  if (typeof depositor !== "string" || typeof class_id !== "string" || typeof allocation !== "string" || typeof position_id !== "string") return null;
  return { event, depositor, classId: class_id, allocation, positionId: position_id, decimals: null };
}

type ClassDecimals = { decimals: number } | null;

/** Recent ForeignTx verifications: every position registered after an MPC proof of the foreign deposit. */
export function VerificationsBlock({ deployment, refreshKey }: BlockProps) {
  const fetcher = useCallback(
    async (signal: AbortSignal) => {
      const account = requireEngine(deployment);
      const history = await fetchRecentEvents(account, 600, { signal });
      const verifications = history.events.map(toVerification).filter((item): item is Verification => item !== null);
      const recent = verifications.slice(-10).reverse();
      const classIds = [...new Set(recent.map((item) => item.classId))];
      const classes = await Promise.all(classIds.map((classId) => viewCall<ClassDecimals>(account, "get_class", { class_id: classId }, { signal })));
      const decimals = new Map(classIds.map((classId, index) => [classId, classes[index]!.value?.decimals ?? null]));
      return {
        verifications: recent.map((item) => ({ ...item, decimals: decimals.get(item.classId) ?? null })),
        total: verifications.length,
        window: history.events.length,
      };
    },
    [deployment],
  );
  const query = useLiveQuery(fetcher, refreshKey);
  return (
    <StatusBlock
      title="Recent ForeignTx verifications"
      loadingHeight={504}
      description="A position is registered only after the MPC network verified the deposit on Base or Solana."
      notDeployedHint="Each verified deposit (position_registered event) is listed here once the engine is deployed."
      badge={({ total }) => ({ tone: total > 0 ? "success" : "neutral", label: `${total} in window` })}
      {...query}
    >
      {({ verifications, window }) =>
        verifications.length === 0 ? (
          <p className="text-ink-300">No deposit has been verified in the last {formatCount(window)} events. The first registered position appears here.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-ink-750">
            <table className="w-full border-collapse text-[12px]">
              <thead className="bg-ink-900">
                <tr>
                  {["When", "Position", "Depositor", "Class", "Tokens"].map((label, index) => (
                    <th
                      key={label}
                      scope="col"
                      className={`px-3 py-1.5 font-display text-[11px] font-normal uppercase tracking-wide text-ink-400 ${index === 4 ? "text-right" : "text-left"}`}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {verifications.map((item) => (
                  <tr key={item.event.seq} className="border-t border-ink-800">
                    <td className="whitespace-nowrap px-3 py-1.5 text-ink-300">
                      <ExternalLink href={nearBlockUrl(item.event.block_height)}>{formatTime(nanosToMillis(item.event.timestamp))}</ExternalLink>
                    </td>
                    <td className="tabular px-3 py-1.5 text-ink-100">#{item.positionId}</td>
                    <td className="px-3 py-1.5 font-mono text-ink-100">
                      <ExternalLink href={nearAccountUrl(item.depositor)}>{item.depositor}</ExternalLink>
                    </td>
                    <td className="px-3 py-1.5 font-mono text-ink-300" title={item.classId}>
                      {shorten(item.classId, 8, 6)}
                    </td>
                    <td className="tabular whitespace-nowrap px-3 py-1.5 text-right text-ink-100" title={`${item.allocation} base units`}>
                      {item.decimals === null ? `${item.allocation} base units` : formatUnits(BigInt(item.allocation), item.decimals, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    </StatusBlock>
  );
}
