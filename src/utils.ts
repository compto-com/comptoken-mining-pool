export function hasValue<T>(value: T | null | undefined): value is T {
    return value !== null && value !== undefined;
}

// for some reason importing 'assert' from 'node:assert' isn't working
export function assert(condition: any, message?: string): asserts condition {
    if (!condition) {
        throw new Error(message || 'Assertion failed');
    }
}
