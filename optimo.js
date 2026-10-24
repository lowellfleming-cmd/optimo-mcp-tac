// OptimoRoute MCP connector — NW Biofuel
// Same pattern as the HazTrack connector. Reads are always on; WRITE tools
// (create/update/delete orders, planning) are disabled unless OPTIMO_ALLOW_WRITES=true,
// so this can never collide with the MuleSoft dispatch pipeline by accident.
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const BASE = process.env.OPTIMO_BASE_URL || "https://api.optimoroute.com/v1";
const KEY = process.env.OPTIMO_API_KEY || "";
const ALLOW_WRITES = String(process.env.OPTIMO_ALLOW_WRITES || "false").toLowerCase() === "true";
const PATH_TOKEN = process.env.MCP_PATH_TOKEN || "changeme";
const PORT = process.env.PORT || 8080;

async function optimo(method, path, { query, body } = {}) {
  if (!KEY) return { error: "OPTIMO_API_KEY is not set on the server. Paste it into the Railway variable and redeploy." };
  const url = new URL(BASE + path);
  url.searchParams.set("key", KEY);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) return { error: `OptimoRoute ${res.status} ${res.statusText}`, detail: data };
  return data;
}

const asResult = (d) => ({ content: [{ type: "text", text: JSON.stringify(d, null, 1) }] });
const writesOff = () => asResult({ error: "WRITES DISABLED. This tool changes live dispatch data. Set OPTIMO_ALLOW_WRITES=true on the Railway service (Lowell's call) and redeploy to enable. Reads are unaffected." });
// Org-wide read-only kill switch (Lowell, 2026-08-25). READ_ONLY wins over
// OPTIMO_ALLOW_WRITES: every WRITE tool errors before any upstream call, and
// optimo_raw rejects any non-GET method. Tools stay listed, schemas unchanged.
const READ_ONLY = ["true", "1", "yes"].includes(String(process.env.READ_ONLY || "").toLowerCase());
const READONLY_ERROR = "Read-only mode: org connectors are restricted to read access (set by owner 2026-08-25). Contact Lowell.";
const CAN_WRITE = ALLOW_WRITES && !READ_ONLY;
const denyWrite = () => READ_ONLY ? asResult({ error: READONLY_ERROR }) : writesOff();

function buildServer() {
  const server = new McpServer({ name: "OptimoRoute", version: "1.0.0" });

  server.tool("optimo_get_orders",
    "Fetch specific orders by orderNo (Salesforce WorkOrderNumber, e.g. 'IGT-00019445' style or bare number as synced). Returns order data + schedule info.",
    { orderNos: z.array(z.string()).min(1).max(500) },
    async ({ orderNos }) => asResult(await optimo("POST", "/get_orders", { body: { orders: orderNos.map(o => ({ orderNo: o })), includeOrderData: true, includeScheduleInformation: true } })));

  server.tool("optimo_search_orders",
    "Search orders by date range (YYYY-MM-DD, inclusive, max ~31 days per call). Set includeOrderData for full payloads. Use this to find stray/parked orders on frozen accounts.",
    { dateFrom: z.string(), dateTo: z.string(), includeOrderData: z.boolean().optional() },
    async ({ dateFrom, dateTo, includeOrderData }) => asResult(await optimo("POST", "/search_orders", { body: { dateRange: { from: dateFrom, to: dateTo }, includeOrderData: includeOrderData ?? false, includeScheduleInformation: true } })));

  server.tool("optimo_get_completion_details",
    "POD/completion data for orders: status, start/end times, driver form (gallons, FOG depths, notes, signature/image URLs).",
    { orderNos: z.array(z.string()).min(1).max(500) },
    async ({ orderNos }) => asResult(await optimo("POST", "/get_completion_details", { body: { orders: orderNos.map(o => ({ orderNo: o })) } })));

  server.tool("optimo_get_scheduling_info",
    "Scheduling info for one order: scheduled date/time, driver, stop position.",
    { orderNo: z.string() },
    async ({ orderNo }) => asResult(await optimo("POST", "/get_scheduling_info", { body: { orderNo } })));

  server.tool("optimo_get_routes",
    "Routes for a date (YYYY-MM-DD): per-driver stop sequences with times. Optional driverSerial filter.",
    { date: z.string(), driverSerial: z.string().optional() },
    async (q) => asResult(await optimo("GET", "/get_routes", { query: q })));

  server.tool("optimo_get_events",
    "Event feed (order created/scheduled/completed etc). Pass the previous call's tag to get only new events.",
    { tag: z.string().optional() },
    async (q) => asResult(await optimo("GET", "/get_events", { query: q })));

  server.tool("optimo_get_planning_status",
    "Status of a planning run started with optimo_start_planning.",
    { planningId: z.number() },
    async ({ planningId }) => asResult(await optimo("GET", "/get_planning_status", { query: { planningId } })));

  // ---- WRITE TOOLS (gated) ----
  server.tool("optimo_create_or_update_orders",
    `WRITE${CAN_WRITE ? "" : " (currently DISABLED)"}: bulk create/update orders (max 500). Each order needs orderNo, date, duration, location/address fields per the OptimoRoute v1 spec. The MuleSoft pipeline is the primary writer — use this only for surgical fixes.`,
    { orders: z.array(z.record(z.any())).min(1).max(500) },
    async ({ orders }) => CAN_WRITE ? asResult(await optimo("POST", "/create_or_update_orders", { body: { orders } })) : denyWrite());

  server.tool("optimo_delete_order",
    `WRITE${CAN_WRITE ? "" : " (currently DISABLED)"}: delete one order by orderNo — the stray/parked-order cleanup tool.`,
    { orderNo: z.string() },
    async ({ orderNo }) => CAN_WRITE ? asResult(await optimo("POST", "/delete_order", { body: { orderNo } })) : denyWrite());

  server.tool("optimo_start_planning",
    `WRITE${CAN_WRITE ? "" : " (currently DISABLED)"}: start route planning for a date (YYYY-MM-DD).`,
    { date: z.string() },
    async ({ date }) => CAN_WRITE ? asResult(await optimo("POST", "/start_planning", { body: { date } })) : denyWrite());

  server.tool("optimo_stop_planning",
    `WRITE${CAN_WRITE ? "" : " (currently DISABLED)"}: stop a running planning job.`,
    { planningId: z.number() },
    async ({ planningId }) => CAN_WRITE ? asResult(await optimo("POST", "/stop_planning", { body: { planningId } })) : denyWrite());

  server.tool("optimo_raw",
    "Escape hatch for spec drift: call any OptimoRoute v1 endpoint. GET requests always allowed; POST allowed only when writes are enabled OR the path starts with get_/search_ (read-style POSTs). Path example: '/get_orders'.",
    { method: z.enum(["GET", "POST"]), path: z.string().regex(/^\/[a-z_]+$/), body: z.record(z.any()).optional(), query: z.record(z.string()).optional() },
    async ({ method, path, body, query }) => {
      if (READ_ONLY && method !== "GET") return asResult({ error: READONLY_ERROR });
      const readPost = /^\/(get_|search_)/.test(path);
      if (method === "POST" && !readPost && !ALLOW_WRITES) return writesOff();
      return asResult(await optimo(method, path, { body, query }));
    });

  return server;
}

const app = express();
app.use(express.json({ limit: "4mb" }));
app.get("/healthz", (_req, res) => res.json({ ok: true, keyConfigured: Boolean(KEY), writesEnabled: CAN_WRITE, readOnly: READ_ONLY }));

app.post(`/mcp/${PATH_TOKEN}`, async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(e) }, id: null });
  }
});
const reject = (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
app.get(`/mcp/${PATH_TOKEN}`, reject);
app.delete(`/mcp/${PATH_TOKEN}`, reject);

app.listen(PORT, () => console.log(`OptimoRoute MCP listening on :${PORT} (key: ${Boolean(KEY)}, writes: ${CAN_WRITE}, readOnly: ${READ_ONLY})`));
