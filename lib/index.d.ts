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
    loglevel?: string;
    developmentLogging?: boolean;
};
declare type SelvaServer = {
    on: (type: 'log' | 'data' | 'close' | 'error', cb: (data: any) => void) => void;
    destroy: () => Promise<void>;
};
export declare const start: ({ port, service, modules, replica, verbose, loglevel, developmentLogging }: FnStart) => Promise<SelvaServer>;
export {};
