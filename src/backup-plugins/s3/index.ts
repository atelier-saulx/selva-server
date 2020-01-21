import { SendBackup } from '../../backups'
import { createApi, S3Api } from './s3api'

type S3Opts = {
  config: {
    accessKeyId: string
    secretAccessKey: string
  }
  endpoint: string
  bucketName: string
  backupRetentionInDays: number
}

async function cleanUpOldBackups(
  s3: S3Api,
  bucketName: string,
  retentionInDays: number
): Promise<void> {
  const objects = await s3.listObjects(bucketName)
  const oldBackups = objects.filter(object => {
    const validSince = new Date(
      Date.now() - 1000 * 60 * 60 * 12 * retentionInDays
    )
    return object.LastModified < validSince
  })

  await Promise.all(
    oldBackups.map(object => {
      return s3.deleteObject(bucketName, object.Key)
    })
  )
}

export default async function mkBackupFn(opts: S3Opts): Promise<SendBackup> {
  const { endpoint, backupRetentionInDays, bucketName, config } = opts
  const s3 = createApi(config, endpoint)
  await s3.ensureBucket(bucketName, 'private')

  return async (rdbFilePath: string) => {
    const dstFilepath = new Date().toISOString()
    await s3.storeFile(bucketName, dstFilepath, rdbFilePath)
    // await cleanUpOldBackups(s3, bucketName, backupRetentionInDays)
  }
}
