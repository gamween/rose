import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

/** The block itself (`.ui-block` in globals.css): lit top edge, hard bottom face, sinks when pressed. */
const base =
  "ui-block inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium disabled:pointer-events-none [&_svg]:shrink-0";

const sizes: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[12px]",
  md: "h-9 px-3.5 text-[13px]",
  lg: "h-11 px-5 text-[14px]",
};

const iconSizes: Record<ButtonSize, string> = { sm: "size-7", md: "size-9", lg: "size-11" };

function buttonClasses(size: ButtonSize, className?: string): string {
  return cn(base, sizes[size], className);
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  loadingLabel?: string;
  icon?: ReactNode;
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  loadingLabel,
  icon,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      data-variant={variant}
      className={buttonClasses(size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner label={loadingLabel ?? "Working"} /> : icon}
      <span>{loading && loadingLabel ? loadingLabel : children}</span>
    </button>
  );
}

export type ButtonLinkProps = ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize };

export function ButtonLink({ variant = "primary", size = "md", className, ...rest }: ButtonLinkProps) {
  return <Link data-variant={variant} className={buttonClasses(size, className)} {...rest} />;
}

/** A square block holding one icon; `label` is its accessible name and tooltip. */
export function IconButton({
  label,
  variant = "secondary",
  size = "md",
  className,
  children,
  type = "button",
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & { label: string; variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button type={type} aria-label={label} title={label} data-variant={variant} className={cn(base, iconSizes[size], "px-0", className)} {...rest}>
      {children}
    </button>
  );
}
