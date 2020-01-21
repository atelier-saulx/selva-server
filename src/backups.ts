import { promises as fs } from 'fs'
import { createClient, RedisClient } from 'redis'
import { join as pathJoin } from 'path'

function roundUp(time: number, interval: number): number {
  return Math.ceil(time / interval) * interval
}

function msSinceMidnight() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return Date.now() - d.getTime()
}

async function nextBackupTime(
  redis: RedisClient,
  backupInterval: number
): Promise<number> {
  const lastBackupTime = Number(
    await new Promise((resolve, reject) => {
      redis.get('___selva_backup_timestamp', (err, reply) => {
        if (err) return reject(err)
        resolve(reply)
      })
    })
  )

  return roundUp(lastBackupTime, backupInterval)
}

export type BackupFns = { sendBackup: SendBackup; loadBackup: LoadBackup }
export type SendBackup = (rdbFilePath: string) => Promise<void>
export type LoadBackup = (
  rdbFilePath: string,
  rdbLastModified?: Date
) => Promise<void>

export async function loadBackup(redisDir: string, backupFns: BackupFns) {
  const dumpFile = pathJoin(redisDir, 'dump.rdb')
  try {
    const stat = await fs.stat(dumpFile)
    await backupFns.loadBackup(dumpFile, stat.mtime)
  } catch (e) {
    await backupFns.loadBackup(dumpFile)
  }
}

// loads the latest backup, but only if it's newer than local dump.rdb
export async function saveAndBackUp(
  redisDir: string,
  redisPort: number,
  backupFns: BackupFns
): Promise<void> {
  const redis = createClient({ port: redisPort })
  try {
    await new Promise((resolve, reject) => {
      redis.save((err, reply) => {
        if (err) {
          return reject(err)
        }

        resolve(reply)
      })
    })

    await backupFns.sendBackup(pathJoin(redisDir, 'dump.rdb'))
  } catch (e) {
    console.error(`Failed to back up ${e.stack}`)
    throw e
  } finally {
    redis.end(false)
  }
}

export async function scheduleBackups(
  redisDir: string,
  redisPort: number,
  intervalInMinutes: number,
  backupFns: BackupFns
) {
  const redis = createClient({ port: redisPort })

  const backupInterval = intervalInMinutes * 60 * 1000
  const nextBackup = await nextBackupTime(redis, backupInterval)

  const timeOfDay = msSinceMidnight()
  if (timeOfDay >= nextBackup) {
    try {
      await backupFns.sendBackup(pathJoin(redisDir, 'dump.rdb'))
      await new Promise((resolve, reject) => {
        redis.set(
          '___selva_backup_timestamp',
          String(timeOfDay),
          (err, reply) => {
            if (err) return reject(err)
            resolve(reply)
          }
        )
      })
    } catch (e) {
      console.error(`Failed to back up ${e}`)
    }
  } else {
    const delay = Math.max(nextBackup - timeOfDay, 0)
    await new Promise((resolve, _reject) => setTimeout(resolve, delay))
    await scheduleBackups(redisDir, redisPort, intervalInMinutes, backupFns)
  }

  redis.end(false)
}
