import { SendBackup } from '../../backups';
import { DropboxOptions } from 'dropbox';
export default function mkBackupFn(opts: DropboxOptions, path: string): Promise<SendBackup>;
