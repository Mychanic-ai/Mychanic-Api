import { AsyncLocalStorage } from 'async_hooks'

type LogLevel = 'info' | 'warn' | 'error'

type LogData = Record<string, unknown>

interface RequestContext {
  userId?: string
  shopId?: string
}

const requestContext = new AsyncLocalStorage<RequestContext>()

export function runWithRequestContext<T>(fn: () => T): T {
  return requestContext.run({}, fn)
}

export function getRequestContext(): RequestContext {
  return requestContext.getStore() ?? {}
}

function pushToLoki(level: LogLevel, line: string): void {
  const lokiHost = process.env.LOKI_HOST
  const lokiUsername = process.env.LOKI_USERNAME
  const lokiApiKey = process.env.LOKI_API_KEY

  if (!lokiHost || !lokiUsername || !lokiApiKey) return

  const tsNs = String(BigInt(Date.now()) * BigInt(1_000_000))
  const credentials = Buffer.from(`${lokiUsername}:${lokiApiKey}`).toString('base64')

  const body = JSON.stringify({
    streams: [
      {
        stream: {
          app: 'mychanic',
          env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
          level,
        },
        values: [[tsNs, line]],
      },
    ],
  })

  // Fire-and-forget — don't await so we never block the response
  fetch(`${lokiHost}/loki/api/v1/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${credentials}`,
    },
    body,
  }).catch(() => {
    // Silently ignore Loki push failures so logging never breaks the app
  })
}

function log(level: LogLevel, data: LogData): void {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    ...data,
  })
  // Write to stdout (visible in Vercel function logs and local dev)
  try {
    process.stdout.write(entry + '\n')
  } catch {
    // stdout unavailable — ignore so logging never breaks the app
  }
  // Also push directly to Loki when credentials are configured
  pushToLoki(level, entry)
}

export const logger = {
  info: (data: LogData) => log('info', data),
  warn: (data: LogData) => log('warn', data),
  error: (data: LogData) => log('error', data),
  /** Call this anywhere after auth to attach userId/shopId to the request log */
  setContext: (ctx: RequestContext) => {
    const store = requestContext.getStore()
    if (store) Object.assign(store, ctx)
  },
}
