import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MarketService } from './services/market.service';
import { MarketController } from './controllers/market.controller';

@Module({
  imports: [TypeOrmModule.forFeature()],
  providers: [MarketService],
  controllers: [MarketController],
  exports: [MarketService],
})
export class MarketModule {}
