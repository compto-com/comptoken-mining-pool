import { HttpModule } from '@nestjs/axios';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { ClientController } from './controllers/client/client.controller';
import { ComptokenAddressValidator } from './models/validators/bitcoin-address.validator';
import { AddressSettingsModule } from './ORM/address-settings/address-settings.module';
import { BlocksModule } from './ORM/blocks/blocks.module';
import { ClientStatisticsModule } from './ORM/client-statistics/client-statistics.module';
import { ClientModule } from './ORM/client/client.module';
import { RpcBlocksModule } from './ORM/rpc-block/rpc-block.module';
import { AppService } from './services/app.service';
import { BTCPayService } from './services/btc-pay.service';
import { ComptoRpcService } from './services/compto-rpc.service';
import { StratumV1JobsService } from './services/stratum-v1-jobs.service';
import { StratumV1Service } from './services/stratum-v1.service';

const ORMModules = [
    ClientStatisticsModule,
    ClientModule,
    AddressSettingsModule,
    BlocksModule,
    RpcBlocksModule,
];

@Module({
    imports: [
        ConfigModule.forRoot(),
        TypeOrmModule.forRoot({
            type: 'sqlite',
            database: './DB/public-pool.sqlite',
            synchronize: true,
            autoLoadEntities: true,
            logging: false,
            enableWAL: true,
            busyTimeout: 30 * 1000,
        }),
        CacheModule.register(),
        ScheduleModule.forRoot(),
        HttpModule,
        ...ORMModules,
    ],
    controllers: [AppController, ClientController],
    providers: [
        AppService,
        StratumV1Service,
        ComptoRpcService,
        ComptokenAddressValidator,
        StratumV1JobsService,
        BTCPayService,
    ],
})
export class AppModule {}
