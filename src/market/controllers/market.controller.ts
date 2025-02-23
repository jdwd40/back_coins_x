import { Controller, Get } from '@nestjs/common';
import { MarketService } from '../services/market.service';
import { MarketStatsDto } from '../dtos/market-stats.dto';

/**
 * Controller handling market-related endpoints
 */
@Controller('api/market')
export class MarketController {
  constructor(private readonly marketService: MarketService) {}

  /**
   * Get market statistics including all-time high and low values
   * @returns Promise<MarketStatsDto> Market statistics
   */
  @Get('stats')
  public async getMarketStats(): Promise<MarketStatsDto> {
    return this.marketService.getMarketStats();
  }

  /**
   * Health check endpoint for testing
   * @returns string Confirmation message
   */
  @Get('test')
  public async test(): Promise<string> {
    return 'Market API is working';
  }
}
