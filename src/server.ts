import fastify from "fastify"
import websocket from "@fastify/websocket"
import { Queue, Worker, Job } from "bullmq"
import { createClient as createRedisClient } from "redis"
import { Client as PgClient } from "pg"
import { randomUUID } from "crypto"

type OrderStatus =
  | "pending"
  | "routing"
  | "building"
  | "submitted"
  | "confirmed"
  | "failed"

type OrderType = "market"

type DexName = "raydium" | "meteora"

interface OrderPayload {
  tokenIn: string
  tokenOut: string
  amount: number
  type: OrderType
}

interface OrderJobData extends OrderPayload {
  orderId: string
}

interface DexQuote {
  price: number
  fee: number
}

interface SwapResult {
  txHash: string
  executedPrice: number
}

const app = fastify()
const orderSockets = new Map<string, Set<any>>()

const redisClient = createRedisClient({
  url: process.env.REDIS_URL || "redis://localhost:6379"
})

const orderQueue = new Queue<OrderJobData>("orders", {
  connection: {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT || "6379")
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 500
    },
    removeOnComplete: true,
    removeOnFail: false
  }
})

const pgClient = new PgClient({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/orders_db"
})

class MockDexRouter {
  private basePrice(tokenIn: string, tokenOut: string): number {
    const key = `${tokenIn}-${tokenOut}`
    let hash = 0
    for (let i = 0; i < key.length; i++) {
      hash = (hash * 31 + key.charCodeAt(i)) >>> 0
    }
    return 1 + (hash % 500) / 100
  }

  private normalizeToken(symbol: string): string {
    if (symbol.toUpperCase() === "SOL") return "WSOL"
    return symbol.toUpperCase()
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  async getRaydiumQuote(tokenIn: string, tokenOut: string, amount: number): Promise<DexQuote> {
    const tIn = this.normalizeToken(tokenIn)
    const tOut = this.normalizeToken(tokenOut)
    const base = this.basePrice(tIn, tOut)
    await this.sleep(200 + Math.random() * 150)
    return {
      price: base * (0.98 + Math.random() * 0.04),
      fee: 0.003
    }
  }

  async getMeteorQuote(tokenIn: string, tokenOut: string, amount: number): Promise<DexQuote> {
    const tIn = this.normalizeToken(tokenIn)
    const tOut = this.normalizeToken(tokenOut)
    const base = this.basePrice(tIn, tOut)
    await this.sleep(200 + Math.random() * 150)
    return {
      price: base * (0.97 + Math.random() * 0.05),
      fee: 0.002
    }
  }

  private generateMockTxHash(): string {
    return "0x" + randomUUID().replace(/-/g, "")
  }

  async executeSwap(dex: DexName, order: OrderJobData, quotedPrice: number): Promise<SwapResult> {
    await this.sleep(2000 + Math.random() * 1000)
    const slippageFactor = 0.995 + Math.random() * 0.01
    const executedPrice = quotedPrice * slippageFactor
    return {
      txHash: this.generateMockTxHash(),
      executedPrice
    }
  }
}

const dexRouter = new MockDexRouter()

async function emitStatus(
  orderId: string,
  status: OrderStatus,
  extra?: {
    dex?: DexName
    txHash?: string
    error?: string
    executedPrice?: number
  }
) {
  const payload: any = {
    orderId,
    status,
    dex: extra?.dex,
    txHash: extra?.txHash,
    error: extra?.error,
    executedPrice: extra?.executedPrice,
    timestamp: new Date().toISOString()
  }

  await pgClient.query(
    `
    UPDATE orders
    SET status = $2,
        dex = COALESCE($3, dex),
        tx_hash = COALESCE($4, tx_hash),
        error = COALESCE($5, error),
        executed_price = COALESCE($6, executed_price),
        updated_at = NOW()
    WHERE id = $1
  `,
    [
      orderId,
      status,
      extra?.dex || null,
      extra?.txHash || null,
      extra?.error || null,
      extra?.executedPrice || null
    ]
  )

  const sockets = orderSockets.get(orderId)
  if (sockets) {
    for (const socket of sockets) {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(payload))
      }
    }
  }

  if (status === "confirmed" || status === "failed") {
    await redisClient.sRem("active_orders", orderId)
  }
}

async function setupDb() {
  await pgClient.connect()
  await pgClient.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY,
      type TEXT NOT NULL,
      token_in TEXT NOT NULL,
      token_out TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      status TEXT NOT NULL,
      dex TEXT,
      tx_hash TEXT,
      error TEXT,
      executed_price NUMERIC,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
}

async function setupRedis() {
  if (!redisClient.isOpen) {
    await redisClient.connect()
  }
}

const worker = new Worker<OrderJobData>(
  "orders",
  async (job: Job<OrderJobData>) => {
    const { orderId, tokenIn, tokenOut, amount, type } = job.data
    await emitStatus(orderId, "routing")
    const [raydiumQuote, meteoraQuote] = await Promise.all([
      dexRouter.getRaydiumQuote(tokenIn, tokenOut, amount),
      dexRouter.getMeteorQuote(tokenIn, tokenOut, amount)
    ])

    const raydiumEffective = raydiumQuote.price * (1 - raydiumQuote.fee)
    const meteoraEffective = meteoraQuote.price * (1 - meteoraQuote.fee)

    const bestDex: DexName =
      meteoraEffective > raydiumEffective ? "meteora" : "raydium"
    const bestQuote = bestDex === "meteora" ? meteoraQuote : raydiumQuote

    console.log(
      `Order ${orderId} routing decision: raydium=${raydiumEffective.toFixed(
        6
      )}, meteora=${meteoraEffective.toFixed(6)}, chosen=${bestDex}`
    )

    await emitStatus(orderId, "building", { dex: bestDex })

    if (type !== "market") {
      throw new Error("Unsupported order type")
    }

    const allowedSlippage = 0.01

    await emitStatus(orderId, "submitted", { dex: bestDex })

    const swapResult = await dexRouter.executeSwap(
      bestDex,
      job.data,
      bestQuote.price
    )

    const diff = Math.abs(swapResult.executedPrice - bestQuote.price)
    const relativeDiff = diff / bestQuote.price

    if (relativeDiff > allowedSlippage) {
      throw new Error(
        `Slippage too high: ${relativeDiff.toFixed(4)} > ${allowedSlippage}`
      )
    }

    await emitStatus(orderId, "confirmed", {
      dex: bestDex,
      txHash: swapResult.txHash,
      executedPrice: swapResult.executedPrice
    })

    return {
      dex: bestDex,
      txHash: swapResult.txHash,
      executedPrice: swapResult.executedPrice
    }
  },
  {
    connection: {
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: Number(process.env.REDIS_PORT || "6379")
    },
    concurrency: 10
  }
)

worker.on("failed", async (job, err) => {
  if (!job) return
  const orderId = job.data.orderId
  console.error(`Order ${orderId} failed:`, err.message)
  await emitStatus(orderId, "failed", {
    error: err.message || "unknown_error"
  })
})

async function bootstrap() {
  await setupRedis()
  await setupDb()
  await app.register(websocket)

  app.post("/api/orders/execute", async (request, reply) => {
    const body = request.body as any
    const tokenIn = String(body.tokenIn || "")
    const tokenOut = String(body.tokenOut || "")
    const amount = Number(body.amount)
    if (!tokenIn || !tokenOut || !Number.isFinite(amount) || amount <= 0) {
      reply.code(400)
      return { error: "invalid_order" }
    }

    const orderId = randomUUID()
    const order: OrderPayload = {
      tokenIn,
      tokenOut,
      amount,
      type: "market"
    }

    await pgClient.query(
      `
      INSERT INTO orders (id, type, token_in, token_out, amount, status)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
      [orderId, order.type, order.tokenIn, order.tokenOut, order.amount, "pending"]
    )

    await redisClient.sAdd("active_orders", orderId)

    await orderQueue.add("execute", { orderId, ...order })

    await emitStatus(orderId, "pending")

    reply.code(200)
    return { orderId }
  })

  app.get(
    "/api/orders/execute/ws",
    { websocket: true },
    (connection, request) => {
      const { socket } = connection
      const query = request.query as any
      const orderId = String(query.orderId || "")
      if (!orderId) {
        socket.close()
        return
      }
      let set = orderSockets.get(orderId)
      if (!set) {
        set = new Set()
        orderSockets.set(orderId, set)
      }
      set.add(socket)
      socket.on("close", () => {
        const current = orderSockets.get(orderId)
        if (!current) return
        current.delete(socket)
        if (current.size === 0) {
          orderSockets.delete(orderId)
        }
      })
    }
  )

  app.get("/health", async () => {
    return { status: "ok" }
  })

  const port = Number(process.env.PORT || "3000")
  await app.listen({ port, host: "0.0.0.0" })
  console.log(`Server listening on port ${port}`)
}

bootstrap().catch(err => {
  console.error(err)
  process.exit(1)
})
