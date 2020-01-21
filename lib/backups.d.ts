export declare type SendBackup = (rdbFilePath: string) => Promise<void>;
export declare function saveAndBackUp(redisDir: string, redisPort: number, backupFn: SendBackup): Promise<void>;
export declare function scheduleBackups(redisDir: string, redisPort: number, intervalInMinutes: number, backupFn: SendBackup): Promise<void>;
