"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

type DialogProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
};

/** Native `<dialog>` opened with `showModal()`: focus trap, Escape and inert background come from the platform. */
function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handleCancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [onClose]);
  return ref;
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close"
      className="flex size-7 shrink-0 items-center justify-center rounded-sm text-ink-400 hover:bg-ink-800 hover:text-ink-100"
    >
      <svg viewBox="0 0 8 8" width="9" height="9" shapeRendering="crispEdges" aria-hidden>
        <path d="M0 0h1v1H0zM1 1h1v1H1zM2 2h1v1H2zM3 3h2v2H3zM5 2h1v1H5zM6 1h1v1H6zM7 0h1v1H7zM2 5h1v1H2zM1 6h1v1H1zM0 7h1v1H0zM5 5h1v1H5zM6 6h1v1H6zM7 7h1v1H7z" fill="currentColor" />
      </svg>
    </button>
  );
}

export function Modal({ open, onClose, title, description, children, footer, className }: DialogProps) {
  const ref = useDialog(open, onClose);
  return (
    <dialog
      ref={ref}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className={cn(
        "m-auto w-[calc(100%-32px)] max-w-lg rounded-lg border border-ink-700 bg-ink-850 p-0 text-ink-100 shadow-2xl backdrop:bg-ink-950/80 backdrop:backdrop-blur-[2px]",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4 border-b border-ink-750 px-5 py-4">
        <div>
          <h2 className="font-display text-[15px] text-ink-50">{title}</h2>
          {description ? <p className="mt-1 text-[13px] text-ink-400">{description}</p> : null}
        </div>
        <CloseButton onClose={onClose} />
      </div>
      <div className="px-5 py-4">{children}</div>
      {footer ? <div className="flex justify-end gap-2 border-t border-ink-750 px-5 py-3">{footer}</div> : null}
    </dialog>
  );
}

export function Drawer({ open, onClose, title, description, children, footer, className }: DialogProps) {
  const ref = useDialog(open, onClose);
  return (
    <dialog
      ref={ref}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className={cn(
        "ml-auto mr-0 mt-0 mb-0 h-dvh max-h-dvh w-[min(420px,100%)] max-w-none border-l border-ink-700 bg-ink-900 p-0 text-ink-100 backdrop:bg-ink-950/70",
        className,
      )}
    >
      <div className="flex h-full flex-col">
        <div className="flex items-start justify-between gap-4 border-b border-ink-750 px-5 py-4">
          <div>
            <h2 className="font-display text-[15px] text-ink-50">{title}</h2>
            {description ? <p className="mt-1 text-[13px] text-ink-400">{description}</p> : null}
          </div>
          <CloseButton onClose={onClose} />
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-ink-750 px-5 py-3">{footer}</div> : null}
      </div>
    </dialog>
  );
}
