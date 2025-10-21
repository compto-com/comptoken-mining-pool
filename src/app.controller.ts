import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Controller, Get, Inject } from '@nestjs/common';
import { Cache } from 'cache-manager';
import { firstValueFrom } from 'rxjs';

import { AddressSettingsService } from './ORM/address-settings/address-settings.service';
import { BlocksService } from './ORM/blocks/blocks.service';
import { ClientStatisticsService } from './ORM/client-statistics/client-statistics.service';
import { ClientService } from './ORM/client/client.service';
import { ComptoRpcService } from './services/compto-rpc.service';
import { hasValue } from './utils';

@Controller()
export class AppController {
    private uptime = new Date();

    constructor(
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly blocksService: BlocksService,
        private readonly comptoRpcService: ComptoRpcService,
        private readonly addressSettingsService: AddressSettingsService,
    ) {}

    @Get('info')
    public async info() {
        const CACHE_KEY = 'SITE_INFO';
        const cachedResult = await this.cacheManager.get(CACHE_KEY);

        if (hasValue(cachedResult)) {
            return cachedResult;
        }

        const blockData = await this.blocksService.getFoundBlocks();
        const userAgents = await this.clientService.getUserAgents();
        const highScores = await this.addressSettingsService.getHighScores();

        const data = {
            blockData,
            userAgents,
            highScores,
            uptime: this.uptime,
        };

        //1 min
        await this.cacheManager.set(CACHE_KEY, data, 1 * 60 * 1000);

        return data;
    }

    @Get('network')
    public async network() {
        const miningInfo = await firstValueFrom(
            this.comptoRpcService.newBlock$,
        );
        return miningInfo;
    }

    @Get('info/chart')
    public async infoChart() {
        const CACHE_KEY = 'SITE_HASHRATE_GRAPH';
        const cachedResult = await this.cacheManager.get(CACHE_KEY);

        if (hasValue(cachedResult)) {
            return cachedResult;
        }

        const chartData =
            await this.clientStatisticsService.getChartDataForSite();

        //10 min
        await this.cacheManager.set(CACHE_KEY, chartData, 10 * 60 * 1000);

        return chartData;
    }
}
