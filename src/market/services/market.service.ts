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
   * Retrieves market statistics including all-time high and low values
   * @returns Promise<MarketStatsDto> Market statistics including ATH and ATL
   */
  public async getMarketStats(): Promise<MarketStatsDto> {
    const [result] = await this.entityManager.query(`
      SELECT 
        COALESCE(MAX(total_value), 0) as all_time_high,
        COALESCE(MIN(total_value), 0) as all_time_low,
        (
          SELECT total_value 
          FROM market_history 
          ORDER BY created_at DESC 
          LIMIT 1
        ) as current_value,
        (
          SELECT market_trend 
          FROM market_history 
          ORDER BY created_at DESC 
          LIMIT 1
        ) as market_trend
      FROM market_history
    `);

    return {
      allTimeHigh: Number(result.all_time_high),
      allTimeLow: Number(result.all_time_low),
      currentValue: Number(result.current_value) || 0,
      marketTrend: result.market_trend || 'STABLE'
    };
  }
}
