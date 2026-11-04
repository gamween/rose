/**
 * Contextual "Learn more" targets: every topic maps to one section of the docs so UI copy can
 * link into the explanation without hard-coding paths across components.
 */

import { ROUTES } from "./routes";

export const LEARN_TOPICS = {
  sealedRounds: { href: `${ROUTES.docs}/sealed-rounds`, label: "How a sealed round works" },
  clearing: { href: `${ROUTES.docs}/clearing-rules`, label: "Clearing rules" },
  custody: { href: `${ROUTES.docs}/cross-chain-custody`, label: "Cross-chain custody" },
  trust: { href: `${ROUTES.docs}/trust-and-security`, label: "Trust and security model" },
  fees: { href: `${ROUTES.docs}/fees`, label: "Fees" },
  concepts: { href: `${ROUTES.docs}/concepts`, label: "Concepts" },
  contracts: { href: ROUTES.contracts, label: "Contracts and addresses" },
  wallets: { href: `${ROUTES.docs}/guide-holder`, label: "Holder guide" },
  issuer: { href: `${ROUTES.docs}/guide-issuer`, label: "Issuer guide" },
  buyer: { href: `${ROUTES.docs}/guide-buyer`, label: "Buyer guide" },
  faq: { href: `${ROUTES.docs}/faq`, label: "FAQ" },
  glossary: { href: `${ROUTES.docs}/glossary`, label: "Glossary" },
} as const;

export type LearnTopic = keyof typeof LEARN_TOPICS;

export function learnHref(topic: LearnTopic, anchor?: string): string {
  const base = LEARN_TOPICS[topic].href;
  return anchor ? `${base}#${anchor}` : base;
}
