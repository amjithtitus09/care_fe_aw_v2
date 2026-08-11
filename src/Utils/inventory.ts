import { addMonths, endOfMonth, isAfter } from "date-fns";

import careConfig from "@careConfig";

export type ExpiryStatus = "expired" | "expiring_soon" | "valid";

/**
 * Gets the expiry status of a product based on its expiration date
 * @param expirationDate - The expiration date string
 * @returns ExpiryStatus - "expired", "expiring_soon", or "valid"
 */
export function getExpiryStatus(
  expirationDate: string | undefined,
): ExpiryStatus {
  if (!expirationDate) return "valid";

  const expiryDate = new Date(expirationDate);
  const today = new Date();
  const currentMonthEnd = endOfMonth(today);
  const expiryMonthOffset = careConfig.inventory.expiryMonthOffset;

  // Check if expired (before current month end)
  if (!isAfter(expiryDate, currentMonthEnd)) return "expired";

  // Check if expiring soon (within the configured month offset)
  if (expiryMonthOffset !== null) {
    const referenceMonthEnd = endOfMonth(addMonths(today, expiryMonthOffset));
    if (!isAfter(expiryDate, referenceMonthEnd)) return "expiring_soon";
  }

  return "valid";
}

/**
 * Checks if a product is restricted based on its expiration date
 * (i.e., expired or expiring soon)
 * @param expirationDate - The expiration date string
 * @returns boolean - true if the product is expired or expiring soon
 */
export function isProductRestrictedFromDispensing(
  expirationDate: string | undefined,
): boolean {
  const status = getExpiryStatus(expirationDate);
  return status === "expired" || status === "expiring_soon";
}

/**
 * Checks if a lot is valid for selection (not expired, not expiring soon)
 * @param expirationDate - The expiration date string
 * @returns boolean - true if the lot is valid for selection
 */
export function isLotAllowedForDispensing(
  expirationDate: string | undefined,
): boolean {
  return !isProductRestrictedFromDispensing(expirationDate);
}

/**
 * Sorts inventory lots by earliest expiry first (FEFO - First Expired, First Out).
 * Lots without an expiration date are placed last.
 * @param inventories - The list of inventory lots to sort
 * @returns A new array sorted by earliest expiration date first
 */
export function sortInventoriesByExpiry<
  T extends { product: { expiration_date?: string } },
>(inventories: T[]): T[] {
  return [...inventories].sort((a, b) => {
    const aDate = a.product.expiration_date;
    const bDate = b.product.expiration_date;

    if (!aDate && !bDate) return 0;
    if (!aDate) return 1;
    if (!bDate) return -1;

    return new Date(aDate).getTime() - new Date(bDate).getTime();
  });
}

/**
 * Gets the badge variant for displaying expiry status
 * @param expirationDate - The expiration date string
 * @returns Badge variant - "destructive" for expired, "yellow" for expiring soon, "primary" for valid
 */
export function getExpiryBadgeVariant(
  expirationDate: string | undefined,
): "destructive" | "yellow" | "primary" {
  const status = getExpiryStatus(expirationDate);
  if (status === "expired") return "destructive";
  if (status === "expiring_soon") return "yellow";
  return "primary";
}
