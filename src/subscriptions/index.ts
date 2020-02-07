import { RedisClient } from 'redis'
import { SelvaClient } from 'selva-client'
import { GetOptions } from 'selva-client/src/get/types'
import { Schema, FieldSchemaObject } from 'selva-client/src/schema'

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

  let prop = type.fields[parts[0]]
  for (let i = 1; i < parts.length; i++) {
    if (!isObjectLike(prop)) {
      return newOpts
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
  for (const key in opts) {
    if (key[0] === '$') {
      if (key === '$all') {
        addFields(path, fields, schema, makeAll(path, schema, opts))
        return
      } else if (key === '$inherit') {
        fields.add(path.split('.')[0] + '.ancestors')
        return
      } else if (key === '$field') {
        fields.add(path)
        return
      }

      continue
    }

    if (opts[key] === true) {
      fields.add(`${path}.${key}`)
    } else if (typeof opts[key] === 'object') {
      addFields(`${path}.${key}`, fields, schema, opts[key])
    }
  }
}

export default class SubscriptionManager {
  private subscriptionsByField: Record<string, Set<string>> = {}
  private subscriptions: Record<string, GetOptions> = {}
  private client: SelvaClient
  private pubsub: RedisClient

  attach(port: number) {
    this.client = new SelvaClient({ port })

    this.pubsub = new RedisClient({ port })
    this.pubsub.on('pmessage', (_pattern, channel, _message) => {
      const eventName = channel.slice('___selva_events:'.length)

      const parts = eventName.split('.')
      let field = parts[0]
      for (let i = 0; i < parts.length; i++) {
        const subscriptionIds: Set<string> | undefined = this
          .subscriptionsByField[field]

        if (subscriptionIds) {
          for (const subscriptionId of subscriptionIds) {
            this.client
              .get(this.subscriptions[subscriptionId])
              .then(payload => {
                this.pubsub.publish(subscriptionId, JSON.stringify(payload))
              })
              .catch(e => {
                console.error(e)
              })
          }
        }

        field += '.' + parts[i + i]
      }
    })

    this.pubsub.psubscribe('___selva_events:*')
  }

  detach() {
    this.pubsub.end(true)
    this.pubsub = undefined
  }

  get closed(): boolean {
    return this.pubsub === undefined
  }

  async refreshSubscriptions() {
    const schema = (await this.client.getSchema()).schema
    const stored = await this.client.redis.hgetall('___selva_susbriptions')

    console.log('subs', stored)
    const fieldMap: Record<string, Set<string>> = {}
    const subs: Record<string, GetOptions> = {}
    for (const subscriptionId in stored) {
      const fields: Set<string> = new Set()
      const getOptions: GetOptions = JSON.parse(stored[subscriptionId])
      subs[subscriptionId] = getOptions

      addFields('', fields, schema, getOptions)
      for (const field of fields) {
        let current = fieldMap[field]
        if (!current) {
          fieldMap[field] = current = new Set()
        }

        current.add(subscriptionId)
      }
    }

    this.subscriptionsByField = fieldMap
    this.subscriptions = subs
  }
}
