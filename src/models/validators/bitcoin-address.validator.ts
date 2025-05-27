import { Injectable } from '@nestjs/common';
import { PublicKey } from '@solana/web3.js';
import {
    registerDecorator,
    ValidationOptions,
    ValidatorConstraint,
    ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'ComptokenAddress', async: false })
@Injectable()
export class ComptokenAddressValidator implements ValidatorConstraintInterface {
    validate(value: string): boolean {
        return true; // originally validated bitcoin addresses, disabled for now b/c it doesn't work yet
        try {
            new PublicKey(value);
            // TODO: Check if it's a token account with the correct mint
            return true;
        } catch (e) {
            return false;
        }
    }

    defaultMessage(): string {
        return 'Must be a comptoken address';
    }
}

export function IsComptokenAddress(validationOptions?: ValidationOptions) {
    return function (object: object, propertyName: string) {
        registerDecorator({
            name: 'isBitcoinAddress',
            target: object.constructor,
            propertyName: propertyName,
            constraints: [],
            options: validationOptions,
            validator: ComptokenAddressValidator,
        });
    };
}
