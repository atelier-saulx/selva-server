import retry from 'async-retry'
import { spawn, execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { RedisClient, createClient } from 'redis'
import {
  BackupFns,
  scheduleBackups,
  saveAndBackUp,
  loadBackup
} from './backups'

// const persist = require('./persistent')
// const cleanExit = require('./cleanExit')

type Service = {
  port: number
  host: string
}

type FnStart = {
  port?: number | Promise<number>
  service?: Service | Promise<Service>
  replica?: Service | Promise<Service>
  modules?: string[]
  verbose?: boolean
  loglevel?: string
  developmentLogging?: boolean
  backups?: {
    loadBackup?: boolean
    scheduled?: { intervalInMinutes: number }
    backupFns: BackupFns | Promise<BackupFns>
  }
}

type SelvaServer = {
  on: (
    type: 'log' | 'data' | 'close' | 'error',
    cb: (data: any) => void
  ) => void
  destroy: () => Promise<void>
  backup: () => Promise<void>
}

const defaultModules = ['redisearch', 'selva']

const wait = (): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, 100)
  })

export const start = async function({
  port: portOpt,
  service,
  modules,
  replica,
  verbose = false,
  loglevel = 'warning',
  developmentLogging = false,
  backups = null
}: FnStart): Promise<SelvaServer> {
  let port: number
  let backupFns: BackupFns
  if (verbose) console.info('Start db 🌈')
  if (service instanceof Promise) {
    if (verbose) {
      console.info('awaiting service')
    }
    service = await service

    if (verbose) {
      console.info('service', service)
    }
  }

  if (portOpt instanceof Promise) {
    if (verbose) {
      console.info('awaiting port')
    }
    port = await portOpt
  } else {
    port = portOpt
  }

  if (replica instanceof Promise) {
    if (verbose) {
      console.info('awaiting db to replicate')
    }
    replica = await replica
    if (verbose) {
      console.info('replica', replica)
    }
  }

  if (!port && service) {
    port = service.port
    if (verbose) {
      console.info('listen on port', port)
    }
  }

  if (backups) {
    if (backups.backupFns instanceof Promise) {
      backupFns = await backups.backupFns
    } else {
      backupFns = backups.backupFns
    }

    if (backups.loadBackup) {
      await loadBackup(process.cwd(), backupFns)
    }

    if (backups.scheduled) {
      const backUp = async (_bail: (e: Error) => void) => {
        await scheduleBackups(
          process.cwd(),
          port,
          backups.scheduled.intervalInMinutes,
          backupFns
        )
      }

      retry(backUp, { forever: true }).catch(e => {
        console.error(`Backups failed ${e.stack}`)
        execSync(`redis-cli -p ${port} shutdown`)
        redisDb.kill()
        process.exit(1)
      })
    }
  }

  const args = ['--port', String(port), '--protected-mode', 'no']

  if (modules) {
    modules = [...new Set([...defaultModules, ...modules])]
  } else {
    modules = defaultModules
  }

  modules.forEach(m => {
    const platform = process.platform + '_' + process.arch
    const p = path.join(
      __dirname,
      '../',
      'modules',
      'binaries',
      platform,
      m + '.so'
    )
    if (fs.existsSync(p)) {
      if (verbose) {
        console.info(`  Load redis module "${m}"`)
      }
      args.push('--loadmodule', p)
    } else {
      console.warn(`${m} module does not exists for "${platform}"`)
    }
  })

  if (replica) {
    args.push('--replicaof', replica.host, String(replica.port))
  }

  const tmpPath = path.join(process.cwd(), './tmp')
  if (!fs.existsSync(tmpPath)) {
    fs.mkdirSync(tmpPath)
  }

  try {
    const dir = args[args.indexOf('--dir') + 1]
    execSync(`redis-cli -p ${port} config set dir ${dir}`)
    execSync(`redis-cli -p ${port} shutdown`)
  } catch (e) {}

  const redisDb = spawn('redis-server', args)

  if (developmentLogging) {
    setTimeout(() => {
      execSync(`redis-cli -p ${port} set ___selva_lua_loglevel ${loglevel}`)

      const setupLogging = () => {
        let sub: RedisClient = createClient(<number>port)
        sub.on('message', (_channel, log) => {
          console.log('LUA:', log)
        })
        sub.subscribe('___selva_lua_logs')

        setInterval(() => {
          // refresh the development logging
          // redis subscriptions tend to die over time
          sub.end(false)
          setupLogging()
        }, 1000 * 60 * 5)
      }

      setupLogging()
    }, 100)
  }

  const redisServer: SelvaServer = {
    on: (type: 'data' | 'close' | 'error', cb: (data: any) => void) => {
      if (type === 'error') {
        redisDb.stderr.on('data', cb)
      } else if (type === 'data') {
        redisDb.stdout.on('data', cb)
      } else {
        redisDb.on('close', cb)
      }
    },
    destroy: async () => {
      execSync(`redis-cli -p ${port} shutdown`)
      redisDb.kill()
      await wait()
    },
    backup: async () => {
      // make a manual backup if available
      if (!backupFns) {
        throw new Error(`No backup options supplied`)
      }

      await saveAndBackUp(process.cwd(), port, backupFns)
    }
  }

  // cleanExit(port)

  return redisServer
}
