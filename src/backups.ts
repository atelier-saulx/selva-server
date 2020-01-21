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

export type SendBackup = (rdbFilePath: string) => Promise<void>

export async function saveAndBackUp(
  redisDir: string,
  redisPort: number,
  backupFn: SendBackup
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

    await backupFn(pathJoin(redisDir, 'dump.rdb'))
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
  backupFn: SendBackup
) {
  const redis = createClient({ port: redisPort })

  const backupInterval = intervalInMinutes * 60 * 1000
  const nextBackup = await nextBackupTime(redis, backupInterval)

  const timeOfDay = msSinceMidnight()
  if (timeOfDay >= nextBackup) {
    try {
      await backupFn(pathJoin(redisDir, 'dump.rdb'))
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
    const delay = nextBackup - timeOfDay
    await new Promise((resolve, _reject) => setTimeout(resolve, delay))
    await scheduleBackups(redisDir, redisPort, intervalInMinutes, backupFn)
  }

  redis.end(false)
}
