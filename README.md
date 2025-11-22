# Order Execution Engine (Market Order + DEX Routing + WebSockets)

This project implements a mock Solana-based order execution engine that supports **Market Orders** with automatic routing between two simulated DEXs — **Raydium** and **Meteora**.
The system streams real-time execution updates to clients using a **WebSocket**, after the initial order submission over HTTP.

The focus of this implementation is solid architecture: routing logic, queue-based concurrency, retries, and lifecycle updates.

---

## 🔄 Order Flow

```
HTTP POST -> Returns orderId -> Same connection upgrades to WebSocket
```

Order lifecycle:

| Status    | Meaning                            |
| --------- | ---------------------------------- |
| pending   | Order accepted + queued            |
| routing   | Fetching Raydium vs Meteora quotes |
| building  | Building transaction               |
| submitted | Transaction submitted              |
| confirmed | Successful execution               |
| failed    | Error after retries                |

Up to **3 retries** using exponential backoff.

---

## 🎯 Why Market Orders?

I chose **Market Order** first because:

* It is the most common execution type
* It demonstrates complete routing → execution flow
* Avoids price-triggering logic required for limit/sniper

Future extension:

* **Limit Order** → check target price before execution
* **Sniper Order** → trigger execution once liquidity appears on-chain

The current structure supports both with minimal additions.

---

## 🧱 Tech Stack

* Node.js + TypeScript
* Fastify (HTTP + WebSocket)
* BullMQ + Redis (order queue + concurrency)
* PostgreSQL (order history + final state)

Execution and pricing are **mock simulated** — no real blockchain interaction.

---

## 🧩 Architecture Overview

```
Client
  | HTTP POST /api/orders/execute
  | -> orderId returned
  |
  | WebSocket /api/orders/execute/ws?orderId=...
  v
Redis Queue <--- Fastify API
  |
  v
Worker (10 concurrent)
  | Compare quotes: Raydium vs Meteora
  | Execute mock tx (2–3 sec)
  v
PostgreSQL (history + final state saved)
```

Routing decision is logged to console for visibility.

---

## 🚀 Getting Started

### Prerequisites

* Node.js ≥ 18
* Redis
* PostgreSQL

### Install

```sh
git clone <repository-url>
cd order-execution-engine
npm install
```

### Environment Variables

Create `.env`:

```env
PORT=3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/orders_db
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
```

### Run locally

```sh
npm run dev
```

Server starts at:

```
http://localhost:3000
```

---

## 📡 API Reference

### Create Order

```
POST /api/orders/execute
Content-Type: application/json
```

Example body:

```json
{
  "tokenIn": "SOL",
  "tokenOut": "USDC",
  "amount": 1.5
}
```

Response:

```json
{
  "orderId": "5b6f2ac2-c4ea-4abb-bbaa-d0520f488df9"
}
```

### WebSocket status stream

```
GET /api/orders/execute/ws?orderId=<id>
```

Example status message:

```json
{
  "orderId": "5b6f2ac2-c4ea-4abb-bbaa-d0520f488df9",
  "status": "confirmed",
  "dex": "raydium",
  "txHash": "0x4c9e2dfadb984c7b8eec5e77abce4d90",
  "executedPrice": 1.245,
  "timestamp": "2025-11-23T12:01:10Z"
}
```

---

## 🧪 Tests

Unit and integration tests cover:

* Quote routing logic
* Queue retry behavior
* WebSocket lifecycle
* Persistence correctness

Run tests:

```sh
npm test
```

---

## 📝 Postman Collection

Located in:

```
/postman/collection.json
```

Includes:

* Single + parallel execution examples
* Success + failure cases

---

## ⏱ Performance

* Handles **10 orders at a time**
* **100 orders per minute** throughput
* Retries with exponential backoff (≤3)
* Errors and results fully persisted

---

## 📌 Deployment

This can be deployed to:

* Render / Railway / Fly.io / Zeabur
  Using hosted Redis + PostgreSQL
