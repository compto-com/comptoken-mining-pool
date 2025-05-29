import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsBoolean,
    isHexadecimal,
    IsNumber,
    ValidateBy,
    ValidateIf,
    ValidationArguments,
} from 'class-validator';

import { Expose, Transform } from 'class-transformer';
import { eRequestMethod } from '../enums/eRequestMethod';
import { StratumBaseMessage } from './StratumBaseMessage';

// Helper type to ensure both version-rolling properties exist together or neither
type VersionRollingProps =
    | { 'version-rolling': true; 'version-rolling.mask': string }
    | { 'version-rolling': false }
    | Record<string, never>;

type ConfigurationResult = VersionRollingProps & {
    [key: string]: any;
};

function isVersionRollingMask() {
    return ValidateBy({
        name: 'isVersionRollingMask',
        validator: {
            validate: (value: any, args: ValidationArguments) => {
                const mask =
                    (args.object as ConfigurationMessage).params[1][
                        'version-rolling.mask'
                    ] ?? 'ffffffff';
                return isHexadecimal(mask);
            },
            defaultMessage: () =>
                'version-rolling.mask must be a hexadecimal string with a maximum length of 8 characters.',
        },
        constraints: [],
    });
}

export class ConfigurationMessage extends StratumBaseMessage {
    static readonly KNOWN_EXTENSIONS = ['version-rolling'];

    @ArrayMinSize(2)
    @ArrayMaxSize(2)
    @IsArray()
    params!: any[];

    @Expose()
    @IsArray()
    @Transform(({ value: _value, key: _key, obj, type: _type }) => {
        return obj.params[0].filter(
            (ext: string) =>
                !ConfigurationMessage.KNOWN_EXTENSIONS.includes(ext),
        );
    })
    unknownExtensions!: string[];

    @Expose()
    @IsBoolean()
    @Transform(({ obj }) => {
        return obj.params[0].includes('version-rolling');
    })
    versionRolling!: boolean;

    @Expose()
    @ValidateIf((obj: ConfigurationMessage) => obj.versionRolling)
    @IsNumber()
    @isVersionRollingMask()
    @Transform(({ obj }) => {
        return obj.params[0].includes('version-rolling')
            ? obj.params[1]['version-rolling.mask'] ?? 'ffffffff'
            : 'ffffffff'; // Default mask if not specified
    })
    @Transform(({ value: mask }) => {
        return parseInt(mask, 16) & 0x1fffe000;
    })
    versionRollingMask!: number;

    @Expose()
    @IsNumber()
    @Transform(({ value: _value, key: _key, obj, type: _type }) => {
        return obj.params[0].includes('version-rolling')
            ? obj.params[1]['version-rolling.min-bit-count'] ?? 0
            : 0;
    })
    versionRollingMinBitCount!: number;

    constructor() {
        super();
        this.method = eRequestMethod.CONFIGURE;
    }

    private getVersionRollingProps(): VersionRollingProps {
        if (this.versionRolling) {
            console.log(`version-rolling.mask: ${this.versionRollingMask}`);

            const bitCount = this.versionRollingMask
                .toString(2)
                .split('0')
                .join('').length;
            if (bitCount < this.versionRollingMinBitCount) {
                console.warn(
                    `Insufficient bit count for version-rolling: ${bitCount}`,
                );
            }

            return {
                'version-rolling': true,
                'version-rolling.mask': this.versionRollingMask.toString(16),
            };
        } else {
            console.log('version-rolling is disabled');
            return { 'version-rolling': false };
        }
    }

    public response() {
        const versionRolling = this.getVersionRollingProps();

        const result: ConfigurationResult = {
            ...versionRolling,
        };

        return {
            id: this.id,
            error: null,
            result,
        };
    }
}
