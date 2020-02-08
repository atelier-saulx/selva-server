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
  if (!type) {
    return newOpts
  }

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
  private client: SelvaClient
  private sub: RedisClient
  private pub: RedisClient
  private refreshSubscriptionsTimeout: NodeJS.Timeout

  async attach(port: number) {
    console.log('attaching subscriptions')
    this.client = new SelvaClient({ port })
    await this.refreshSubscriptions()

    this.sub = new RedisClient({ port })
    this.pub = new RedisClient({ port })
    this.sub.on('pmessage', (_pattern, channel, _message) => {
      console.log('got lua event', channel)
      // used to deduplicate events for subscriptions,
      // firing only once if multiple fields in subscription are changed
      const updatedSubscriptions: Record<string, true> = {}

      const eventName = channel.slice('___selva_events:'.length)

      const parts = eventName.split('.')
      let field = parts[0]
      for (let i = 0; i < parts.length; i++) {
        console.log('trying field', field)
        const subscriptionIds: Set<string> | undefined =
          this.subscriptionsByField[field] || new Set()

        for (const subscriptionId of subscriptionIds) {
          if (updatedSubscriptions[subscriptionId]) {
            console.log('subscription', subscriptionId, 'already updated')
            continue
          }

          updatedSubscriptions[subscriptionId] = true

          console.log(
            'found subscription to update',
            subscriptionId,
            this.subscriptions[subscriptionId]
          )
          this.client
            .get(this.subscriptions[subscriptionId])
            .then(payload => {
              console.log(
                `publishing`,
                `___selva_subscription:${subscriptionId}`,
                JSON.stringify(payload)
              )
              this.pub.publish(
                `___selva_subscription:${subscriptionId}`,
                JSON.stringify(payload)
              )
            })
            .catch(e => {
              console.error(e)
            })
        }

        field += '.' + parts[i + 1]
      }
    })

    this.sub.psubscribe('___selva_events:*')

    const timeout = () => {
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

    console.log('stored sub data', stored)
    const fieldMap: Record<string, Set<string>> = {}
    const subs: Record<string, GetOptions> = {}
    for (const subscriptionId in stored) {
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
    console.log('subs', this.subscriptions)
    console.log('by field', this.subscriptionsByField)
  }
}