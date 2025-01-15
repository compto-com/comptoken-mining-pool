import { IJobTemplate } from '../services/stratum-v1-jobs.service';
import { eResponseMethod } from './enums/eResponseMethod';
import { IMiningNotify } from './stratum-messages/IMiningNotify';

export class MiningJob {
    public jobTemplateId: string;
    public networkDifficulty: number;

    constructor(
        public jobId: string,
        jobTemplate: IJobTemplate
    ) {
        this.jobTemplateId = jobTemplate.blockData.id;
    }

    public response(jobTemplate: IJobTemplate): string {
        let currentBlockhashNaturalOrder = this.swapEndianStrings(this.reverseHexString(jobTemplate.block.currentblockhash));
        const job: IMiningNotify = {
            id: null,
            method: eResponseMethod.MINING_NOTIFY,
            params: [
                this.jobId,
                currentBlockhashNaturalOrder,
                "", // this.coinbasePart1,
                "", // this.coinbasePart2,
                jobTemplate.block.transactions,
                jobTemplate.block.version.toString(16),
                jobTemplate.block.bits,
                jobTemplate.block.timestamp.toString(16),
                jobTemplate.blockData.clearJobs
            ]
        };
        console.log('Mining Notify ----------->>')
        console.log(JSON.stringify(job) + '\n');
        return JSON.stringify(job) + '\n';
    }

    private swapEndianStrings(beString: string): string {
        return this.swapEndianWords(Buffer.from(beString, 'hex')).toString('hex');
    }

    private swapEndianWords(buffer: Buffer): Buffer {
        const swappedBuffer = Buffer.from(buffer)
        swappedBuffer.swap32();
        return swappedBuffer;
    }

    private reverseHexString(hexString: string): string {
        // Ensure the string length is even (each byte is 2 characters)
        if (hexString.length % 2 !== 0) {
            throw new Error("Invalid hex string length");
        }
        // Split the string into pairs of two characters (bytes)
        const byteArray = hexString.match(/.{2}/g);
        if (!byteArray) {
            return ''; // Return an empty string if the hex string was empty
        }
        const reversedArray = byteArray.reverse();
        return reversedArray.join('');
    }
}
