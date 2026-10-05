// The Hangtag Agent's tools, described the way the Model Context Protocol lists them (tools/list: name, title,
// description, inputSchema, annotations) and answered the way it returns them (tools/call: content, structuredContent,
// isError). The definitions are the boundary: an AI provider (or any MCP client) may only ever call these, with these
// arguments, and each says what it can touch:
//   read   — figures from the shop's own records (nothing is changed)
//   open   — shows a bill, product, customer or report on the screen (nothing is changed)
//   draft  — prepares a proposal (a reorder list, a purchase order) that is saved only when a person confirms it
// There is no tool that runs SQL, sends anything, takes payments, changes stock or prices, or deletes. Who may call a tool
// (perms: any one of them; cap: a capability the shop must have on) is checked by the tool host, never by the caller.
// Every argument is bounded; a tool never takes a shop, owner or user id (the shop is always the signed-in one).

export const AGENT_PERIODS = Object.freeze(["today", "yesterday", "7d", "month", "lastmonth", "30d"]);
const period = (dflt, what) => ({ type: "string", enum: AGENT_PERIODS, default: dflt, description: `${what}: today, yesterday, 7d (the last 7 days), month (this month so far), lastmonth or 30d (the last 30 days).` });
const limit = (dflt, max, what) => ({ type: "integer", minimum: 1, maximum: max, default: dflt, description: `How many ${what} to return (at most ${max}).` });
const NONE = Object.freeze({ type: "object", properties: {}, additionalProperties: false });
const READ = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const OPEN = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const DRAFT = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

const T = (name, kind, title, description, inputSchema, access) => Object.freeze({ name, kind, title, description, inputSchema: Object.freeze(inputSchema),
  annotations: Object.freeze({ title, ...(kind === "read" ? READ : kind === "open" ? OPEN : DRAFT) }), perms: Object.freeze(access.perms || []), cap: access.cap || null });

export const AGENT_TOOLS = Object.freeze([
  // ---------- read ----------
  T("get_today_sales", "read", "Today's sales", "Today's sales after returns, number of bills, average bill and pieces sold, the change against this time yesterday, money taken by cash, UPI and card, and sales by channel (counter, online store, sales orders, dine-in, events).",
    NONE, { perms: ["view_reports"] }),
  T("get_sales_trend", "read", "Sales trend", "Sales and bills for each of the last N days (oldest first), their total, and the total of the N days before.",
    { type: "object", properties: { days: { type: "integer", minimum: 2, maximum: 90, default: 7, description: "How many days, ending today (2 to 90)." } }, additionalProperties: false }, { perms: ["view_reports"] }),
  T("get_low_stock", "read", "Low stock", "Product variants on sale that are running low or sold out, fewest left first, with how many of each.",
    { type: "object", properties: { limit: limit(10, 50, "variants") }, additionalProperties: false }, { perms: ["view_reports", "view_products", "manage_inventory"] }),
  T("get_reorder_candidates", "read", "What to reorder", "Products Smart reorder says to reorder now, most urgent first: days of stock left at the recent sales rate and at the forecast rate (with how sure the forecast is), the suggested quantity and why; and products whose rising demand may need ordering sooner.",
    { type: "object", properties: { limit: limit(10, 30, "products") }, additionalProperties: false }, { perms: ["view_reports", "manage_inventory"] }),
  T("get_customer_dues", "read", "Customer dues", "Money customers owe the shop on bills sold on account: the total, how many customers, and the largest dues first.",
    { type: "object", properties: { limit: limit(10, 50, "customers") }, additionalProperties: false }, { perms: ["view_reports", "collect_credit"] }),
  T("get_recent_bills", "read", "Recent bills", "The latest bills, newest first: number, time, customer, total and state (paid, unpaid with what is still owed, cancelled, returned).",
    { type: "object", properties: { limit: limit(5, 20, "bills") }, additionalProperties: false }, { perms: ["view_reports", "create_sale"] }),
  T("get_payment_reconciliation", "read", "Payment reconciliation", "UPI payments checked only by hand (not yet verified with the payment provider) in the last N days, and money the provider received that isn't on any bill (when it has been loaded).",
    { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 90, default: 30, description: "How many days back to look (1 to 90)." } }, additionalProperties: false }, { perms: ["view_reports"] }),
  T("get_order_status", "read", "Orders", "Open work: sales orders to deliver, quotations waiting for an answer, orders from the online store, bills on hold, and purchase orders still to be received.",
    NONE, { perms: ["view_reports", "create_order", "create_sale"] }),
  T("get_profit_summary", "read", "Gross profit", "Gross profit for a period: net sales, the cost of the pieces sold, gross profit and margin — counted only on sales whose cost price is known, with how much of the sales that covers.",
    { type: "object", properties: { period: period("today", "The period") }, additionalProperties: false }, { perms: ["view_reports"] }),
  T("get_gst_summary", "read", "GST", "GST on the bills of a period (less credit notes): CGST, SGST, IGST and the taxable value.",
    { type: "object", properties: { period: period("month", "The period") }, additionalProperties: false }, { perms: ["view_reports"] }),
  T("get_business_profile", "read", "Business profile", "The shop's name, type of business, city and state, whether it is GST registered, and the features it uses.",
    NONE, { perms: ["view_reports"] }),
  // ---------- open (shows something; changes nothing) ----------
  T("open_bill", "open", "Open a bill", "Finds a bill by its number (e.g. INV-000127, or just 127) and offers to open it.",
    { type: "object", properties: { bill_no: { type: "string", minLength: 1, maxLength: 40, description: "The bill number, or its last digits." } }, required: ["bill_no"], additionalProperties: false }, { perms: ["view_reports", "create_sale"] }),
  T("open_product", "open", "Open a product", "Finds a product by name (or SKU) and offers to open it.",
    { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 80, description: "The product's name, part of it, or its SKU." } }, required: ["name"], additionalProperties: false }, { perms: ["view_products", "manage_products", "view_reports"] }),
  T("open_customer", "open", "Open a customer", "Finds a customer by name or phone number and offers to open their account (bills and dues).",
    { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 80, description: "The customer's name, part of it, or phone number." } }, required: ["name"], additionalProperties: false }, { perms: ["view_reports", "create_sale", "collect_credit"] }),
  T("open_report", "open", "Open reports", "Offers to open Reports for a period.",
    { type: "object", properties: { period: period("today", "The period to show") }, additionalProperties: false }, { perms: ["view_reports"] }),
  // ---------- draft (a proposal; a person confirms before anything is saved) ----------
  T("draft_reorder", "draft", "Draft a reorder", "Smart reorder's suggestion grouped by the supplier each product was last bought from: quantities and approximate cost. With a budget: a purchase plan within it — what runs out first (at the forecast rate) before the better margin; lines without a cost price listed apart. Nothing is ordered or saved.",
    { type: "object", properties: { budget: { type: "integer", minimum: 1, maximum: 100000000, description: "Rupees to spend (optional)." } }, additionalProperties: false }, { perms: ["manage_inventory", "create_purchase", "view_reports"] }),
  T("draft_purchase_order", "draft", "Draft a purchase order", "Prepares a draft purchase order for one supplier from Smart reorder's suggestion. It is saved as a draft only when the person confirms, and is never sent by itself.",
    { type: "object", properties: { supplier: { type: "string", maxLength: 80, description: "The supplier's name (optional: the first supplier with suggestions)." } }, additionalProperties: false }, { perms: ["create_purchase"], cap: "uses_purchase_orders" }),
]);
export const AGENT_TOOL_NAMES = Object.freeze(AGENT_TOOLS.map(t => t.name));
export const agentTool = name => AGENT_TOOLS.find(t => t.name === name) || null;

/* The tools/list entry an MCP client sees (no internal fields) */
export const mcpToolOf = t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations });

/* Checks a call's arguments against the tool's schema → { ok, args (with defaults) } or { ok: false, error } */
export function checkToolArgs(tool, input){
  const s = tool.inputSchema, props = s.properties || {}, out = {};
  if(input != null && (typeof input !== "object" || Array.isArray(input))) return { ok: false, error: "The arguments must be an object." };
  const args = input || {};
  for(const k of Object.keys(args)) if(!props[k]) return { ok: false, error: `“${k}” isn't an argument of ${tool.name}.` };
  for(const [k, p] of Object.entries(props)){
    let v = args[k];
    if(v == null || v === ""){ if((s.required || []).includes(k)) return { ok: false, error: `${tool.name} needs “${k}”.` }; if(p.default !== undefined) out[k] = p.default; continue; }
    if(p.type === "integer"){
      if(typeof v === "string" && /^\d+$/.test(v.trim())) v = +v;
      if(!Number.isInteger(v)) return { ok: false, error: `“${k}” must be a whole number.` };
      if(p.minimum != null && v < p.minimum || p.maximum != null && v > p.maximum) return { ok: false, error: `“${k}” must be from ${p.minimum} to ${p.maximum}.` };
    }else if(p.type === "string"){
      if(typeof v !== "string") return { ok: false, error: `“${k}” must be text.` };
      v = v.trim().replace(/\s+/g, " ");
      if(p.minLength && v.length < p.minLength) return { ok: false, error: `${tool.name} needs “${k}”.` };
      if(p.maxLength && v.length > p.maxLength) return { ok: false, error: `“${k}” is too long.` };
      if(p.enum && !p.enum.includes(v)) return { ok: false, error: `“${k}” must be one of: ${p.enum.join(", ")}.` };
    }else return { ok: false, error: `“${k}” has an unsupported type.` };
    out[k] = v;
  }
  return { ok: true, args: out };
}

/* tools/call results */
export const toolResult = (text, structured) => Object.freeze({ content: [{ type: "text", text: String(text) }], structuredContent: structured == null ? undefined : structured, isError: false });
export const toolError = text => Object.freeze({ content: [{ type: "text", text: String(text) }], isError: true });
