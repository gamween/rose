import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { VoxelArt, type VoxelPreset } from "./VoxelArt";

export function EmptyState({
  title,
  description,
  action,
  illustration = "vault",
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  illustration?: VoxelPreset;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-10 text-center", className)}>
      <div className="relative mb-5 flex items-center justify-center">
        <span aria-hidden className="dither-glow absolute size-28 opacity-60" />
        <VoxelArt preset={illustration} size={88} className="relative" />
      </div>
      <h3 className="text-[14px] text-ink-50 font-semibold">{title}</h3>
      {description ? <p className="mt-1.5 max-w-sm text-[13px] text-ink-400">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
