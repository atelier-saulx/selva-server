import { BackupFns } from './backups';
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
    backups?: {
        loadBackup?: boolean;
        scheduled?: {
            intervalInMinutes: number;
        };
        backupFns: BackupFns | Promise<BackupFns>;
    };
};
declare type SelvaServer = {
    on: (type: 'log' | 'data' | 'close' | 'error', cb: (data: any) => void) => void;
    destroy: () => Promise<void>;
    backup: () => Promise<void>;
};
export declare const start: ({ port: portOpt, service, modules, replica, verbose, loglevel, developmentLogging, backups }: FnStart) => Promise<SelvaServer>;
export {};
