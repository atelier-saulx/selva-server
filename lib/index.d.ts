/// <reference types="node" />
declare type Service = {
    port: number;
    host: string;
};
declare type FnStart = {
    port?: number | Promise<number>;
    service?: Service | Promise<Service>;
    replica?: Service | Promise<Service>;
    modules?: string[];
    verbose?: boolean;
};
export declare const start: ({ port, service, modules, replica, verbose }: FnStart) => Promise<import("child_process").ChildProcessWithoutNullStreams>;
export {};
