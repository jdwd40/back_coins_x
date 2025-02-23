/**
 * Data transfer object for market statistics
 */
export class MarketStatsDto {
  readonly allTimeHigh: number;
  readonly allTimeLow: number;
  readonly currentValue: number;
  readonly marketTrend: string;
  readonly priceChange24h: number;
}
