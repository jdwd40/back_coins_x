/**
 * Represents a currency value in GBP format
 */
export type GBPCurrency = string;

/**
 * Type guard to check if a value is a valid GBP currency string
 */
export function isGBPCurrency(value: unknown): value is GBPCurrency {
  if (typeof value !== 'string') return false;
  return /^£\d{1,3}(,\d{3})*(\.\d{2})?$/.test(value);
}
