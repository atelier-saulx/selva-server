const fs = require('fs').promises
const path = require('path')
const start = require('../../lib').start
const redis = require('redis')

const ENDPOINT = process.env.ENDPOINT
const BUCKET = process.env.BUCKET
const ACCESS_KEY_ID = process.env.ACCESS_KEY_ID
const SECRET_ACCESS_KEY = process.env.SECRET_ACCESS_KEY

const mkS3 = require('../../lib/backup-plugins/s3').default

const backups = require('../../lib/backups')

mkS3({
  endpoint: ENDPOINT,
  backupRetentionInDays: 30,
  bucketName: BUCKET, // TODO: pass database name etc. to automate
  config: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY
  }
}).then(async backupFns => {
  const server = start({
    port: 6061,
    modules: ['redisearch'],
    developmentLogging: true
    // TODO: accept backupFn as a promise, awaited in server.start()
  })

  setTimeout(() => {
    backups
      .saveAndBackUp(process.cwd(), 6061, backupFns)
      .then(() => {
        console.log(`Backed up successfully`)
      })
      .then(() => {
        return fs.unlink(path.join(process.cwd(), 'dump.rdb'))
      })
      .then(() => {
        return backups.loadBackup(process.cwd(), backupFns)
      })
      .catch(e => {
        console.error(`Failed to back up ${e}`)
      })
      .finally(() => {
        setTimeout(() => {
          server.destroy().catch(e => {
            console.error(e)
          })
        }, 1000)
      })
  }, 500)
})
