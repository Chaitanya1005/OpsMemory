/**
 * Synthetic incident dataset. Logs are deterministic and realistic; nothing here
 * contains a diagnosis — the agents must derive it from the evidence.
 */
export interface IncidentInput {
  title: string;
  service: string;
  severity: "SEV1" | "SEV2" | "SEV3";
  description: string;
  logs: string;
}

export interface Scenario extends IncidentInput {
  id: string;
  summary: string;
  /**
   * What the on-call engineer adds when approving (demo input for the human step).
   * This is the human-validated knowledge that logs alone cannot provide.
   */
  approvalEdit?: { fix: string; notes: string };
}

export const SCENARIOS: Scenario[] = [
  {
    id: "db-pool-1",
    summary: "Scenario A, first occurrence: checkout-api scale-out multiplies per-pod DB pools on shared cluster pg-commerce-1",
    title: "Checkout API errors worsen as it scales out — database connections exhausted",
    service: "checkout-api",
    severity: "SEV2",
    description:
      "Checkout errors spiked during evening traffic. The HPA scaled checkout-api out from 6 to 14 replicas and errors got worse, " +
      "and orders-api (same database cluster) also began failing. Errors stopped after on-call manually scaled checkout-api back to 6 replicas.",
    logs: `
2026-09-14T19:58:02Z INFO hpa checkout-api scaled replicas 6 -> 10 reason=cpu_utilization>70%
2026-09-14T19:59:40Z INFO checkout-api pod=checkout-api-5c8f9-k2x1p pool=checkout-main db=pg-commerce-1 stats active=17 idle=3 max=20 waiting=0
2026-09-14T20:01:15Z WARN checkout-api pod=checkout-api-5c8f9-k2x1p pool=checkout-main db=pg-commerce-1 stats active=20 idle=0 max=20 waiting=14
2026-09-14T20:01:16Z WARN checkout-api pod=checkout-api-5c8f9-r7m4d pool=checkout-main db=pg-commerce-1 stats active=20 idle=0 max=20 waiting=11
2026-09-14T20:02:03Z ERROR checkout-api pod=checkout-api-5c8f9-k2x1p pool: timeout acquiring connection after 30000ms (active=20, idle=0, max=20) req-81a0c2
2026-09-14T20:02:41Z ERROR checkout-api pod=checkout-api-5c8f9-w2q9z db=pg-commerce-1 connect failed: FATAL: sorry, too many clients already
2026-09-14T20:03:10Z INFO hpa checkout-api scaled replicas 10 -> 14 reason=cpu_utilization>70%
2026-09-14T20:03:55Z ERROR checkout-api pod=checkout-api-5c8f9-h6t3b db=pg-commerce-1 connect failed: FATAL: sorry, too many clients already
2026-09-14T20:04:12Z ERROR checkout-api POST /v1/checkout 503 duration=30008ms req-81a1f0
2026-09-14T20:04:30Z ERROR orders-api pod=orders-api-77d4b-x1c8v db=pg-commerce-1 connect failed: FATAL: remaining connection slots are reserved for non-replication superuser connections
2026-09-14T20:05:02Z WARN postgres host=pg-commerce-1 connections in_use=200 max_connections=200 by_application: checkout-api=176 orders-api=19 admin=5
2026-09-14T20:06:18Z ERROR checkout-api pod=checkout-api-5c8f9-k2x1p pool: timeout acquiring connection after 30000ms (active=20, idle=0, max=20) req-81a2d9
2026-09-14T20:12:44Z INFO deployer manual scale checkout-api replicas 14 -> 6 actor=on-call
2026-09-14T20:14:05Z INFO postgres host=pg-commerce-1 connections in_use=118 max_connections=200
2026-09-14T20:15:30Z INFO checkout-api pod=checkout-api-5c8f9-k2x1p pool=checkout-main db=pg-commerce-1 stats active=12 idle=8 max=20 waiting=0
2026-09-14T20:16:00Z INFO checkout-api p99 latency recovered to 190ms
`.trim(),
    approvalEdit: {
      fix:
        "Set checkout-api per-pod connection pool max to 8 and cap its HPA at maxReplicas 10 (10 x 8 = 80 connections). " +
        "Do not scale out to relieve pool exhaustion: every replica opens its own pool, so more replicas means more database connections.",
      notes:
        "DBA-validated constraint for database cluster pg-commerce-1: max_connections is 200, with 40 reserved for admin and replication " +
        "and a budget of 80 connections per service (checkout-api and orders-api). Rule for every service on pg-commerce-1: " +
        "per-pod pool max multiplied by HPA maxReplicas must not exceed 80.",
    },
  },
  {
    id: "db-pool-2",
    summary: "Scenario A, recurrence: orders-api on the same cluster scales out during a sale; logs show saturation but not the DB limit",
    title: "Orders API failing during flash sale — connection errors increase as it scales",
    service: "orders-api",
    severity: "SEV2",
    description:
      "Order placement has been failing intermittently since about 13:20 UTC during a flash sale. The HPA scaled orders-api out " +
      "and failures increased. No deployment today. Ongoing.",
    logs: `
2026-10-31T13:10:05Z INFO hpa orders-api scaled replicas 4 -> 8 reason=cpu_utilization>70%
2026-10-31T13:14:22Z INFO orders-api pod=orders-api-77d4b-q8m2c pool=orders-main db=pg-commerce-1 stats active=18 idle=7 max=25 waiting=0
2026-10-31T13:18:40Z INFO hpa orders-api scaled replicas 8 -> 12 reason=cpu_utilization>70%
2026-10-31T13:20:11Z WARN orders-api pod=orders-api-77d4b-q8m2c pool=orders-main db=pg-commerce-1 stats active=25 idle=0 max=25 waiting=31
2026-10-31T13:20:14Z WARN orders-api pod=orders-api-77d4b-n4k7s pool=orders-main db=pg-commerce-1 stats active=25 idle=0 max=25 waiting=26
2026-10-31T13:20:31Z ERROR orders-api pod=orders-api-77d4b-q8m2c pool: timeout acquiring connection after 30000ms (active=25, idle=0, max=25) req-c40a11
2026-10-31T13:21:02Z ERROR orders-api pod=orders-api-77d4b-z9p1f db=pg-commerce-1 connect failed: FATAL: sorry, too many clients already
2026-10-31T13:21:40Z ERROR orders-api POST /v1/orders 503 duration=30011ms req-c40a5e
2026-10-31T13:23:08Z ERROR orders-api pod=orders-api-77d4b-b3v6h db=pg-commerce-1 connect failed: FATAL: sorry, too many clients already
2026-10-31T13:24:15Z INFO hpa orders-api scaled replicas 12 -> 16 reason=cpu_utilization>70%
2026-10-31T13:25:02Z ERROR orders-api pod=orders-api-77d4b-q8m2c pool: timeout acquiring connection after 30000ms (active=25, idle=0, max=25) req-c40b90
2026-10-31T13:25:47Z ERROR orders-api pod=orders-api-77d4b-m5w2r db=pg-commerce-1 connect failed: FATAL: sorry, too many clients already
2026-10-31T13:26:30Z ERROR orders-api POST /v1/orders 503 duration=30004ms req-c40c12
`.trim(),
  },
  {
    id: "deploy-config",
    summary: "Scenario B: HTTP 500s after a deployment with a missing configuration value",
    title: "Inventory API 500s after v2.14.0 rollout",
    service: "inventory-api",
    severity: "SEV2",
    description: "HTTP 500 rate on /v1/reserve jumped from 0.1% to 62% shortly after the v2.14.0 deployment at 14:02 UTC.",
    logs: `
2026-10-20T14:02:11Z INFO deployer rollout inventory-api v2.13.4 -> v2.14.0 strategy=rolling
2026-10-20T14:03:40Z INFO inventory-api started version=v2.14.0 config_source=env
2026-10-20T14:03:41Z WARN inventory-api config key RESERVATION_LOCK_TTL_MS not set, feature reservation-locks disabled
2026-10-20T14:04:02Z ERROR inventory-api POST /v1/reserve 500 error="ReservationLockClient: missing required config RESERVATION_LOCK_TTL_MS" req-c11a01
2026-10-20T14:04:09Z ERROR inventory-api POST /v1/reserve 500 error="ReservationLockClient: missing required config RESERVATION_LOCK_TTL_MS" req-c11a07
2026-10-20T14:04:30Z INFO inventory-api GET /v1/stock 200 duration=41ms
2026-10-20T14:05:12Z ERROR inventory-api POST /v1/reserve 500 error="ReservationLockClient: missing required config RESERVATION_LOCK_TTL_MS" req-c11a55
`.trim(),
  },
  {
    id: "memory-pressure",
    summary: "Scenario C: container memory growth and restarts",
    title: "Recommendations API pods restarting",
    service: "recommendations-api",
    severity: "SEV3",
    description: "Recommendations intermittently unavailable; pods restart roughly every 40 minutes since Tuesday's release.",
    logs: `
2026-10-22T09:00:00Z INFO recommendations-api heap used=410MB limit=1024MB cache_entries=120400
2026-10-22T09:20:00Z WARN recommendations-api heap used=702MB limit=1024MB cache_entries=388100
2026-10-22T09:35:00Z WARN recommendations-api heap used=951MB limit=1024MB cache_entries=611950
2026-10-22T09:38:12Z ERROR kubelet container recommendations-api OOMKilled exit_code=137 restarts=14
2026-10-22T09:38:40Z INFO recommendations-api started cache_entries=0
2026-10-22T09:41:03Z ERROR gateway GET /v1/recommendations 503 upstream unavailable req-e0091f
`.trim(),
  },
];

export function getScenario(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown scenario "${id}". Known: ${SCENARIOS.map((x) => x.id).join(", ")}`);
  return s;
}
