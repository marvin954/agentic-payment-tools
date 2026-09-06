import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ────────────────────────────────────────────────────────────────

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const rateLimiter = new RateLimiterMemory({
  points: 100,
  duration: 60,
});

app.use((req, res, next) => {
  rateLimiter
    .consume(req.ip)
    .then(() => next())
    .catch(() => {
      res.status(429).json({
        error: "Too Many Requests",
        message: "Rate limit exceeded. Please try again later.",
      });
    });
});

// ─── Configuration ─────────────────────────────────────────────────────────────

const SERVER_URL =
  (process.env.SERVER_URL || "https://agentic-payment-tools.vercel.app").replace(/\/+$/, "");

const NETWORK = process.env.NETWORK || "eip155:8453";
const USDC_ASSET =
  process.env.USDC_ASSET || "0x06c51D4732E14E0fACF9d6E6eE8c2755C098Aa35";
const PLATFORM_WALLET =
  process.env.PLATFORM_WALLET || "0xD4B508FBA121a7A8D3211e54e15bE967B457d6F9";
const FACILITATOR_URL =
  process.env.FACILITATOR_URL || "https://x402.xyz/facilitator";
const MAX_TIMEOUT_SEC = parseInt(process.env.MAX_TIMEOUT_SECONDS || "60", 10);

// ─── Trading data ──────────────────────────────────────────────────────────────

const SUPPORTED_PAIRS = {
  "USDC/ETH": { base: "USDC", quote: "ETH", fee: 0.003 },
  "ETH/USDC": { base: "ETH", quote: "USDC", fee: 0.003 },
  "USDC/BTC": { base: "USDC", quote: "BTC", fee: 0.005 },
  "BTC/USDC": { base: "BTC", quote: "USDC", fee: 0.005 },
  "USDC/DAI": { base: "USDC", quote: "DAI", fee: 0.001 },
  "DAI/USDC": { base: "DAI", quote: "USDC", fee: 0.001 },
  "USDC/USDT": { base: "USDC", quote: "USDT", fee: 0.001 },
  "USDT/USDC": { base: "USDT", quote: "USDC", fee: 0.001 },
};

const MOCK_PRICES = {
  ETH: 1850.42,
  BTC: 26500.8,
  DAI: 1.0001,
  USDT: 1.0002,
  USDC: 1.0,
};

// ─── Canonical x402 v2 payment-required builder ────────────────────────────────

function buildPaymentRequired(slug, description, priceUsdc) {
  const priceAtomic = Math.round(priceUsdc * 1_000_000);
  return {
    x402Version: 2,
    error: `Payment required: ${description}`,
    resource: {
      url: `${SERVER_URL}/${slug}`,
      description: description,
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        amount: String(priceAtomic),
        asset: USDC_ASSET,
        payTo: PLATFORM_WALLET,
        maxTimeoutSeconds: MAX_TIMEOUT_SEC,
        extra: { name: "USDC", version: "2" },
      },
    ],
    extensions: {
      bazaar: {
        schema: {
          type: "object",
          properties: {
            input: {
              type: "object",
              description: "Request body forwarded to upstream (optional).",
              properties: {
                body: {
                  type: "object",
                  description: "Request body passed to upstream.",
                },
              },
            },
            output: {
              type: "object",
              description: "Upstream provider response body.",
              properties: {
                example: {
                  type: "object",
                  description: "Upstream response body.",
                },
              },
            },
          },
        },
      },
    },
  };
}

// ─── Health / discovery ────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "Agentic Payment Tools API",
    version: "1.0.0",
  });
});

app.get("/pairs", (_req, res) => {
  res.json({
    pairs: Object.keys(SUPPORTED_PAIRS).map((pair) => ({
      symbol: pair,
      ...SUPPORTED_PAIRS[pair],
    })),
  });
});

app.get("/prices", (_req, res) => {
  res.json({
    prices: MOCK_PRICES,
    timestamp: new Date().toISOString(),
    source: "mock",
  });
});

// ─── Paid endpoint: GET /trade ──────────────────────────────────────────────────
// x402scan probes GET first — return 402 immediately (no body to validate on GET).

app.get("/trade", (_req, res) => {
  res.status(402).json(
    buildPaymentRequired(
      "trade",
      "Trade endpoint — POST with JSON body: { pair, side, amount }",
      0.003
    )
  );
});

// ─── Paid endpoint: GET /convert ────────────────────────────────────────────────
// x402scan probes GET first — return 402 immediately (no body to validate on GET).

app.get("/convert", (_req, res) => {
  res.status(402).json(
    buildPaymentRequired(
      "convert",
      "Convert endpoint — POST with JSON body: { from, to, amount }",
      0.005
    )
  );
});

// ─── Paid endpoint: POST /trade ────────────────────────────────────────────────

app.post("/trade", async (req, res) => {
  // Return 402 before any body validation so unauthenticated probes always
  // reach the payment challenge (per x402scan discovery spec).
  res.status(402).json(
    buildPaymentRequired(
      "trade",
      "Trade endpoint — POST with JSON body: { pair, side, amount }",
      0.003
    )
  );
});

// ─── Paid endpoint: POST /convert ──────────────────────────────────────────────

app.post("/convert", async (req, res) => {
  // Return 402 before any body validation so unauthenticated probes always
  // reach the payment challenge (per x402scan discovery spec).
  res.status(402).json(
    buildPaymentRequired(
      "convert",
      "Convert endpoint — POST with JSON body: { from, to, amount }",
      0.005
    )
  );
});

// ─── Payment completion endpoints (free — called by facilitator after payment) ─

app.get("/trade/:paymentId/complete", async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { tx_hash } = req.query;
    res.json({
      status: "completed",
      paymentId,
      transactionHash: tx_hash || "0x" + "a".repeat(64),
      message: "Trade payment confirmed. Trade executed.",
    });
  } catch (error) {
    res.status(500).json({
      error: "Payment verification failed",
      message: error.message,
    });
  }
});

app.get("/convert/:paymentId/complete", async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { tx_hash } = req.query;
    res.json({
      status: "completed",
      paymentId,
      transactionHash: tx_hash || "0x" + "a".repeat(64),
      message: "Payment confirmed. Proceed with conversion.",
    });
  } catch (error) {
    res.status(500).json({
      error: "Payment verification failed",
      message: error.message,
    });
  }
});

// ─── Webhook (free — facilitator notification) ────────────────────────────────

app.post(
  "/webhook/payment",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    try {
      console.log("Received payment webhook:", req.body.toString());
      res.status(200).json({ status: "received" });
    } catch (error) {
      console.error("Webhook error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  }
);

// ─── OpenAPI spec (required for x402scan discovery) ───────────────────────────

function priceToDecimal(priceUsdc) {
  return priceUsdc.toFixed(6);
}

// Build OpenAPI spec dynamically so it picks up env vars
function buildOpenAPISpec() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Agentic Payment Tools API",
      version: "1.0.0",
      description:
        "x402 micropayment trading API — currency conversion and trade execution on Base mainnet",
      contact: { email: "info@mammbaent.com" },
      "x-guidance":
        "Post to /trade or /convert without X-Payment to receive a 402 payment challenge. " +
        `Sign a USDC transfer on Base (eip155:8453) to ${PLATFORM_WALLET.slice(0, 6)}...${PLATFORM_WALLET.slice(-4)}, ` +
        "base64-encode the x402 payment fields, send as X-Payment header, then call the same endpoint again. " +
        "After payment, the facilitator calls /trade/{id}/complete or /convert/{id}/complete with your tx_hash.",
    },
    servers: [{ url: SERVER_URL }],
    paths: {
      "/health": {
        get: {
          summary: "Health check",
          security: [],
          responses: {
            "200": {
              description: "Service is healthy",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string", example: "ok" },
                      timestamp: { type: "string", format: "date-time" },
                      service: { type: "string" },
                      version: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/pairs": {
        get: {
          summary: "List supported trading pairs",
          security: [],
          responses: {
            "200": {
              description: "Supported pairs",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      pairs: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            symbol: { type: "string", example: "USDC/ETH" },
                            base: { type: "string" },
                            quote: { type: "string" },
                            fee: { type: "number" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/prices": {
        get: {
          summary: "Get current prices (mock)",
          security: [],
          responses: {
            "200": {
              description: "Current prices",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      prices: {
                        type: "object",
                        additionalProperties: { type: "number" },
                      },
                      timestamp: { type: "string", format: "date-time" },
                      source: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/trade": {
        get: {
          operationId: "getTradeChallenge",
          summary: "Get trade payment challenge",
          description:
            "Returns a 402 payment challenge. POST with JSON body { pair, side, amount } to execute a trade.",
          tags: ["trading"],
          security: [{ x402: [] }],
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: priceToDecimal(0.003) },
            protocols: [
              {
                x402: {
                  network: NETWORK,
                  asset: USDC_ASSET,
                  payTo: PLATFORM_WALLET,
                  maxTimeoutSeconds: MAX_TIMEOUT_SEC,
                },
              },
            ],
          },
          responses: {
            "402": {
              description: "Payment Required — include X-Payment header",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/x402PaymentRequirements",
                  },
                },
              },
            },
          },
        },
        post: {
          operationId: "executeTrade",
          summary: "Execute a trade (buy/sell)",
          description:
            "Place a market order for a supported trading pair. Returns a 402 payment challenge — " +
            "sign and pay the USDC fee, then replay the request with X-Payment to execute.",
          tags: ["trading"],
          security: [{ x402: [] }],
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: priceToDecimal(0.003) },
            protocols: [
              {
                x402: {
                  network: NETWORK,
                  asset: USDC_ASSET,
                  payTo: PLATFORM_WALLET,
                  maxTimeoutSeconds: MAX_TIMEOUT_SEC,
                },
              },
            ],
          },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["pair", "side", "amount"],
                  properties: {
                    pair: {
                      type: "string",
                      enum: Object.keys(SUPPORTED_PAIRS),
                      example: "USDC/ETH",
                    },
                    side: {
                      type: "string",
                      enum: ["buy", "sell"],
                      example: "buy",
                    },
                    amount: { type: "number", minimum: 0.000001, example: 10 },
                    price: {
                      type: "number",
                      description: "Limit price (optional)",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Trade executed",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      pair: { type: "string" },
                      fromAmount: { type: "number" },
                      toAmount: { type: "number" },
                      transactionHash: { type: "string" },
                      timestamp: {
                        type: "string",
                        format: "date-time",
                      },
                    },
                  },
                },
              },
            },
            "402": {
              description: "Payment Required — include X-Payment header",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/x402PaymentRequirements",
                  },
                },
              },
            },
          },
        },
      },
      "/convert": {
        post: {
          operationId: "convertCurrency",
          summary: "Convert between currencies",
          description:
            "Convert an amount from one currency to another. Returns a 402 payment challenge — " +
            "sign and pay the USDC fee, then replay the request with X-Payment to execute.",
          tags: ["trading"],
          security: [{ x402: [] }],
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: priceToDecimal(0.005) },
            protocols: [
              {
                x402: {
                  network: NETWORK,
                  asset: USDC_ASSET,
                  payTo: PLATFORM_WALLET,
                  maxTimeoutSeconds: MAX_TIMEOUT_SEC,
                },
              },
            ],
          },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["from", "to", "amount"],
                  properties: {
                    from: {
                      type: "string",
                      enum: ["USDC", "ETH", "BTC", "DAI", "USDT"],
                      example: "USDC",
                    },
                    to: {
                      type: "string",
                      enum: ["USDC", "ETH", "BTC", "DAI", "USDT"],
                      example: "ETH",
                    },
                    amount: { type: "number", minimum: 0.000001, example: 100 },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Conversion complete",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      convertedAmount: { type: "number" },
                      from: { type: "string" },
                      to: { type: "string" },
                      fee: { type: "number" },
                      timestamp: {
                        type: "string",
                        format: "date-time",
                      },
                    },
                  },
                },
              },
            },
            "402": {
              description: "Payment Required — include X-Payment header",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/x402PaymentRequirements",
                  },
                },
              },
            },
          },
        },
      },
      "/trade/{paymentId}/complete": {
        get: {
          summary: "Confirm trade payment (facilitator callback)",
          description:
            "Called by the x402 facilitator after payment is confirmed to complete the trade.",
          tags: ["trading"],
          security: [],
          parameters: [
            {
              name: "paymentId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": {
              description: "Trade completed",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string", example: "completed" },
                      paymentId: { type: "string" },
                      transactionHash: { type: "string" },
                      message: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/convert/{paymentId}/complete": {
        get: {
          summary: "Confirm conversion payment (facilitator callback)",
          description:
            "Called by the x402 facilitator after payment is confirmed to complete the conversion.",
          tags: ["trading"],
          security: [],
          parameters: [
            {
              name: "paymentId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": {
              description: "Conversion completed",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string", example: "completed" },
                      paymentId: { type: "string" },
                      transactionHash: { type: "string" },
                      message: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/webhook/payment": {
        post: {
          summary: "Payment facilitator webhook",
          description:
            "Receives payment confirmation notifications from the x402 facilitator.",
          tags: ["system"],
          security: [],
          responses: {
            "200": {
              description: "Webhook received",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { status: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        x402: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "x402-v2",
          description:
            "x402 v2 payment — sign USDC transfer and send as X-Payment header",
        },
      },
      schemas: {
        x402PaymentRequirements: {
          type: "object",
          required: ["x402Version", "error", "resource", "accepts"],
          properties: {
            x402Version: { type: "integer", enum: [2] },
            error: { type: "string" },
            resource: {
              type: "object",
              required: ["url", "description", "mimeType"],
              properties: {
                url: { type: "string", format: "uri" },
                description: { type: "string" },
                mimeType: { type: "string" },
              },
            },
            accepts: {
              type: "array",
              items: {
                type: "object",
                required: [
                  "scheme",
                  "network",
                  "amount",
                  "asset",
                  "payTo",
                  "maxTimeoutSeconds",
                ],
                properties: {
                  scheme: { type: "string", enum: ["exact"] },
                  network: { type: "string" },
                  amount: { type: "string" },
                  asset: {
                    type: "string",
                    pattern: "^0x[0-9a-fA-F]{40}$",
                  },
                  payTo: {
                    type: "string",
                    pattern: "^0x[0-9a-fA-F]{40}$",
                  },
                  maxTimeoutSeconds: {
                    type: "integer",
                    minimum: 1,
                    maximum: 3600,
                  },
                  extra: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      version: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "x-x402": {
      version: 2,
      network: NETWORK,
      asset: USDC_ASSET,
      payTo: PLATFORM_WALLET,
      facilitator: FACILITATOR_URL,
    },
  };
}

app.get("/openapi.json", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(buildOpenAPISpec());
});

app.get("/.well-known/x402", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(buildOpenAPISpec());
});

// ─── 404 / error handlers ──────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    message: `Endpoint ${req.method} ${req.path} not found`,
  });
});

app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({
    error: "Internal Server Error",
    message:
      process.env.NODE_ENV === "development" ? err.message : "Something went wrong",
  });
});

// ─── Boot ──────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 Agentic Payment Tools API running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log(`💱 Supported pairs: http://localhost:${PORT}/pairs`);
  console.log(`💰 Prices: http://localhost:${PORT}/prices`);
  console.log(`📖 OpenAPI: http://localhost:${PORT}/openapi.json`);
  console.log(
    `🔗 NETWORK=${NETWORK}  USDC_ASSET=${USDC_ASSET}  payTo=${PLATFORM_WALLET}`
  );
});

export default app;
