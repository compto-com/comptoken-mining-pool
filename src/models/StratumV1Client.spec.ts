import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Socket } from 'net';
import { BehaviorSubject } from 'rxjs';
import { DataSource } from 'typeorm';

import { MockRecording1 } from '../../test/models/MockRecording1';
import { AddressSettingsModule } from '../ORM/address-settings/address-settings.module';
import { ClientStatisticsEntity } from '../ORM/client-statistics/client-statistics.entity';
import { ClientStatisticsModule } from '../ORM/client-statistics/client-statistics.module';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientModule } from '../ORM/client/client.module';
import { ClientService } from '../ORM/client/client.service';
import { ComptoRpcService as MockComptoRpcService } from '../services/compto-rpc.service';
import { StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { StratumV1Client } from './StratumV1Client';

jest.mock('../services/compto-rpc.service');

jest.mock('./validators/bitcoin-address.validator', () => ({
    IsComptokenAddress() {
        return jest.fn();
    },
}));

describe('StratumV1Client', () => {
    let socket: Socket;
    let stratumV1JobsService: StratumV1JobsService;
    let comptoRpcService: MockComptoRpcService;

    let clientService: ClientService;
    let clientStatisticsService: ClientStatisticsService;

    let client: StratumV1Client;

    let socketEmitter: (...args: any[]) => void;

    const newBlockEmitter: BehaviorSubject<Buffer> = new BehaviorSubject(
        Buffer.alloc(0),
    );

    let moduleRef: TestingModule;

    beforeAll(async () => {
        moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'sqlite',
                    database: './DB/public-pool.test.sqlite',
                    synchronize: true,
                    autoLoadEntities: true,
                    cache: true,
                    logging: false,
                }),
                ClientModule,
                ClientStatisticsModule,
                AddressSettingsModule,
            ],
            providers: [
                {
                    provide: ConfigService,
                    useValue: {
                        get: jest.fn((key: string) => {
                            switch (key) {
                                case 'DEV_FEE_ADDRESS':
                                    return 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4';
                                case 'NETWORK':
                                    return 'testnet';
                            }
                            return null;
                        }),
                    },
                },
            ],
        }).compile();
    });

    beforeEach(async () => {
        console.log('========================================================');
        console.log('========================================================');
        console.log('========================================================');
        console.log('NEW TEST');
        console.log(expect.getState().currentTestName);

        clientService = moduleRef.get<ClientService>(ClientService);

        const dataSource = moduleRef.get<DataSource>(DataSource);

        dataSource.getRepository(ClientEntity).delete({});
        dataSource.getRepository(ClientStatisticsEntity).delete({});

        clientStatisticsService = moduleRef.get<ClientStatisticsService>(
            ClientStatisticsService,
        );

        comptoRpcService = new MockComptoRpcService(
            moduleRef.get(ConfigService),
        );
        jest.spyOn(comptoRpcService, 'getBlockTemplate').mockReturnValue(
            MockRecording1.BLOCK_TEMPLATE,
        );
        comptoRpcService.newBlock$ = newBlockEmitter.asObservable();

        stratumV1JobsService = new StratumV1JobsService(comptoRpcService);

        socket = new Socket();

        jest.spyOn(socket, 'on').mockImplementation(
            (event: string, listener: (...args: any[]) => void) => {
                socketEmitter = listener;
                return socket;
            },
        );

        socket.end = jest.fn();

        client = new StratumV1Client(
            socket,
            stratumV1JobsService,
            clientService,
            clientStatisticsService,
            comptoRpcService,
        );

        client.extraNonceAndSessionId = MockRecording1.EXTRA_NONCE;

        jest.useFakeTimers({ advanceTimers: true });
    });

    afterEach(async () => {
        if (client) {
            client.destroy();
        }
        jest.useRealTimers();
    });

    it('should subscribe to socket', () => {
        expect(socket.on).toHaveBeenCalled();
    });

    it('should close socket on invalid JSON', () => {
        socketEmitter(Buffer.from('INVALID'));
        jest.spyOn(socket, 'destroy');
        expect(socket.on).toHaveBeenCalled();
    });

    it('should respond to mining.subscribe', async () => {
        jest.spyOn(socket, 'write').mockImplementation((_data) => true);

        expect(socket.on).toHaveBeenCalled();
        socketEmitter(Buffer.from(MockRecording1.MINING_SUBSCRIBE));

        await new Promise((r) => setTimeout(r, 1));

        expect(socket.write).toHaveBeenCalledWith(
            `{"id":1,"error":null,"result":[[["mining.notify","${client.extraNonceAndSessionId}"]],"${client.extraNonceAndSessionId}",4]}\n`,
            expect.any(Function),
        );
    });

    it('should respond to mining.configure', async () => {
        jest.spyOn(socket, 'write').mockImplementation((_data) => true);

        expect(socket.on).toHaveBeenCalled();
        socketEmitter(Buffer.from(MockRecording1.MINING_CONFIGURE));
        await new Promise((r) => setTimeout(r, 1));
        expect(socket.write).toHaveBeenCalledWith(
            `{"id":2,"error":null,"result":{"version-rolling":true,"version-rolling.mask":"1fffe000"}}\n`,
            expect.any(Function),
        );
    });

    it('should respond to mining.authorize', async () => {
        jest.spyOn(socket, 'write').mockImplementation((_data) => true);

        expect(socket.on).toHaveBeenCalled();
        socketEmitter(Buffer.from(MockRecording1.MINING_AUTHORIZE));
        await new Promise((r) => setTimeout(r, 1));
        expect(socket.write).toHaveBeenCalledWith(
            '{"id":3,"error":null,"result":true}\n',
            expect.any(Function),
        );
    });

    it('should ignore mining.suggest_difficulty', async () => {
        jest.spyOn(socket, 'write').mockImplementation((_data) => true);

        expect(socket.on).toHaveBeenCalled();
        socketEmitter(Buffer.from(MockRecording1.MINING_SUGGEST_DIFFICULTY));
        await new Promise((r) => setTimeout(r, 1));
        expect(socket.write).not.toHaveBeenCalled();
    });

    it('should set difficulty', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((_data) =>
            Promise.resolve(true),
        );

        console.log('should set difficulty');
        socketEmitter(Buffer.from(MockRecording1.MINING_SUBSCRIBE));
        socketEmitter(Buffer.from(MockRecording1.MINING_AUTHORIZE));
        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).write).toHaveBeenCalledWith(
            `{"id":null,"method":"mining.set_difficulty","params":[16384]}\n`,
        );
    });

    it('should save client', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((_data) =>
            Promise.resolve(true),
        );

        socketEmitter(Buffer.from(MockRecording1.MINING_SUBSCRIBE));
        socketEmitter(Buffer.from(MockRecording1.MINING_AUTHORIZE));
        await new Promise((r) => setTimeout(r, 100));

        const clientCount = await clientService.connectedClientCount();
        expect(clientCount).toBe(1);
    });

    it('should send job and accept submission', async () => {
        const date = new Date(parseInt(MockRecording1.TIME, 16) * 1000);

        jest.setSystemTime(date);

        jest.spyOn(client as any, 'write').mockImplementation((_data) =>
            Promise.resolve(true),
        );

        (comptoRpcService.mineComptokens as jest.Mock).mockImplementation(() =>
            Promise.resolve({ result: 'mocked result' }),
        );

        socketEmitter(Buffer.from(MockRecording1.MINING_SUBSCRIBE));
        socketEmitter(Buffer.from(MockRecording1.MINING_SUGGEST_DIFFICULTY));
        socketEmitter(Buffer.from(MockRecording1.MINING_AUTHORIZE));

        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).write).toHaveBeenLastCalledWith(
            JSON.stringify({
                id: null,
                method: 'mining.notify',
                params: [
                    '1',
                    '171592f223740e92d223f6e68bff25279af7ac4f2246451e0000000200000000',
                    '', // coinbasePart1
                    '', // coinbasePart2
                    [], // transactions
                    '20000000', // version
                    '192495f8', // bits
                    MockRecording1.TIME, // timestamp
                    false, // clearJobs
                ],
            }) + '\n',
        );

        socketEmitter(Buffer.from(MockRecording1.MINING_SUBMIT));

        jest.useRealTimers();
        await new Promise((r) => setTimeout(r, 1000));

        expect((client as any).write).toHaveBeenLastCalledWith(
            `{\"id\":5,\"error\":null,\"result\":true}\n`,
        );
    });
});
