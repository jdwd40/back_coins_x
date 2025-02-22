import { GBPCurrency, isGBPCurrency } from '../types/currency';

/**
 * Utility class for handling GBP currency formatting and conversion
 */
export class CurrencyFormatter {
  private static readonly CURRENCY_SYMBOL = '£';
  private static readonly NUMBER_FORMAT = new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  /**
   * Formats a number or currency string to GBP format
   * @param value - The value to format
   * @returns Formatted GBP currency string
   */
  public static formatGBP(value: number | string): GBPCurrency {
    if (typeof value === 'string' && isGBPCurrency(value)) {
      return value;
    }

    const numericValue = this.convertToNumber(value);
    return this.NUMBER_FORMAT.format(numericValue) as GBPCurrency;
  }

  /**
   * Converts a GBP currency string or number to a numeric value
   * @param value - The value to convert
   * @returns The numeric value
   */
  public static convertToNumber(value: number | string): number {
    if (typeof value === 'number') {
      return Number(value.toFixed(2));
    }

    if (!value) {
      return 0;
    }

    // Remove currency symbol and commas, then convert to number
    const numStr = value.replace(/[£,]/g, '');
    return Number(parseFloat(numStr).toFixed(2));
  }

  /**
   * Validates if a value is a valid GBP currency
   * @param value - The value to validate
   * @returns True if valid GBP currency
   */
  public static isValidGBP(value: unknown): boolean {
    if (typeof value === 'number') {
      return !isNaN(value) && isFinite(value);
    }
    return isGBPCurrency(value);
  }
}
