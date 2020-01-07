import test from 'ava'
import { start } from '../src/index'
import redis from 'redis'

test.cb('create a server', t => {
  start({ port: 6061, modules: ['redisearch'] }).then(() => {
    setTimeout(() => {
      const sub = redis.createClient({ port: 6061 })
      const pub = redis.createClient({ port: 6061 })

      sub.subscribe('flap')

      sub.on('message', (channel, message) => {
        t.is(message, 'smurk')
        t.end()
      })

      pub.publish('flap', 'smurk')
    }, 100)
  })
})
