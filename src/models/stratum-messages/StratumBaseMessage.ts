import { IsDefined, IsEnum } from 'class-validator';

import { eRequestMethod } from '../enums/eRequestMethod';

export abstract class StratumBaseMessage {
    @IsDefined()
    id: number | string | null = null;

    @IsEnum(eRequestMethod)
    method!: eRequestMethod; // assigned in subclasses
}
