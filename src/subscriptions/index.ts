import { RedisClient } from 'redis'
import { SelvaClient } from 'selva-client'
import { GetOptions } from 'selva-client/src/get/types'
import { Schema, FieldSchemaObject, FieldSchema } from 'selva-client/src/schema'
import { createHash } from 'crypto'

function isObjectLike(x: any): x is FieldSchemaObject {
  return !!(x && x.properties)
}

function makeAll(path: string, schema: Schema, opts: GetOptions): GetOptions {
  const newOpts: GetOptions = { ...opts }
  delete newOpts.$all

  const parts = path.split('.')
  if (!newOpts.$id) {
    return newOpts
  }

  const typeName = schema.prefixToTypeMapping[newOpts.$id.substr(0, 2)]
  const type = schema.types[typeName]
  if (!type) {
    return newOpts
  }

  let prop: FieldSchema = {
    type: 'object',
    properties: type.fields
  }

  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) {
      break
    }

    if (!isObjectLike(prop)) {
      break
    } else {
      prop = prop.properties[parts[i]]
    }
  }

  if (isObjectLike(prop)) {
    for (const propName in prop.properties) {
      newOpts[propName] = true
    }
  } else if (prop.type === 'text') {
    for (const lang of schema.languages) {
      newOpts[lang] = true
    }
  }

  return newOpts
}

function addFields(
  path: string,
  fields: Set<string>,
  schema: Schema,
  opts: GetOptions
): void {
  let hasKeys = false
  for (const key in opts) {
    if (key[0] === '$') {
      if (key === '$all') {
        addFields(path, fields, schema, makeAll(path, schema, opts))
        return
      } else if (key === '$inherit') {
        fields.add('.ancestors')
        return
      } else if (key === '$field') {
        if (Array.isArray(opts.$field)) {
          opts.$field.forEach(f => fields.add('.' + f))
        } else {
          fields.add('.' + opts.$field)
        }

        return
      }

      // FIXME: other special options missing? -- $ref needs to be handled on lua side
      continue
    }

    hasKeys = true

    if (opts[key] === true) {
      fields.add(`${path}.${key}`)
    } else if (typeof opts[key] === 'object') {
      addFields(`${path}.${key}`, fields, schema, opts[key])
    }
  }

  // default to adding the field if only options are specified
  if (!hasKeys) {
    fields.add(path)
  }
}

export default class SubscriptionManager {
  private refreshSubscriptionsTimeout: NodeJS.Timeout
  private lastRefreshed: Date

  private subscriptions: Record<string, GetOptions> = {}
  private subscriptionsByField: Record<string, Set<string>> = {}
  private lastResultHash: Record<string, string> = {}
  private lastHeartbeat: Record<string, number> = {}

  private client: SelvaClient
  private sub: RedisClient
  private pub: RedisClient

  heartbeats() {
    for (const subscriptionId in this.subscriptions) {
      this.pub.publish(
        `___selva_subscription:${subscriptionId}`,
        JSON.stringify({ type: 'heartbeat' })
      )
    }
  }

  async attach(port: number) {
    this.client = new SelvaClient({ port })
    await this.refreshSubscriptions()

    this.sub = new RedisClient({ port })
    this.pub = new RedisClient({ port })

    // client heartbeat events
    this.sub.on('message', (_channel, message) => {
      const payload: { channel: string; refresh?: boolean } = JSON.parse(
        message
      )

      const subId = payload.channel.slice('___selva_subscription:'.length)
      this.lastHeartbeat[subId] = Date.now()

      if (payload.refresh) {
        this.refreshSubscription(subId).catch(e => {
          console.error(e)
        })
      }
    })

    // lua object change events
    this.sub.on('pmessage', (_pattern, channel, message) => {
      // used to deduplicate events for subscriptions,
      // firing only once if multiple fields in subscription are changed
      const updatedSubscriptions: Record<string, true> = {}

      const eventName = channel.slice('___selva_events:'.length)

      if (message === 'delete') {
        for (const field in this.subscriptionsByField) {
          if (field.startsWith(eventName)) {
            const subscriptionIds: Set<string> | undefined =
              this.subscriptionsByField[field] || new Set()

            for (const subscriptionId of subscriptionIds) {
              if (updatedSubscriptions[subscriptionId]) {
                continue
              }

              updatedSubscriptions[subscriptionId] = true

              this.sendUpdate(subscriptionId, null, true)
            }
          }
        }
        return
      } else if (message === 'update') {
        const parts = eventName.split('.')
        let field = parts[0]
        for (let i = 0; i < parts.length; i++) {
          const subscriptionIds: Set<string> | undefined =
            this.subscriptionsByField[field] || new Set()

          for (const subscriptionId of subscriptionIds) {
            if (updatedSubscriptions[subscriptionId]) {
              continue
            }

            updatedSubscriptions[subscriptionId] = true

            this.sendUpdate(subscriptionId).catch(e => {
              console.error(e)
            })
          }

          field += '.' + parts[i + 1]
        }
      }
    })

    this.sub.psubscribe('___selva_events:*')
    this.sub.subscribe('___selva_subscription:client_heartbeats')

    const timeout = () => {
      this.heartbeats()

      this.refreshSubscriptions()
        .catch(e => {
          console.error(e)
        })
        .finally(() => {
          this.refreshSubscriptionsTimeout = setTimeout(timeout, 1000 * 10)
        })
    }
    timeout()
  }

  detach() {
    this.sub.end(true)
    this.sub = undefined

    this.pub.end(true)
    this.pub = undefined

    if (this.refreshSubscriptionsTimeout) {
      clearTimeout(this.refreshSubscriptionsTimeout)
      this.refreshSubscriptionsTimeout = undefined
    }

    this.subscriptionsByField = {}
    this.subscriptions = {}
    this.lastResultHash = {}
    this.lastHeartbeat = {}
  }

  get closed(): boolean {
    return this.sub === undefined
  }

  private async sendUpdate(
    subscriptionId: string,
    getOptions?: GetOptions,
    deleteOp: boolean = false
  ) {
    if (!this.pub) {
      return
    }

    if (deleteOp) {
      this.pub.publish(
        `___selva_subscription:${subscriptionId}`,
        JSON.stringify({ type: 'delete' })
      )

      // delete cache for latest result since there is no result now
      delete this.lastResultHash[subscriptionId]
      return
    }

    const payload = await this.client.get(
      getOptions || this.subscriptions[subscriptionId]
    )
    // hack-ish thing: include the result object in the string
    // so we don't need to encode/decode as many times
    const resultStr = JSON.stringify({ type: 'update', payload })

    const currentHash = this.lastResultHash[subscriptionId]
    const hashingFn = createHash('sha256')
    hashingFn.update(resultStr)
    const newHash = hashingFn.digest('hex')

    // de-duplicate events
    // with this we can avoid sending events where nothing changed upon reconnection
    // both for queries and for gets by id
    if (currentHash && currentHash === newHash) {
      return
    }

    this.lastResultHash[subscriptionId] = newHash

    this.pub.publish(`___selva_subscription:${subscriptionId}`, resultStr)
  }

  private async refreshSubscription(
    subId: string,
    subs: Record<string, GetOptions> = this.subscriptions,
    fieldMap: Record<string, Set<string>> = this.subscriptionsByField,
    schema?: Schema,
    stored?: string,
    cleanup: boolean = false
  ) {
    if (!schema) {
      schema = (await this.client.getSchema()).schema
    }

    if (!stored) {
      stored = await this.client.redis.hget('___selva_subscriptions', subId)
    }

    console.log('refresh subscription', subId, stored)

    const getOptions: GetOptions = JSON.parse(stored)

    if (cleanup && this.lastHeartbeat[subId]) {
      // if no heartbeats in two minutes, clean up
      if (Date.now() - this.lastHeartbeat[subId] > 1000 * 120) {
        await this.client.redis.hdel('___selva_subscriptions', subId)
        return
      }
    } else {
      // add heartbeat for anything that's newly added
      this.lastHeartbeat[subId] = Date.now()
      // new subscription, send the current data immediately
      this.sendUpdate(subId, getOptions).catch(e => {
        console.error(e)
      })
    }

    const fields: Set<string> = new Set()
    subs[subId] = getOptions

    addFields('', fields, schema, getOptions)
    for (const field of fields) {
      let current = fieldMap[getOptions.$id + field]
      if (!current) {
        fieldMap[getOptions.$id + field] = current = new Set()
      }

      current.add(subId)
    }
  }

  private async refreshSubscriptions() {
    const schema = (await this.client.getSchema()).schema

    const lastEdited = await this.client.redis.hget(
      '___selva_subscriptions',
      '___lastEdited'
    )

    console.log('lastEdited', lastEdited)
    // only refresh if there are new changes to the subscription metadata
    if (lastEdited && this.lastRefreshed) {
      const d = new Date(lastEdited)
      if (d <= this.lastRefreshed) {
        return
      }
    }

    console.log('running periodic refresh')
    const stored = await this.client.redis.hgetall('___selva_subscriptions')
    const fieldMap: Record<string, Set<string>> = {}
    const subs: Record<string, GetOptions> = {}
    for (const subscriptionId in stored) {
      if (subscriptionId.startsWith('___')) {
        // skip internal keys
        continue
      }

      this.refreshSubscription(
        subscriptionId,
        subs,
        fieldMap,
        schema,
        stored[subscriptionId],
        true
      )
    }

    this.lastRefreshed = new Date()

    this.subscriptionsByField = fieldMap
    this.subscriptions = subs
  }
}
