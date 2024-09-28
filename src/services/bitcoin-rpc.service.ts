import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RPCClient } from 'rpc-bitcoin';
import { BehaviorSubject, filter, shareReplay } from 'rxjs';
import { RpcBlockService } from 'src/ORM/rpc-block/rpc-block.service';
import * as zmq from 'zeromq';

import { IComptoBlockTemplate } from '../models/bitcoin-rpc/ComptoBlockTemplate';
// import { IMiningInfo } from '../models/bitcoin-rpc/IMiningInfo';
import * as fs from 'node:fs';

import * as compto from '@compto/comptoken-js-offchain';
import { Connection, PublicKey } from "@solana/web3.js";

@Injectable()
export class BitcoinRpcService implements OnModuleInit {

    private blockHash = null;
    private client: RPCClient;
    private _newBlock$: BehaviorSubject<Buffer> = new BehaviorSubject(undefined);
    public newBlock$ = this._newBlock$.pipe(filter(block => block != null), shareReplay({ refCount: true, bufferSize: 1 }));

    constructor(
        private readonly configService: ConfigService,
        private rpcBlockService: RpcBlockService
    ) {
    }

    async onModuleInit() {
        const url = this.configService.get('BITCOIN_RPC_URL');
        let user = this.configService.get('BITCOIN_RPC_USER');
        let pass = this.configService.get('BITCOIN_RPC_PASSWORD');
        const port = parseInt(this.configService.get('BITCOIN_RPC_PORT'));
        const timeout = parseInt(this.configService.get('BITCOIN_RPC_TIMEOUT'));

        const cookiefile = this.configService.get('BITCOIN_RPC_COOKIEFILE')

        // const { compto_program_id_pubkey } = await import('@compto/comptoken-js-offchain');
        // console.log(compto_program_id_pubkey);
        if (cookiefile != undefined && cookiefile != '') {
            const cookie = fs.readFileSync(cookiefile).toString().split(':')

            user = cookie[0]
            pass = cookie[1]
        }

        this.client = new RPCClient({ url, port, timeout, user, pass });

        this.client.getrpcinfo().then((res) => {
            console.log('Bitcoin RPC connected');
        }, () => {
            console.error('Could not reach RPC host');
        });

        if (this.configService.get('BITCOIN_ZMQ_HOST')) {
            console.log('Using ZMQ');
            const sock = new zmq.Subscriber;


            sock.connectTimeout = 1000;
            sock.events.on('connect', () => {
                console.log('ZMQ Connected');
            });
            sock.events.on('connect:retry', () => {
                console.log('ZMQ Unable to connect, Retrying');
            });

            sock.connect(this.configService.get('BITCOIN_ZMQ_HOST'));
            sock.subscribe('rawblock');
            // Don't await this, otherwise it will block the rest of the program
            this.listenForNewBlocks(sock);
            await this.pollMiningInfo();

            

        } else {
            setInterval(this.pollMiningInfo.bind(this), 10_000);
        }
    }

    private async listenForNewBlocks(sock: zmq.Subscriber) {
        for await (const [topic, msg] of sock) {
            console.log("New Block");
            await this.pollMiningInfo();
        }
    }

    public async pollMiningInfo() {
        
        const miningInfo = await this.getMiningInfo();
        if (this.blockHash == null || (miningInfo != null && !miningInfo.equals(this.blockHash))) {
            console.log("blockhash change!!!");
            this._newBlock$.next(miningInfo);
            this.blockHash = miningInfo;
        }
    }

    private async waitForBlock(blockHeight: number): Promise<IComptoBlockTemplate> {
        while (true) {
            await new Promise(r => setTimeout(r, 100));

            const block = await this.rpcBlockService.getBlock(blockHeight);
            if (block != null && block.data != null) {
                console.log(`promise loop resolved, block height ${blockHeight}`);
                return Promise.resolve(JSON.parse(block.data));
            }
            console.log(`promise loop, block height ${blockHeight}`);
        }
    }

    public getBlockTemplate(blockHash: Buffer): IComptoBlockTemplate {
        const blockTemplate: IComptoBlockTemplate = {
            version: 2,
            currentblockhash: blockHash.toString('hex'), // Example previous block hash
            // token account public key: 5N6p81LBD2qFoXPEskvtiPocAFagq1Ks36HFqiugEQVs
            transactions: ["40d6844ee09ff0aa305ad66e558a7957516b85a9b7d563211889fdeea87194fe"], // Array of strings as placeholders
            bits: "180eadd8", // Compressed target representation
            timestamp: Math.floor(new Date().getTime() / 1000), // Current timestamp in UNIX epoch time
        };
        // return Promise.resolve(blockTemplate);
        return blockTemplate
    //     let result: IBlockTemplate;
    //     try {
    //         const block = await this.rpcBlockService.getBlock(blockHeight);
    //         const completeBlock = block?.data != null;

    //         // If the block has already been loaded, and the same instance is fetching the template again, we just need to refresh it.
    //         if (completeBlock && block.lockedBy == process.env.NODE_APP_INSTANCE) {
    //             result = await this.loadBlockTemplate(blockHeight);
    //         }
    //         else if (completeBlock) {
    //             return Promise.resolve(JSON.parse(block.data));
    //         } else if (!completeBlock) {
    //             if (process.env.NODE_APP_INSTANCE != null) {
    //                 // There is a unique constraint on the block height so if another process tries to lock, it'll throw
    //                 try {
    //                     await this.rpcBlockService.lockBlock(blockHeight, process.env.NODE_APP_INSTANCE);
    //                 } catch (e) {
    //                     result = await this.waitForBlock(blockHeight);
    //                 }
    //             }
    //             result = await this.loadBlockTemplate(blockHeight);
    //         } else {
    //             //wait for block
    //             result = await this.waitForBlock(blockHeight);
    //         }
    //     } catch (e) {
    //         console.error('Error getblocktemplate:', e.message);
    //         console.error(e);
    //         throw new Error('Error getblocktemplate');
    //     }
    //     console.log(`getblocktemplate tx count: ${result.transactions.length}`);
    //     return result;
    }

    // private async loadBlockTemplate(blockHeight: number) {

    //     let blockTemplate: IBlockTemplate;
    //     while (blockTemplate == null) {
    //         blockTemplate = await this.client.getblocktemplate({
    //             template_request: {
    //                 rules: ['segwit'],
    //                 mode: 'template',
    //                 capabilities: ['serverlist', 'proposal']
    //             }
    //         });
    //     }


    //     await this.rpcBlockService.saveBlock(blockHeight, JSON.stringify(blockTemplate));

    //     return blockTemplate;
    // }

    public async getMiningInfo(): Promise<Buffer> {
        try {
            let connection = new Connection("https://api.devnet.solana.com");
            let getvalidblockhash: any = await compto.getValidBlockhashes(connection);
            console.log("getvalidblockhash", getvalidblockhash);
            console.log("getvalidblockhash", getvalidblockhash.validBlockhash);
            return getvalidblockhash.validBlockhash;
        } catch (e) {
            console.error('Error getmininginfo', e.message);
            return null;
        }
    }

    public async SUBMIT_BLOCK(hexdata: string): Promise<string> {
        let response: string = 'unknown';
        try {
            response = await this.client.submitblock({
                hexdata
            });
            if (response == null) {
                response = 'SUCCESS!';
            }
            console.log(`BLOCK SUBMISSION RESPONSE: ${response}`);
            console.log(hexdata);
            console.log(JSON.stringify(response));
        } catch (e) {
            response = e;
            console.log(`BLOCK SUBMISSION RESPONSE ERROR: ${e}`);
        }
        return response;

    }
}

