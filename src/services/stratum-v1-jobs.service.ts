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

import { IComptoBlockTemplate } from '../models/compto-rpc/ComptoBlockTemplate';
import { MiningJob } from '../models/MiningJob';
import { hasValue } from '../utils';
import { ComptoRpcService } from './compto-rpc.service';

export interface IJobTemplate {
    block: IComptoBlockTemplate;
    blockData: {
        id: string;
        networkDifficulty: number;
        clearJobs: boolean;
    };
}

@Injectable()
export class StratumV1JobsService {
    private lastIntervalCount?: number;
    private skipNext: boolean = false;
    public newMiningJob$: Observable<IJobTemplate>;

    public latestJobId: number = 1;
    public latestJobTemplateId: number = 1;

    public jobs: { [jobId: string]: MiningJob | undefined } = {};

    public blocks: { [id: string]: IJobTemplate | undefined } = {};

    // offset the interval so that all the cluster processes don't try and refresh at the same time.
    private delay = hasValue(process.env.NODE_APP_INSTANCE)
        ? parseInt(process.env.NODE_APP_INSTANCE) * 5000
        : 0;

    constructor(private readonly comptoRpcService: ComptoRpcService) {
        this.newMiningJob$ = combineLatest([
            this.comptoRpcService.newBlock$,
            interval(60000).pipe(delay(this.delay), startWith(-1)),
        ]).pipe(
            switchMap(([miningInfo, interval]) => {
                return of(
                    this.comptoRpcService.getBlockTemplate(miningInfo),
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

                const comptoJob: IJobTemplate = {
                    block: blockTemplate,
                    blockData: {
                        id: this.getNextTemplateId(),
                        networkDifficulty: this.calculateNetworkDifficulty(
                            parseInt(blockTemplate.bits, 16),
                        ),
                        clearJobs,
                    },
                };
                return comptoJob;
            }),
            filter((template) => hasValue(template)),
            map((template) => template as IJobTemplate), // Ensure type safety
            tap((template) => {
                if (template.blockData.clearJobs) {
                    this.blocks = {};
                    this.jobs = {};
                }
                this.blocks[template.blockData.id] = template;
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

    public getJobTemplateById(jobTemplateId: string) {
        return this.blocks[jobTemplateId];
    }

    public addJob(template: IJobTemplate) {
        const jobId = this.getNextId();
        const job = new MiningJob(jobId, template);
        this.jobs[job.jobId] = job;
        return job;
    }

    public getJobById(jobId: string) {
        return this.jobs[jobId];
    }

    public getNextTemplateId() {
        this.latestJobTemplateId++;
        return this.latestJobTemplateId.toString(16);
    }
    public getNextId() {
        this.latestJobId++;
        return this.latestJobId.toString(16);
    }
}
