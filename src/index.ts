const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
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
  verbose: boolean
}

exports.start = async function({
  port,
  service,
  modules,
  replica,
  verbose = true
}: FnStart) {
  console.info('Start db 🌈')
  if (service instanceof Promise) {
    if (verbose) {
      console.info('awaiting service')
    }
    service = await service

    if (verbose) {
      console.info('service', service)
    }
  }

  if (port instanceof Promise) {
    if (verbose) {
      console.info('awaiting port')
    }
    port = await port
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

  const args = ['--port', port, '--protected-mode', 'no']
  if (modules) {
    modules.forEach(m => {
      const platform = process.platform + '_' + process.arch
      const p = path.join(__dirname, '../', 'modules', platform, m + '.so')
      if (fs.existsSync(p)) {
        console.info(`Load redis module "${m}"`)
        args.push('--loadmodule', p)
      } else {
        console.warn(`${m} module does not exists for "${platform}"`)
      }
    })
  }

  if (replica) {
    args.push('--replicaof', replica.host, replica.port)
  }

  const tmpPath = path.join(process.cwd(), './tmp')
  if (!fs.existsSync(tmpPath)) {
    fs.mkdirSync(tmpPath)
  }

  try {
    const dir = args[args.indexOf('--dir') + 1]
    execSync(`redis-cli -p ${port} config set dir ${dir}`, { stdio: 'inherit' })
    execSync(`redis-cli -p ${port} shutdown`, { stdio: 'inherit' })
  } catch (e) {}

  console.error(args)

  const redisDb = spawn('redis-server', args)

  redisDb.stderr.on('data', data => {
    // log(new Error(data.toString()), { channels: ['slack'] })
  })

  redisDb.stdout.on('data', data => {
    if (verbose) {
      // log(data.toString())
    }
  })

  redisDb.on('close', code => {
    // may need to force a restart and tell the registry this happened
    // log(new Error(`Redis closed with ${code}`), { channels: ['slack'] })
  })

  // cleanExit(port)

  return redisDb
}
