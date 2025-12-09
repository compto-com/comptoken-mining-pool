import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Socket } from 'net';
import { BehaviorSubject } from 'rxjs';
import { DataSource } from 'typeorm';

import { MockRecording1 } from '../../test/models/MockRecording1';
import { AddressSettingsModule } from '../ORM/address-settings/address-settings.module';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientModule } from '../ORM/client/client.module';
import { ClientService } from '../ORM/client/client.service';
import { ComptoRpcService as MockComptoRpcService } from '../services/compto-rpc.service';
import { StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { hasValue } from '../utils';
import { StratumV1Client } from './StratumV1Client';

jest.mock('./validators/comptoken-address.validator', () => ({
    IsComptokenAddress() {
        return jest.fn();
    },
}));

// Mock external dependencies to avoid real network/API
jest.mock('@compto/comptoken.js', () => {
    class ComptokenProof {
        static TARGET_BYTES = new Uint8Array(32);
        static TARGET_BYTES_DEVNET = new Uint8Array(32);
        constructor(args: any) {
            Object.assign(this, args);
        }
    }

    const addresses = {
        getUnstakedMintAddress: jest.fn(() => ({
            toBuffer: () => Buffer.alloc(32, 10),
        })),
        getUserUnstakedAssociatedTokenAddress: jest.fn(
            (_program: any, _pubkey: any) => ({
                toBuffer: () => Buffer.alloc(32, 11),
            }),
        ),
    };

    const transactions = {
        getValidBlockhashes: jest.fn(async () => ({
            result: { valid: Buffer.alloc(32, 7) },
        })),
        submitMiningProof: jest.fn(async () => 'tx-sig'),
    };

    const createComptokenProgram = jest.fn((_idl: any, _provider: any) => ({
        constants: { mintDecimals: 2 },
    }));

    const getDefaultComptokenIdl = jest.fn(() => ({}));

    return {
        addresses,
        ComptokenProof,
        createComptokenProgram,
        getDefaultComptokenIdl,
        transactions,
    };
});

jest.mock('@solana/web3.js', () => {
    const PublicKey = jest.fn().mockImplementation((_v?: any) => ({
        toBuffer: () => Buffer.alloc(32, 8),
    }));
    const Keypair = {
        fromSecretKey: jest.fn(() => ({
            publicKey: new (PublicKey as any)(),
        })),
    };
    return {
        clusterApiUrl: jest.fn(() => 'http://localhost:8899'),
        Connection: jest.fn().mockImplementation(() => ({})),
        PublicKey,
        Keypair,
        sendAndConfirmTransaction: jest.fn(async () => 'tx-sig'),
        Transaction: jest.fn().mockImplementation(() => ({
            add: jest.fn(),
        })),
    };
});

jest.mock('@solana/spl-token', () => ({
    getAssociatedTokenAddressSync: jest.fn(() => ({
        toBuffer: () => Buffer.alloc(32, 9),
    })),
    createTransferCheckedWithTransferHookInstruction: jest.fn(async () => ({
        ix: true,
    })),
    TOKEN_2022_PROGRAM_ID: 'token-2022',
}));

describe('StratumV1Client', () => {
    let socket: Socket;
    let stratumV1JobsService: StratumV1JobsService;
    let comptoRpcService: MockComptoRpcService;

    let clientService: ClientService;

    let client: StratumV1Client;

    let socketEmitter: (...args: any[]) => void;

    const newBlockEmitter = new BehaviorSubject(Buffer.alloc(0));

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
                                case 'SOLANA_USER':
                                    return '[139,213,84,120,244,40,122,74,179,90,146,128,49,120,237,17,191,242,118,123,14,170,241,142,42,39,157,78,139,34,95,63,255,22,35,190,4,231,156,200,108,132,200,209,236,204,10,79,198,65,98,199,1,96,246,42,208,183,163,32,54,176,27,238]';
                                case 'SOLANA_CLUSTER':
                                    return 'devnet';
                                case 'SOLANA_COMMITMENT':
                                    return 'confirmed';
                            }
                            return null;
                        }),
                        getOrThrow: function (key: string) {
                            const value = this.get(key);
                            if (!hasValue(value)) {
                                throw new Error(`Config key ${key} not found`);
                            }
                            return value;
                        },
                    },
                },
            ],
        }).compile();
    });

    beforeEach(async () => {
        clientService = moduleRef.get<ClientService>(ClientService);

        const dataSource = moduleRef.get<DataSource>(DataSource);
        await dataSource.getRepository(ClientEntity).delete({});

        comptoRpcService = new MockComptoRpcService(
            moduleRef.get(ConfigService),
        );
        // Minimal internal state to allow verifyProof to run without onModuleInit
        (comptoRpcService as any).blockHash = Buffer.alloc(32, 1);
        // Ensure program is initialized for fee processing paths
        (comptoRpcService as any).comptoken_program = {
            constants: { mintDecimals: 2 },
        } as any;

        jest.spyOn(comptoRpcService, 'getBlockTemplate').mockReturnValue(
            MockRecording1.BLOCK_TEMPLATE,
        );
        comptoRpcService.newBlock$ = newBlockEmitter.asObservable();

        stratumV1JobsService = new StratumV1JobsService(comptoRpcService);

        socket = new Socket();

        jest.spyOn(socket, 'on').mockImplementation(
            (_event: string, listener: (...args: any[]) => void) => {
                socketEmitter = listener;
                return socket;
            },
        );

        socket.end = jest.fn();

        client = new StratumV1Client(
            socket,
            stratumV1JobsService,
            clientService,
            comptoRpcService,
            moduleRef.get(ConfigService),
        );

        client.extraNonceAndSessionId = MockRecording1.EXTRA_NONCE;

        jest.useFakeTimers({ advanceTimers: true });
    });

    afterEach(async () => {
        if (hasValue(client)) {
            await client.destroy();
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
        socketEmitter(Buffer.from(MockRecording1.MINING_SUBMIT));
        await new Promise((r) => setTimeout(r, 100));
        await clientService.insertClients();

        const clientCount = await clientService.connectedClientCount();
        expect(clientCount).toBe(1);
    });

    it('should send job and accept submission', async () => {
        const date = new Date(parseInt(MockRecording1.TIME, 16) * 1000);
        jest.setSystemTime(date);

        jest.spyOn(client as any, 'write').mockImplementation((_data) =>
            Promise.resolve(true),
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
                    '2', // jobId
                    '171592f223740e92d223f6e68bff25279af7ac4f2246451e0000000200000000', // currentBlockhash
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
            `{"id":5,"error":null,"result":true}\n`,
        );
    });

    afterAll(async () => {
        try {
            const dataSource = moduleRef.get<DataSource>(DataSource);
            if (dataSource && dataSource.isInitialized) {
                await dataSource.destroy();
            }
        } catch (_e) {
            // ignore
        }
        await moduleRef.close();
    });
});
