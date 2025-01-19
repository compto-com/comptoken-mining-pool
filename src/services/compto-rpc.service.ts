import { Injectable, OnModuleInit } from '@nestjs/common';
import { BehaviorSubject, filter, shareReplay } from 'rxjs';

import { IComptoBlockTemplate } from '../models/compto-rpc/ComptoBlockTemplate';

import * as compto from '@compto/comptoken-js-offchain';
import { ConfigService } from '@nestjs/config';
import {
    getAssociatedTokenAddressSync,
    TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { Commitment, Connection } from '@solana/web3.js';

@Injectable()
export class ComptoRpcService implements OnModuleInit {
    private solana_url: URL;
    private commitment: Commitment;
    public connection: Connection;
    private blockHash = null;
    private _newBlock$: BehaviorSubject<Buffer> = new BehaviorSubject(
        undefined,
    );
    public newBlock$ = this._newBlock$.pipe(
        filter((block) => block != null),
        shareReplay({ refCount: true, bufferSize: 1 }),
    );

    constructor(private readonly configService: ConfigService) {}

    async onModuleInit() {
        this.solana_url = new URL(this.configService.get('SOLANA_URL'));
        this.commitment = this.configService.get('SOLANA_COMMITMENT');

        this.connection = new Connection(
            this.solana_url.toString(),
            this.commitment,
        );
        setInterval(this.pollMiningInfo.bind(this), 10_000);
    }

    public async pollMiningInfo() {
        const miningInfo = await this.getMiningInfo();
        if (
            this.blockHash == null ||
            (miningInfo != null && !miningInfo.equals(this.blockHash))
        ) {
            console.log('blockhash change!!!');
            this._newBlock$.next(miningInfo);
            this.blockHash = miningInfo;
        }
    }

    public getBlockTemplate(blockHash: Buffer): IComptoBlockTemplate {
        console.log('getBlockTemplate');
        let testuser_pubkey = getAssociatedTokenAddressSync(
            compto.comptoken_mint_pubkey,
            compto.test_account.publicKey,
            false,
            TOKEN_2022_PROGRAM_ID,
        );
        const hexTestComptoAccount = Buffer.from(
            testuser_pubkey.toBytes(),
        ).toString('hex');
        const blockTemplate: IComptoBlockTemplate = {
            version: 0x20000000,
            currentblockhash: blockHash.toString('hex'), // Example previous block hash
            transactions: [hexTestComptoAccount],
            bits: '180eadd8', // Compressed target representation
            timestamp: Math.floor(new Date().getTime() / 1000), // Current timestamp in UNIX epoch time
        };
        return blockTemplate;
    }

    public async getMiningInfo(): Promise<Buffer> {
        try {
            let getvalidblockhash: any = await compto.getValidBlockhashes(
                this.connection,
            );
            console.log('getvalidblockhash', getvalidblockhash);
            console.log('getvalidblockhash', getvalidblockhash.validBlockhash);
            return getvalidblockhash.validBlockhash;
        } catch (e) {
            console.error('Error getmininginfo', e.message);
            return null;
        }
    }
}
