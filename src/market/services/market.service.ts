import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { MarketStatsDto } from '../dtos/market-stats.dto';

/**
 * Service handling market-related operations and statistics
 */
@Injectable()
export class MarketService {
  constructor(
    @InjectEntityManager()
    private readonly entityManager: EntityManager,
  ) {}

  /**
   * Retrieves market statistics including all-time high, low values, and 24h price change
   * @returns Promise<MarketStatsDto> Market statistics including ATH, ATL and 24h change
   */
  public async getMarketStats(): Promise<MarketStatsDto> {
    const [result] = await this.entityManager.query(`
      WITH current_price AS (
        SELECT total_value, created_at
        FROM market_history
        ORDER BY created_at DESC
        LIMIT 1
      ),
      price_24h_ago AS (
        SELECT total_value
        FROM market_history
        WHERE created_at <= (SELECT created_at FROM current_price) - INTERVAL '24 hours'
        ORDER BY created_at DESC
        LIMIT 1
      ),
      earliest_price AS (
        SELECT total_value
        FROM market_history
        WHERE created_at <= (SELECT created_at FROM current_price)
        ORDER BY created_at ASC
        LIMIT 1
      )
      SELECT 
        COALESCE(MAX(mh.total_value), 0) as all_time_high,
        COALESCE(MIN(mh.total_value), 0) as all_time_low,
        cp.total_value as current_value,
        (
          SELECT market_trend 
          FROM market_history 
          ORDER BY created_at DESC 
          LIMIT 1
        ) as market_trend,
        COALESCE(p24.total_value, ep.total_value) as comparison_price
      FROM market_history mh
      CROSS JOIN current_price cp
      LEFT JOIN price_24h_ago p24 ON true
      LEFT JOIN earliest_price ep ON true
    `);

    const currentValue = Number(result.current_value) || 0;
    const comparisonPrice = Number(result.comparison_price) || currentValue;
    const priceChange24h = comparisonPrice === 0 ? 0 : ((currentValue - comparisonPrice) / comparisonPrice) * 100;

    return {
      allTimeHigh: Number(result.all_time_high),
      allTimeLow: Number(result.all_time_low),
      currentValue,
      marketTrend: result.market_trend || 'STABLE',
      priceChange24h: Number(priceChange24h.toFixed(2))
    };
  }
}
