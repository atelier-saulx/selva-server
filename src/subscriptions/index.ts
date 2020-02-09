import { RedisClient } from 'redis'
import { SelvaClient } from 'selva-client'
import { GetOptions } from 'selva-client/src/get/types'
import { Schema, FieldSchemaObject, FieldSchema } from 'selva-client/src/schema'

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
        fields.add(path.split('.')[0] + '.ancestors')
        return
      } else if (key === '$field') {
        if (Array.isArray(opts.$field)) {
          opts.$field.forEach(f => fields.add(f))
        } else {
          fields.add(opts.$field)
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
  private subscriptionsByField: Record<string, Set<string>> = {}
  private subscriptions: Record<string, GetOptions> = {}
  private lastHeartbeat: Record<string, number> = {}
  private client: SelvaClient
  private sub: RedisClient
  private pub: RedisClient
  private refreshSubscriptionsTimeout: NodeJS.Timeout

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
      const subId = message.slice('___selva_subscription:'.length)
      this.lastHeartbeat[subId] = Date.now()
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

              this.pub.publish(
                `___selva_subscription:${subscriptionId}`,
                JSON.stringify({ type: 'delete' })
              )
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

            this.client
              .get(this.subscriptions[subscriptionId])
              .then(payload => {
                this.pub.publish(
                  `___selva_subscription:${subscriptionId}`,
                  JSON.stringify({ type: 'update', payload })
                )
              })
              .catch(e => {
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
  }

  get closed(): boolean {
    return this.sub === undefined
  }

  private async refreshSubscriptions() {
    const schema = (await this.client.getSchema()).schema
    const stored = await this.client.redis.hgetall('___selva_subscriptions')

    const fieldMap: Record<string, Set<string>> = {}
    const subs: Record<string, GetOptions> = {}
    for (const subscriptionId in stored) {
      if (this.lastHeartbeat[subscriptionId]) {
        // if no heartbeats in two minutes, clean up
        if (Date.now() - this.lastHeartbeat[subscriptionId] > 1000 * 120) {
          await this.client.redis.hdel('___selva_subscriptions', subscriptionId)
          continue
        }
      } else {
        // add heartbeat for anything that's newly added
        this.lastHeartbeat[subscriptionId] = Date.now()
      }

      const fields: Set<string> = new Set()
      const getOptions: GetOptions = JSON.parse(stored[subscriptionId])
      subs[subscriptionId] = getOptions

      addFields('', fields, schema, getOptions)
      for (const field of fields) {
        let current = fieldMap[getOptions.$id + field]
        if (!current) {
          fieldMap[getOptions.$id + field] = current = new Set()
        }

        current.add(subscriptionId)
      }
    }

    this.subscriptionsByField = fieldMap
    this.subscriptions = subs
  }
}
