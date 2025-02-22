/**
 * Utility class for handling number formatting and conversion
 */
class CurrencyFormatter {
  /**
   * Format a number with 2 decimal places
   * @param {number} value - The number to format
   * @returns {number} Formatted number with 2 decimal places
   */
  static formatGBP(value) {
    if (value === null || value === undefined) {
      return 0.00;
    }
    return Number(Number(value).toFixed(2));
  }

  /**
   * Convert input to a number
   * @param {string|number} value - The value to convert
   * @returns {number} The numeric value
   */
  static convertToNumber(value) {
    try {
      // Handle number input directly
      if (typeof value === 'number') {
        const num = Number(value.toFixed(2));
        if (num < 0) throw new Error('NEGATIVE_PRICE');
        return num;
      }

      // Handle string input
      const cleanValue = String(value)
        // Remove pound symbol (both UTF-8 and ASCII versions)
        .replace(/£|&pound;|\u00A3/g, '')
        // Remove commas
        .replace(/,/g, '')
        .trim();
      
      // Parse to number
      const num = parseFloat(cleanValue);
      
      // Validate
      if (isNaN(num) || !isFinite(num)) {
        throw new Error('INVALID_FORMAT');
      }
      if (num < 0) {
        throw new Error('NEGATIVE_PRICE');
      }
      
      return Number(num.toFixed(2));
    } catch (err) {
      if (err.message === 'NEGATIVE_PRICE') {
        throw err;
      }
      throw new Error('INVALID_FORMAT');
    }
  }
}

module.exports = { CurrencyFormatter };
