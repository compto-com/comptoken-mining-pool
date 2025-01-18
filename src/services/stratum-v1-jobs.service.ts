import { Injectable } from '@nestjs/common';
import {
    combineLatest,
    delay,
    filter,
    interval,
    map,
    Observable,
    of,
    shareReplay,
    startWith,
    switchMap,
    tap,
} from 'rxjs';

import { IComptoBlockTemplate } from '../models/bitcoin-rpc/ComptoBlockTemplate';
import { MiningJob } from '../models/MiningJob';
import { BitcoinRpcService } from './bitcoin-rpc.service';

export interface IJobTemplate {
    block: IComptoBlockTemplate;
    blockData: {
        id: string;
        // coinbasevalue: number;
        networkDifficulty: number;
        // height: number;
        clearJobs: boolean;
    };
}

@Injectable()
export class StratumV1JobsService {
    private lastIntervalCount: number;
    private skipNext: boolean = false;
    public newMiningJob$: Observable<IJobTemplate>;

    public latestJobId: number = 1;
    public latestJobTemplateId: number = 1;

    public jobs: { [jobId: string]: MiningJob } = {};

    public blocks: { [id: number]: IJobTemplate } = {};

    // offset the interval so that all the cluster processes don't try and refresh at the same time.
    private delay =
        process.env.NODE_APP_INSTANCE == null
            ? 0
            : parseInt(process.env.NODE_APP_INSTANCE) * 5000;

    constructor(private readonly bitcoinRpcService: BitcoinRpcService) {
        this.newMiningJob$ = combineLatest([
            this.bitcoinRpcService.newBlock$,
            interval(60000).pipe(delay(this.delay), startWith(-1)),
        ]).pipe(
            switchMap(([miningInfo, interval]) => {
                return of(
                    this.bitcoinRpcService.getBlockTemplate(miningInfo),
                ).pipe(
                    map((blockTemplate) => {
                        return {
                            blockTemplate,
                            interval,
                        };
                    }),
                );
            }),
            map(({ blockTemplate, interval }) => {
                let clearJobs = false;
                if (this.lastIntervalCount === interval) {
                    clearJobs = true;
                    this.skipNext = true;
                    console.log('new block');
                }

                if (this.skipNext == true && clearJobs == false) {
                    this.skipNext = false;
                    return null;
                }

                this.lastIntervalCount = interval;

                const id = this.getNextTemplateId();
                this.latestJobTemplateId++;

                const comptoJob: IJobTemplate = {
                    block: blockTemplate,
                    blockData: {
                        id,
                        networkDifficulty: this.calculateNetworkDifficulty(
                            parseInt(blockTemplate.bits, 16),
                        ),
                        clearJobs,
                    },
                };
                return comptoJob;
            }),
            filter((next) => next != null),

            tap((data) => {
                if (data.blockData.clearJobs) {
                    this.blocks = {};
                    this.jobs = {};
                }
                this.blocks[data.blockData.id] = data;
            }),
            shareReplay({ refCount: true, bufferSize: 1 }),
        );
    }

    private calculateNetworkDifficulty(nBits: number) {
        const mantissa: number = nBits & 0x007fffff; // Extract the mantissa from nBits
        const exponent: number = (nBits >> 24) & 0xff; // Extract the exponent from nBits

        const target: number = mantissa * Math.pow(256, exponent - 3); // Calculate the target value

        const difficulty: number = (Math.pow(2, 208) * 65535) / target; // Calculate the difficulty

        console.log(`Network Difficulty: ${difficulty}`);
        return difficulty;
    }

    public getJobTemplateById(jobTemplateId: string): IJobTemplate | null {
        return this.blocks[jobTemplateId];
    }

    public addJob(job: MiningJob) {
        this.jobs[job.jobId] = job;
        this.latestJobId++;
    }

    public getJobById(jobId: string) {
        return this.jobs[jobId];
    }

    public getNextTemplateId() {
        return this.latestJobTemplateId.toString(16);
    }
    public getNextId() {
        return this.latestJobId.toString(16);
    }
}
