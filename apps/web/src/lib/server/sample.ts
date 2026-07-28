import 'server-only';

/**
 * A small but complete sample service, bundled as source text.
 *
 * It exists so that a brand-new workspace has real data in every module without
 * the user connecting anything: it has a module graph with a genuine cycle, a
 * layered structure, an Express API surface, a SQL schema with foreign keys,
 * a manifest pinning a known-vulnerable dependency, undocumented environment
 * variables, and a handful of deliberate code smells. Every number ForgeOS
 * shows for it is computed from this text, not hard-coded.
 */
export const SAMPLE_REPOSITORY: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify(
    {
      name: 'orders-service',
      version: '2.4.1',
      description: 'Order capture and fulfilment API for the storefront.',
      license: 'MIT',
      main: 'src/server.js',
      scripts: {
        dev: 'node --watch src/server.js',
        build: 'tsc -p tsconfig.json',
        test: 'vitest run',
        lint: 'eslint .',
        start: 'node dist/server.js',
      },
      dependencies: {
        express: '4.18.2',
        pg: '^8.11.3',
        lodash: '4.17.20',
        jsonwebtoken: '8.5.1',
        zod: '^3.23.8',
      },
      devDependencies: {
        vitest: '^1.6.0',
        typescript: '^5.4.5',
        eslint: '^8.57.0',
      },
    },
    null,
    2
  ),

  'tsconfig.json': JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        baseUrl: '.',
        paths: { '@/*': ['./src/*'] },
      },
      include: ['src/**/*.ts'],
    },
    null,
    2
  ),

  'README.md': `# orders-service

Order capture and fulfilment API for the storefront.

Handles cart checkout, payment authorisation hand-off, and fulfilment events.
`,

  '.env.example': `DATABASE_URL=
PORT=3000
JWT_SECRET=
STRIPE_WEBHOOK_SECRET=
`,

  'src/server.ts': `import express from 'express';
import { registerOrderRoutes } from './api/orders';
import { registerHealthRoutes } from './api/health';
import { connect } from './db/pool';
import { logger } from './lib/logger';

const app = express();
app.use(express.json());

registerHealthRoutes(app);
registerOrderRoutes(app);

const port = Number(process.env.PORT ?? 3000);

connect().then(() => {
  app.listen(port, () => {
    logger.info(\`orders-service listening on \${port}\`);
  });
});

export { app };
`,

  'src/api/orders.ts': `import type { Express } from 'express';
import { OrderService } from '../services/order-service';
import { validateCreateOrder } from '../domain/validation';
import { logger } from '../lib/logger';

const service = new OrderService();

export function registerOrderRoutes(app: Express): void {
  app.get('/orders', async (req, res) => {
    const orders = await service.list(String(req.query.customerId ?? ''));
    res.json({ orders });
  });

  app.get('/orders/:id', async (req, res) => {
    const order = await service.get(req.params.id);
    if (!order) return res.status(404).json({ error: 'not_found' });
    res.json(order);
  });

  app.post('/orders', async (req, res) => {
    const problems = validateCreateOrder(req.body);
    if (problems.length > 0) {
      return res.status(400).json({ error: 'invalid_request', problems });
    }
    const order = await service.create(req.body);
    res.status(201).json(order);
  });

  app.post('/orders/:id/cancel', async (req, res) => {
    try {
      const order = await service.cancel(req.params.id, String(req.body?.reason ?? ''));
      res.json(order);
    } catch (error) {
      logger.error('cancel failed', { orderId: req.params.id });
      res.status(409).json({ error: 'cannot_cancel' });
    }
  });

  app.delete('/orders/:id', async (req, res) => {
    await service.remove(req.params.id);
    res.status(204).end();
  });
}
`,

  'src/api/health.ts': `import type { Express } from 'express';
import { pool } from '../db/pool';

export function registerHealthRoutes(app: Express): void {
  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'degraded' });
    }
  });
}
`,

  'src/services/order-service.ts': `import { pool } from '../db/pool';
import { OrderRepository } from '../repositories/order-repository';
import { calculateTotal, applyDiscounts } from '../domain/pricing';
import type { Order, OrderDraft } from '../domain/types';
import { logger } from '../lib/logger';
import { notifyFulfilment } from './fulfilment';

/**
 * Order orchestration.
 *
 * NOTE: this class has grown well past its original responsibility — it now
 * handles pricing, persistence, notification and cancellation policy.
 */
export class OrderService {
  private readonly repository = new OrderRepository(pool);

  async list(customerId: string): Promise<Order[]> {
    if (!customerId) return this.repository.recent(50);
    return this.repository.findByCustomer(customerId);
  }

  async get(id: string): Promise<Order | null> {
    return this.repository.findById(id);
  }

  async create(draft: OrderDraft): Promise<Order> {
    const subtotal = calculateTotal(draft.items);
    const discounted = applyDiscounts(subtotal, draft.coupons ?? []);

    let tax = 0;
    if (draft.region === 'EU') {
      tax = discounted * 0.2;
    } else if (draft.region === 'US') {
      if (draft.state === 'CA') {
        tax = discounted * 0.0725;
      } else if (draft.state === 'NY') {
        tax = discounted * 0.04;
      } else if (draft.state === 'TX') {
        tax = discounted * 0.0625;
      } else {
        tax = discounted * 0.05;
      }
    } else if (draft.region === 'UK') {
      tax = discounted * 0.2;
    } else if (draft.region === 'CA') {
      tax = discounted * 0.13;
    } else {
      tax = 0;
    }

    const order = await this.repository.insert({
      ...draft,
      subtotal,
      discount: subtotal - discounted,
      tax,
      total: discounted + tax,
      status: 'pending',
    });

    await notifyFulfilment(order);
    logger.info('order created', { orderId: order.id, total: order.total });
    return order;
  }

  async cancel(id: string, reason: string): Promise<Order> {
    const order = await this.repository.findById(id);
    if (!order) throw new Error('not_found');
    if (order.status === 'shipped' || order.status === 'delivered') {
      throw new Error('cannot_cancel');
    }
    // TODO: refund the payment authorisation before marking as cancelled
    return this.repository.updateStatus(id, 'cancelled', reason);
  }

  async remove(id: string): Promise<void> {
    await this.repository.remove(id);
  }
}
`,

  'src/services/fulfilment.ts': `import type { Order } from '../domain/types';
import { logger } from '../lib/logger';
import { OrderService } from './order-service';

/**
 * Publishes an order to the fulfilment queue.
 *
 * FIXME: importing OrderService here creates a cycle with order-service.ts.
 * The re-price path should move into the domain layer instead.
 */
export async function notifyFulfilment(order: Order): Promise<void> {
  logger.info('queueing fulfilment', { orderId: order.id });

  if (order.total <= 0) {
    const service = new OrderService();
    await service.get(order.id);
  }
}
`,

  'src/repositories/order-repository.ts': `import type { Pool } from 'pg';
import type { Order, OrderDraft } from '../domain/types';

export class OrderRepository {
  constructor(private readonly pool: Pool) {}

  async findById(id: string): Promise<Order | null> {
    const result = await this.pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  async findByCustomer(customerId: string): Promise<Order[]> {
    const result = await this.pool.query(
      'SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC',
      [customerId]
    );
    return result.rows;
  }

  async recent(limit: number): Promise<Order[]> {
    const result = await this.pool.query(
      'SELECT * FROM orders ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    return result.rows;
  }

  async insert(order: OrderDraft & { total: number }): Promise<Order> {
    const result = await this.pool.query(
      'INSERT INTO orders (customer_id, total, status) VALUES ($1, $2, $3) RETURNING *',
      [order.customerId, order.total, 'pending']
    );
    return result.rows[0];
  }

  async updateStatus(id: string, status: string, reason: string): Promise<Order> {
    const result = await this.pool.query(
      'UPDATE orders SET status = $2, cancel_reason = $3 WHERE id = $1 RETURNING *',
      [id, status, reason]
    );
    return result.rows[0];
  }

  async remove(id: string): Promise<void> {
    await this.pool.query('DELETE FROM orders WHERE id = $1', [id]);
  }
}
`,

  'src/domain/types.ts': `export interface OrderItem {
  sku: string;
  quantity: number;
  unitPrice: number;
}

export interface OrderDraft {
  customerId: string;
  items: OrderItem[];
  region: 'EU' | 'US' | 'UK' | 'CA' | 'OTHER';
  state?: string;
  coupons?: string[];
}

export interface Order extends OrderDraft {
  id: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  status: 'pending' | 'paid' | 'shipped' | 'delivered' | 'cancelled';
  createdAt: string;
}
`,

  'src/domain/pricing.ts': `import type { OrderItem } from './types';

export function calculateTotal(items: OrderItem[]): number {
  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
}

const COUPONS: Record<string, number> = {
  WELCOME10: 0.1,
  SPRING15: 0.15,
  VIP25: 0.25,
};

export function applyDiscounts(subtotal: number, coupons: string[]): number {
  let total = subtotal;
  for (const coupon of coupons) {
    const rate = COUPONS[coupon.toUpperCase()];
    if (rate) total -= subtotal * rate;
  }
  return Math.max(0, Math.round(total * 100) / 100);
}
`,

  'src/domain/validation.ts': `import type { OrderDraft } from './types';

export function validateCreateOrder(body: unknown): string[] {
  const problems: string[] = [];
  if (typeof body !== 'object' || body === null) return ['body must be an object'];

  const draft = body as Partial<OrderDraft>;
  if (!draft.customerId) problems.push('customerId is required');
  if (!Array.isArray(draft.items) || draft.items.length === 0) {
    problems.push('items must contain at least one entry');
  } else {
    draft.items.forEach((item, index) => {
      if (!item.sku) problems.push(\`items[\${index}].sku is required\`);
      if (!(item.quantity > 0)) problems.push(\`items[\${index}].quantity must be positive\`);
      if (!(item.unitPrice >= 0)) problems.push(\`items[\${index}].unitPrice must be >= 0\`);
    });
  }
  if (!draft.region) problems.push('region is required');
  return problems;
}
`,

  'src/db/pool.ts': `import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

export async function connect(): Promise<void> {
  await pool.query('SELECT 1');
}
`,

  'src/lib/logger.ts': `type Fields = Record<string, unknown>;

function emit(level: string, message: string, fields?: Fields): void {
  process.stdout.write(
    JSON.stringify({ level, message, time: new Date().toISOString(), ...fields }) + '\\n'
  );
}

export const logger = {
  info: (message: string, fields?: Fields) => emit('info', message, fields),
  warn: (message: string, fields?: Fields) => emit('warn', message, fields),
  error: (message: string, fields?: Fields) => emit('error', message, fields),
};
`,

  'src/lib/auth.ts': `import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET ?? 'development-only-secret';

export function sign(payload: Record<string, unknown>): string {
  return jwt.sign(payload, SECRET, { expiresIn: '1h' });
}

export function verify(token: string): Record<string, unknown> | null {
  try {
    return jwt.verify(token, SECRET) as Record<string, unknown>;
  } catch {
    return null;
  }
}
`,

  'migrations/001_init.sql': `CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers,
  subtotal NUMERIC(12, 2) NOT NULL,
  discount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  tax NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total NUMERIC(12, 2) NOT NULL,
  status TEXT NOT NULL,
  cancel_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price NUMERIC(12, 2) NOT NULL
);

CREATE TABLE fulfilments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders,
  carrier TEXT NOT NULL,
  tracking_code TEXT,
  shipped_at TIMESTAMPTZ
);
`,

  'src/services/order-service.test.ts': `import { describe, it, expect } from 'vitest';
import { calculateTotal, applyDiscounts } from '../domain/pricing';

describe('pricing', () => {
  it('sums line items', () => {
    expect(calculateTotal([{ sku: 'a', quantity: 2, unitPrice: 10 }])).toBe(20);
  });

  it('applies a known coupon', () => {
    expect(applyDiscounts(100, ['WELCOME10'])).toBe(90);
  });
});
`,
};
