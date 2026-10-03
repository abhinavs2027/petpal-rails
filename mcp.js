/**
 * MCP connectors for AgenticOrg (register each URL with the MCP box ticked):
 *   /mcp/gnani      -> Gnani real STT + TTS
 *   /mcp/delhivery  -> Delhivery mock (+ imagined #2 and #3)
 *   /mcp/pinelabs   -> Pine Labs mandate mock (+ imagined #1)
 * Every tool calls the documented REST endpoint on this server, so the console
 * shows the tool call AND the exact endpoint request/response behind it.
 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

module.exports = function mountMcp(app, { PUBLIC_BASE_URL, MOCK_TOKEN }) {
  const D = { Authorization: `Token ${MOCK_TOKEN}` };
  const B = { Authorization: `Bearer ${MOCK_TOKEN}` };

  async function rest(method, path, { query, body, headers } = {}) {
    const q = query ? Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '') : [];
    const qs = q.length ? `?${new URLSearchParams(q).toString()}` : '';
    try {
      const r = await fetch(`${PUBLIC_BASE_URL}${path}${qs}`, { method, headers: { ...(headers || {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      let response; try { response = JSON.parse(text); } catch { response = text; }
      return { endpoint: `${method} ${path}${qs}`, http_status: r.status, response };
    } catch (e) {
      return { endpoint: `${method} ${path}${qs}`, http_status: 0, response: { network_error: String(e.message || e) } };
    }
  }
  const out = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
  const tool = (s, name, description, inputSchema, fn) => s.registerTool(name, { description, inputSchema }, async (a) => out(await fn(a)));

  // ---------------- GNANI ----------------
  function gnani() {
    const s = new McpServer({ name: 'gnani', version: '1.0.0' });
    tool(s, 'gnani_speech_to_text',
      'Gnani speech-to-text (real: POST https://api.vachana.ai/stt/v3). Transcribe EVERY voice note before acting on it. language_code "en-IN" handles Hinglish (mixed Hindi-English, Latin script); "hi-IN" for Hindi. Read response.gnani_response.transcript.',
      { audio_url: z.string().describe('URL of the voice note (ogg/mp3/wav/m4a, max 60 s)'), language_code: z.string().default('en-IN'), audio_auth_header: z.string().optional().describe('Authorization header needed to download audio_url, if any') },
      (a) => rest('POST', '/gnani/stt', { headers: B, body: { ...a, format: 'transcribe' } }));
    tool(s, 'gnani_text_to_speech',
      'Gnani text-to-speech (real: POST https://api.vachana.ai/api/v1/tts/inference, Timbre v2.5). Turn EVERY reply into a voice note; returns audio_url (OGG Opus). language "hi-en" = Hinglish, "hi-IN" = Hindi, "en-IN" = English. Write amounts and numbers as words.',
      { text: z.string(), language: z.string().default('hi-en'), voice: z.string().default('Poorvi') },
      (a) => rest('POST', '/gnani/tts', { headers: B, body: a }));
    return s;
  }

  // ---------------- DELHIVERY ----------------
  const Shipment = z.object({
    name: z.string(), add: z.string(), pin: z.string(), city: z.string().optional(), state: z.string().optional(), phone: z.string(),
    order: z.string().describe('Unique order id'), payment_mode: z.enum(['Prepaid', 'COD', 'Pickup']).describe('Pickup = reverse pickup (return to seller)'),
    products_desc: z.string().optional(), hsn_code: z.string().optional(), total_amount: z.string().optional(), quantity: z.string().optional(), weight: z.string().optional().describe('grams'),
    qc: z.object({ item: z.string().optional(), description: z.string().optional(), check_seal: z.boolean().optional() }).optional().describe('Quality check for reverse pickups'),
  });
  function delhivery() {
    const s = new McpServer({ name: 'delhivery', version: '1.0.0' });
    tool(s, 'delhivery_pincode_serviceability', 'GET /c/api/pin-codes/json/ — is the pincode serviceable? Empty delivery_codes, pre_paid "N" or remarks "NSZ" = NOT serviceable.',
      { filter_codes: z.string().describe('6-digit pincode(s), comma separated') }, (a) => rest('GET', '/c/api/pin-codes/json/', { headers: D, query: a }));
    tool(s, 'delhivery_expected_tat', 'GET /api/dc/expected_tat — expected delivery days (data.tat) between two pincodes. Compare with the predicted run-out date.',
      { origin_pin: z.string(), destination_pin: z.string() }, (a) => rest('GET', '/api/dc/expected_tat', { headers: D, query: { ...a, mot: 'S', pdt: 'B2C' } }));
    tool(s, 'delhivery_shipping_cost', 'GET /api/kinko/v1/invoice/charges/.json — shipping charge estimate. md S=surface E=express; cgm = weight in grams; pt Pre-paid or COD.',
      { o_pin: z.string(), d_pin: z.string(), cgm: z.number(), md: z.enum(['S', 'E']).default('S'), pt: z.enum(['Pre-paid', 'COD']).default('Pre-paid') },
      (a) => rest('GET', '/api/kinko/v1/invoice/charges/.json', { headers: D, query: { ...a, ss: 'Delivered' } }));
    tool(s, 'delhivery_fetch_waybills', 'GET /waybill/api/bulk/json/ — pre-fetch waybill numbers.', { count: z.number().int().default(1) }, (a) => rest('GET', '/waybill/api/bulk/json/', { headers: D, query: a }));
    tool(s, 'delhivery_create_warehouse', 'POST /api/backend/clientwarehouse/create/ — register a pickup warehouse for YOUR account.',
      { name: z.string(), phone: z.string(), address: z.string(), city: z.string().optional(), pin: z.string(), return_address: z.string(), return_pin: z.string().optional(), email: z.string().optional() },
      (a) => rest('POST', '/api/backend/clientwarehouse/create/', { headers: D, body: { ...a, country: 'India' } }));
    tool(s, 'delhivery_edit_warehouse', 'POST /api/backend/clientwarehouse/edit/ — update a registered warehouse.',
      { name: z.string(), phone: z.string().optional(), address: z.string().optional(), pin: z.string().optional() }, (a) => rest('POST', '/api/backend/clientwarehouse/edit/', { headers: D, body: a }));
    tool(s, 'delhivery_create_shipment', 'POST /api/cmu/create.json — create shipment from YOUR OWN registered warehouse (PetPal has none unless created; for the pet store use delhivery_create_shipment_on_behalf).',
      { pickup_location_name: z.string(), shipments: z.array(Shipment).min(1) },
      (a) => rest('POST', '/api/cmu/create.json', { headers: D, body: { pickup_location: { name: a.pickup_location_name }, shipments: a.shipments } }));
    tool(s, 'delhivery_create_shipment_on_behalf', 'IMAGINED CAPABILITY — POST /api/cmu/create_on_behalf.json. Ship from the approved seller\'s registered warehouse on the owner\'s behalf (seller consent token). Call only after payment is PROCESSED. packages[0].status "Success" gives waybill; "Fail" gives remarks; success=false + rmk = rejected. payment_mode "Pickup" returns a wrong item to the seller.',
      { seller_client: z.string().default('HAPPYPAWS_LKO'), consent_token: z.string().default('CONSENT-BUDDY-001'), pickup_location_name: z.string().default('HAPPYPAWS_GOMTINAGAR'), shipments: z.array(Shipment).min(1) },
      (a) => rest('POST', '/api/cmu/create_on_behalf.json', { headers: D, body: { seller_client: a.seller_client, consent_token: a.consent_token, pickup_location: { name: a.pickup_location_name }, shipments: a.shipments } }));
    tool(s, 'delhivery_edit_or_cancel_shipment', 'POST /api/p/edit — cancel (cancellation true) before out-for-delivery, or edit name/address/phone.',
      { waybill: z.string(), cancellation: z.boolean().optional(), name: z.string().optional(), add: z.string().optional(), phone: z.string().optional() },
      (a) => rest('POST', '/api/p/edit', { headers: D, body: { ...a, ...(a.cancellation ? { cancellation: 'true' } : {}) } }));
    tool(s, 'delhivery_pickup_request', 'POST /fm/request/new/ — schedule a pickup at a registered warehouse.',
      { pickup_location: z.string(), pickup_date: z.string().describe('YYYY-MM-DD'), pickup_time: z.string().describe('HH:MM:SS'), expected_package_count: z.number().int().default(1) },
      (a) => rest('POST', '/fm/request/new/', { headers: D, body: a }));
    tool(s, 'delhivery_packing_slip', 'GET /api/p/packing_slip — shipping label data for waybill(s).', { wbns: z.string() }, (a) => rest('GET', '/api/p/packing_slip', { headers: D, query: a }));
    tool(s, 'delhivery_track_shipment', 'GET /api/v1/packages/json/ — track by waybill. Status: Manifested, In Transit, Dispatched (out for delivery), Pending (failed attempt/NDR), Delivered, Cancelled; reverse: Open, Scheduled, Picked Up, DTO. Includes ExpectedDeliveryDate.',
      { waybill: z.string() }, (a) => rest('GET', '/api/v1/packages/json/', { headers: D, query: a }));
    tool(s, 'delhivery_ndr_action', 'POST /api/p/update — act on a failed delivery (status Pending): RE-ATTEMPT, DEFER_DLV (deferred_date within 6 days) or EDIT_DETAILS. Returns request_id for delhivery_ndr_status.',
      { waybill: z.string(), act: z.enum(['RE-ATTEMPT', 'DEFER_DLV', 'EDIT_DETAILS']), deferred_date: z.string().optional() },
      (a) => rest('POST', '/api/p/update', { headers: D, body: { data: [a] } }));
    tool(s, 'delhivery_ndr_status', 'GET /api/cmu/get_bulk_upl/{request_id} — result of an NDR action.', { request_id: z.string() },
      (a) => rest('GET', `/api/cmu/get_bulk_upl/${encodeURIComponent(a.request_id)}`, { headers: D, query: { verbose: 'true' } }));
    tool(s, 'delhivery_direct_rush_delivery', 'IMAGINED CAPABILITY — POST /api/direct/v1/orders. Same-day rider delivery (Delhivery Direct) for urgent medicine. Works only in Delhi-NCR, Bengaluru, Mumbai, Hyderabad, Ahmedabad; otherwise CITY_NOT_SERVICEABLE. May return NO_RIDER_AVAILABLE.',
      { pickup_address: z.string(), pickup_pin: z.string(), drop_address: z.string(), drop_pin: z.string(), item_description: z.string(), receiver_phone: z.string() },
      (a) => rest('POST', '/api/direct/v1/orders', { headers: D, body: a }));
    tool(s, 'delhivery_direct_status', 'IMAGINED CAPABILITY — GET /api/direct/v1/orders/{id}: RIDER_ASSIGNED, PICKED_UP, DELIVERED.', { order_id: z.string() },
      (a) => rest('GET', `/api/direct/v1/orders/${encodeURIComponent(a.order_id)}`, { headers: D }));
    return s;
  }

  // ---------------- PINE LABS (mandate) ----------------
  function pinelabs() {
    const s = new McpServer({ name: 'pinelabs-mandate', version: '1.0.0' });
    tool(s, 'pinelabs_create_mandate', 'POST /mpp/v1/mandates — create a UPI Reserve Pay mandate. Returns deep_link the OWNER must open and approve; status PENDING_APPROVAL until then.',
      { customerReference: z.string(), mobileNumber: z.string(), amount_paise: z.number().int().positive() },
      (a) => rest('POST', '/mpp/v1/mandates', { headers: B, body: { customerReference: a.customerReference, mobileNumber: a.mobileNumber, amount: { value: a.amount_paise, currency: 'INR' }, paymentMethod: 'RESERVE_PAY' } }));
    tool(s, 'pinelabs_get_mandate', 'GET /mpp/v1/mandates/{authorizationId} — mandate status (PENDING_APPROVAL, ACTIVE, PAUSED, REVOKED).',
      { authorizationId: z.string().default('AUTH-BUDDY-RP-001') }, (a) => rest('GET', `/mpp/v1/mandates/${encodeURIComponent(a.authorizationId)}`, { headers: B }));
    tool(s, 'pinelabs_revoke_mandate', 'POST /mpp/v1/mandates/{authorizationId}/revoke — revoke a mandate (only when the owner asks).',
      { authorizationId: z.string() }, (a) => rest('POST', `/mpp/v1/mandates/${encodeURIComponent(a.authorizationId)}/revoke`, { headers: B, body: {} }));
    tool(s, 'pinelabs_get_mandate_balance', 'GET /mpp/v1/balance — fresh mandate balance. Call before EVERY payment. Amounts in paise; status must be ACTIVE.',
      { authorizationId: z.string().default('AUTH-BUDDY-RP-001') }, (a) => rest('GET', '/mpp/v1/balance', { headers: B, query: { ...a, paymentMethod: 'RESERVE_PAY' } }));
    tool(s, 'pinelabs_create_mandate_payment', 'POST /mpp/v1/payments — debit the mandate. Step 1: call WITHOUT p3pCredential -> http_status 402 with challenge.challengeId. Step 2: call again with the SAME fields plus p3pCredential = challengeId. Result: decision PROCEED (status PROCESSED / PENDING / FAILED) or DECLINE (AMOUNT_EXCEEDS_SCOPE, INSUFFICIENT_MANDATE_BALANCE, PURPOSE_OUT_OF_SCOPE). Same merchantOrderReference never charges twice. Rs 2,850 = 285000 paise.',
      { authorizationId: z.string().default('AUTH-BUDDY-RP-001'), amount_paise: z.number().int().positive(), merchantOrderReference: z.string(), merchant: z.string().default('HAPPYPAWS_LKO'), purpose: z.enum(['PET_FOOD', 'PET_MEDICINE', 'VET_CONSULT', 'GROOMING']), p3pCredential: z.string().optional() },
      (a) => rest('POST', '/mpp/v1/payments', { headers: B, body: { authorizationId: a.authorizationId, amount: { value: a.amount_paise, currency: 'INR' }, merchantOrderReference: a.merchantOrderReference, merchant: a.merchant, purpose: a.purpose, ...(a.p3pCredential ? { p3pCredential: a.p3pCredential } : {}) } }));
    tool(s, 'pinelabs_get_mandate_payment_status', 'GET /api/pay/v1/orders/{order_id} — status of a mandate payment (orderId). PENDING = poll again later; never pay again.',
      { order_id: z.string() }, (a) => rest('GET', `/api/pay/v1/orders/${encodeURIComponent(a.order_id)}`, { headers: B }));
    tool(s, 'pinelabs_get_pet_budget_summary', 'IMAGINED CAPABILITY — GET /mpp/v1/budget/summary. One pet-care budget across all merchants this month: monthlyLimit, spent, remaining, byCategory (paise).',
      { authorizationId: z.string().default('AUTH-BUDDY-RP-001') }, (a) => rest('GET', '/mpp/v1/budget/summary', { headers: B, query: a }));
    return s;
  }

  const factories = { gnani, delhivery, pinelabs };
  app.post('/mcp/:name', async (req, res) => {
    const make = factories[req.params.name];
    if (!make) return res.status(404).json({ error: 'unknown MCP connector' });
    const server = make();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch (e) { if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String(e.message || e) }, id: null }); }
  });
  const na = (req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null });
  app.get('/mcp/:name', na);
  app.delete('/mcp/:name', na);
};
