import {Address, Cell, serializeTuple, TupleItem} from "ton-core";
import {base64Decode} from "../utils/base64";
const EmulatorModule = require('./emulator-emscripten.js');

export type GetMethodArgs = {
    code: Cell,
    data: Cell,
    methodId: number,
    stack: TupleItem[],
    config: Cell,
    verbosity: Verbosity
    libs?: Cell
    address: Address
    unixTime: number
    balance: bigint
    randomSeed: Buffer
    gasLimit: bigint
}

export type GetMethodResultSuccess = {
    success: true
    stack: string
    gas_used: string
    vm_exit_code: number
    vm_log: string
    c7: string
    missing_library: string | null
};

export type GetMethodResultError = {
    success: false
    error: string
};

export type GetMethodResult = {
    output: GetMethodResultSuccess | GetMethodResultError
    logs: string
};

export type RunTransactionArgs = {
    config: Cell
    libs: Cell | null
    verbosity: Verbosity
    shardAccount: Cell
    message: Cell
    now: number
    lt: bigint
    randomSeed: Buffer
}

type GetMethodInternalParams = {
    code: string
    data: string
    verbosity: number
    libs: string
    address: string
    unixtime: number
    balance: string
    rand_seed: string
    gas_limit: string
    method_id: number
};

type EmulationInternalParams = {
    utime: number
    lt: string
    rand_seed: string
    ignore_chksig: boolean
};

export type Verbosity = 'short' | 'full' | 'full_location' | 'full_location_stack'

type ResultSuccess = {
    success: true
    transaction: string
    shard_account: string
    vm_log: string
    c7: string | null
    actions: string | null
}

type ResultError = {
    success: false
    error: string
} & ({
    vm_log: string
    vm_exit_code: number
} | {})

export type EmulationResultSuccess = {
    success: true
    transaction: string
    shardAccount: string
    vmLog: string
    c7: string | null
    actions: string | null
}

export type VMResults = {
    vmLog: string
    vmExitCode: number
}

export type EmulationResultError = {
    success: false
    error: string
    vmResults?: VMResults
}

export type EmulationResult = {
    result: EmulationResultSuccess | EmulationResultError
    logs: string
}

const verbosityToNum: Record<Verbosity, number> = {
    'short': 0,
    'full': 1,
    'full_location': 2,
    'full_location_stack': 3,
}

class Pointer {
    length: number
    rawPointer: number
    inUse: boolean = true

    constructor(length: number, rawPointer: number) {
        this.length = length
        this.rawPointer = rawPointer
    }

    free() {
        this.inUse = false
    }
}

class Heap {
    private pointers: Pointer[] = []
    private module: any
    private maxPtrs: number = 0

    constructor(module: any) {
        this.module = module
    }

    getPointersForStrings(strs: string[]): number[] {
        this.maxPtrs = Math.max(this.maxPtrs, strs.length)
        const sorted = strs.map((str, i) => ({ str, i })).sort((a, b) => b.str.length - a.str.length)
        const ptrs = sorted.map(e => ({ i: e.i, ptr: this.getCStringPointer(e.str) })).sort((a, b) => a.i - b.i).map(e => e.ptr.rawPointer)
        this.pointers.sort((a, b) => b.length - a.length)
        this.pointers.slice(this.maxPtrs).forEach(ptr => this.module._free(ptr.rawPointer))
        this.pointers = this.pointers.slice(0, this.maxPtrs)
        this.pointers.forEach(p => p.free())
        return ptrs
    }

    getCStringPointer(data: string) {
        let length = this.module.lengthBytesUTF8(data) + 1

        let existing = this.pointers.find(p => p.length >= length && !p.inUse)

        if (existing) {
            this.module.stringToUTF8(data, existing.rawPointer, length);
            return existing
        }

        const len = this.module.lengthBytesUTF8(data) + 1;
        const ptr = this.module._malloc(len);
        this.module.stringToUTF8(data, ptr, len);
        let pointer = new Pointer(length, ptr)
        this.pointers.push(new Pointer(length, ptr))
        return pointer
    }
}

export class Executor {
    private module: any
    private heap: Heap
    private emulator?: {
        ptr: number
        configHash: Buffer
        verbosity: number
    }

    private constructor(module: any) {
        this.module = module
        this.heap = new Heap(module)
    }

    static async create() {
        return new Executor(await EmulatorModule({
            wasmBinary: base64Decode(require('./emulator-emscripten.wasm.js').EmulatorEmscriptenWasm),
            printErr: (text: string) => console.warn(text),
        }));
    }

    runGetMethod(args: GetMethodArgs): GetMethodResult {
        const params: GetMethodInternalParams = {
            code: args.code.toBoc().toString('base64'),
            data: args.data.toBoc().toString('base64'),
            verbosity: verbosityToNum[args.verbosity],
            libs: args.libs?.toBoc().toString('base64') ?? '',
            address: args.address.toString(),
            unixtime: args.unixTime,
            balance: args.balance.toString(),
            rand_seed: args.randomSeed.toString('hex'),
            gas_limit: args.gasLimit.toString(),
            method_id: args.methodId,
        };

        let stack = serializeTuple(args.stack)

        let result = this.invoke('_run_get_method', [
            JSON.stringify(params),
            stack.toBoc().toString('base64'),
            args.config.toBoc().toString('base64')
        ])

        const resp = JSON.parse(this.extractString(result))

        if ('fail' in resp && resp.fail) {
            throw new Error('message' in resp ? resp.message : 'Unknown emulation error');
        }

        return {
            logs: resp.logs,
            output: resp.output,
        };
    }

    runTransaction(args: RunTransactionArgs): EmulationResult {
        let params: EmulationInternalParams = {
            utime: args.now,
            lt: args.lt.toString(),
            rand_seed: args.randomSeed.toString('hex'),
            ignore_chksig: false
        }

        const resp = JSON.parse(this.extractString(this.invoke('_emulate', [
            this.getEmulatorPointer(args.config, verbosityToNum[args.verbosity]),
            args.libs?.toBoc().toString('base64') ?? 0,
            args.shardAccount.toBoc().toString('base64'),
            args.message.toBoc().toString('base64'),
            JSON.stringify(params)
        ])));

        if ('fail' in resp && resp.fail) {
            throw new Error('message' in resp ? resp.message : 'Unknown emulation error');
        }

        const logs: string = resp.logs;

        const result: ResultSuccess | ResultError = resp.output;

        return {
            result: result.success ? {
                success: true,
                transaction: result.transaction,
                shardAccount: result.shard_account,
                vmLog: result.vm_log,
                c7: result.c7,
                actions: result.actions,
            } : {
                success: false,
                error: result.error,
                vmResults: 'vm_log' in result ? {
                    vmLog: result.vm_log,
                    vmExitCode: result.vm_exit_code,
                } : undefined,
            },
            logs,
        };
    }

    private createEmulator(config: Cell, verbosity: number) {
        if (this.emulator !== undefined) {
            this.invoke('_destroy_emulator', [this.emulator.ptr]);
        }
        const ptr = this.invoke('_create_emulator', [config.toBoc().toString('base64'), verbosity]);
        this.emulator = {
            ptr,
            configHash: config.hash(),
            verbosity,
        };
    }

    private getEmulatorPointer(config: Cell, verbosity: number) {
        if (this.emulator === undefined || verbosity !== this.emulator.verbosity || !config.hash().equals(this.emulator.configHash)) {
            this.createEmulator(config, verbosity);
        }

        return this.emulator!.ptr;
    }

    invoke(method: string, args: (number | string)[]): number {
        const invocationArgs: number[] = []
        const strArgs: { str: string, i: number }[] = []
        for (let i = 0; i < args.length; i++) {
            const arg = args[i]
            if (typeof arg === 'string') {
                strArgs.push({ str: arg, i });
            } else {
                invocationArgs[i] = arg;
            }
        }
        const strPtrs = this.heap.getPointersForStrings(strArgs.map(e => e.str));
        for (let i = 0; i < strPtrs.length; i++) {
            invocationArgs[strArgs[i].i] = strPtrs[i];
        }

        return this.module[method](...invocationArgs);
    }

    private extractString(ptr: number): string {
        const str = this.module.UTF8ToString(ptr)
        this.module._free(ptr)
        return str
    }
}