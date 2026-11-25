import { friendlyError } from "../chain.js";

const HINTS = {
  CloseOnly: "This market is close-only until the scheduled index print lands. You can still close or reduce.",
  WithdrawLocked: "Your withdrawal is still in its 24h cooldown.",
  WithdrawExpired: "The withdrawal window expired. Cancel and request again.",
  WithdrawPending: "You already have a pending withdrawal. Cancel it first to change the amount.",
  ExceedsPending: "That is more shares than you have available.",
  PoolInsolvent: "The pool has no value left to mint shares against.",
  FlipNotAllowed: "Reducing past zero would flip the position. Close it instead.",
  NoPosition: "You have no position in this market.",
  ZeroAmount: "Enter an amount greater than zero.",
  MarketInactive: "This market is paused.",
};

export function friendly(e) {
  const name = e?.revert?.name || e?.info?.error?.data?.errorName || (e?.shortMessage || e?.message || "").match(/(?:custom error|reverted with custom error) '(\w+)/)?.[1];
  if (name && HINTS[name]) return HINTS[name];
  if (e?.code === "ACTION_REJECTED") return "Transaction rejected in wallet.";
  return friendlyError(e);
}
