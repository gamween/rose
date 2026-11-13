"use client";

import { createContext, useContext, type ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/Button";

/** Global panels of the `/app` shell that any page can open. */
export type AppActions = {
  /** Opens the "Get test funds" drawer (NEAR account, gas, tUSDC, demo positions). */
  openTestFunds: () => void;
  /** Opens the activity feed (the engine's recent on-chain events). */
  openActivity: () => void;
};

const AppActionsContext = createContext<AppActions | null>(null);

export function AppActionsProvider({ value, children }: { value: AppActions; children: ReactNode }) {
  return <AppActionsContext.Provider value={value}>{children}</AppActionsContext.Provider>;
}

/** The shell's global panels; only usable under `/app` (the `AppShell` provides them). */
export function useAppActions(): AppActions {
  const actions = useContext(AppActionsContext);
  if (!actions) throw new Error("useAppActions is used outside the /app shell");
  return actions;
}

/**
 * "Get test funds" as a button, for the empty states and blockers of a screen where the user
 * needs testnet assets (no NEAR account, no tUSDC, no position to deposit). Secondary by
 * default: it is rarely the screen's primary action.
 */
export function GetTestFundsButton({ children = "Get test funds", variant = "secondary", size = "sm", ...rest }: Omit<ButtonProps, "onClick">) {
  const { openTestFunds } = useAppActions();
  return (
    <Button variant={variant} size={size} onClick={openTestFunds} data-get-funds {...rest}>
      {children}
    </Button>
  );
}
