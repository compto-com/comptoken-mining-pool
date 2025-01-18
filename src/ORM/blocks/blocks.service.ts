import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BlocksEntity } from './blocks.entity';

@Injectable()
export class BlocksService {
    constructor(
        @InjectRepository(BlocksEntity)
        private blocksRepository: Repository<BlocksEntity>,
    ) {}

    public async save(block: Partial<BlocksEntity>) {
        await this.blocksRepository.save(block);
    }

    public async getFoundBlocks() {
        return await this.blocksRepository.find({
            select: {
                height: true,
                minerAddress: true,
                worker: true,
                sessionId: true,
            },
        });
    }

    public async getFoundBlocksByAddress(address: string) {
        return await this.blocksRepository.find({
            select: {
                height: true,
                minerAddress: true,
                worker: true,
                sessionId: true,
            },
            where: {
                minerAddress: address,
            },
        });
    }
}
