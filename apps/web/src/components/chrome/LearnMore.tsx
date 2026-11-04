import Link from "next/link";
import { cn } from "@/lib/cn";
import { LEARN_TOPICS, learnHref, type LearnTopic } from "@/lib/learn";

/** Inline "Learn more" link into the matching docs section. */
export function LearnMore({ topic, anchor, label, className }: { topic: LearnTopic; anchor?: string; label?: string; className?: string }) {
  return (
    <Link
      href={learnHref(topic, anchor)}
      className={cn("inline-flex items-center gap-1 font-display text-[11px] uppercase tracking-wide text-ember-300 underline-offset-2 hover:underline", className)}
      title={LEARN_TOPICS[topic].label}
    >
      {label ?? "Learn more"}
      <span aria-hidden>→</span>
    </Link>
  );
}
