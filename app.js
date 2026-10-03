/**
 * PetPal rails server — The Great Rewiring 2026, Round 3 (Vercel edition)
 *
 *  DELHIVERY (MOCK, paths/fields as in Delhivery B2C docs)
 *    pincode serviceability, expected TAT, shipping cost, waybill fetch, warehouse create/edit,
 *    shipment create (forward + reverse pickup), shipment edit/cancel, pickup request, packing slip,
 *    tracking, NDR action, NDR status
 *  PINE LABS (MOCK — only what the platform's built-in Pine Labs connector lacks)
 *    mandate create / status / revoke, mandate balance, bounded mandate payment (402 challenge), payment status
 *  GNANI (REAL API via relay): speech-to-text, text-to-speech
 *  IMAGINED CAPABILITIES (3, flagged imagined_capability: true)
 *    1. Pine Labs  GET  /mpp/v1/budget/summary  (+ purpose scope on mandate payments)
 *    2. Delhivery  POST /api/cmu/create_on_behalf.json
 *    3. Delhivery  POST /api/direct/v1/orders  + GET /api/direct/v1/orders/:id
 */
const express = require('express');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const store = require('./lib/store');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const MOCK_TOKEN = process.env.MOCK_TOKEN || 'petpal-demo-token';
const CONTROL_KEY = process.env.CONTROL_KEY || 'curtain';
const GNANI_API_KEY = process.env.GNANI_API_KEY || '';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 25000);

// ---------------------------------------------------------------------------
// Day-one world
// ---------------------------------------------------------------------------
const AUTH_ID = 'AUTH-BUDDY-RP-001';
const SELLERS = {
  HAPPYPAWS_LKO: { display: 'HappyPaws Pet Store, Lucknow', warehouses: ['HAPPYPAWS_GOMTINAGAR'], warehouse_pin: '226010', consent_token: 'CONSENT-BUDDY-001' },
};
const PIN_DB = {
  '226010': { city: 'Lucknow', district: 'Lucknow', state_code: 'UP', sort_code: 'LKO/GTN' },
  '226001': { city: 'Lucknow', district: 'Lucknow', state_code: 'UP', sort_code: 'LKO/HZG' },
  '700019': { city: 'Kolkata', district: 'Kolkata', state_code: 'WB', sort_code: 'CCU/BLG' },
  '110001': { city: 'New Delhi', district: 'New Delhi', state_code: 'DL', sort_code: 'DEL/CNP' },
  '122002': { city: 'Gurugram', district: 'Gurgaon', state_code: 'HR', sort_code: 'GGN/DLF' },
  '560001': { city: 'Bengaluru', district: 'Bangalore', state_code: 'KA', sort_code: 'BLR/MGR' },
  '400001': { city: 'Mumbai', district: 'Mumbai', state_code: 'MH', sort_code: 'BOM/FRT' },
  '500001': { city: 'Hyderabad', district: 'Hyderabad', state_code: 'TG', sort_code: 'HYD/ABD' },
  '380001': { city: 'Ahmedabad', district: 'Ahmedabad', state_code: 'GJ', sort_code: 'AMD/LAL' },
};
// Delhivery Direct (same-day) cities today: Delhi-NCR, Bengaluru, Mumbai, Hyderabad, Ahmedabad
const DIRECT_PIN_PREFIXES = ['110', '120', '121', '122', '201', '560', '400', '500', '380'];
const PURPOSE_SCOPE = ['PET_FOOD', 'PET_MEDICINE', 'VET_CONSULT', 'GROOMING'];

function defaultScenario() {
  return {
    mandate_status: 'ACTIVE',            // ACTIVE | PAUSED | REVOKED
    mandate_blocked_paise: 400000,       // Rs 4,000 blocked
    per_txn_cap_paise: 300000,           // Rs 3,000 per payment
    monthly_budget_paise: 500000,        // Rs 5,000 pet budget (imagined)
    budget_spent_before_paise: 120000,   // Rs 1,200 already spent (grooming)
    payment_outcome: 'PROCESSED',        // PROCESSED | PENDING | FAILED
    pending_polls: 2,
    delivery: 'normal',                  // normal | ndr | delayed
    unserviceable_pins: ['744301'],
    oda_pins: ['194101'],
    direct_riders: 'available',          // available | none
    timeout_next: [], malformed_next: [], error_next: [],
  };
}
function freshState() {
  return {
    scenario: defaultScenario(), debited_paise: 0,
    mandates: { [AUTH_ID]: { authorizationId: AUTH_ID, customerReference: 'BUDDY-OWNER', mobileNumber: '9999999999', amount: 400000, paymentMethod: 'RESERVE_PAY', status: 'ACTIVE', created_at: new Date().toISOString() } },
    challenges: {}, orders: {}, shipments: {}, upls: {}, warehouses: {}, pickups: {}, direct: {},
  };
}

// Per-request state (safe under concurrent requests)
const als = new AsyncLocalStorage();
const S = () => als.getStore();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const rid = (p) => `${p}${crypto.randomBytes(6).toString('hex')}`;
const inr = (paise) => ({ value: paise, currency: 'INR' });
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const ymd = (d) => d.toISOString().slice(0, 10);
const take = (list, op) => { const i = list.indexOf(op); if (i === -1) return false; list.splice(i, 1); return true; };

async function injectFault(op, res, kind) {
  const s = S().scenario;
  if (take(s.timeout_next, op)) {
    res.locals.injected = `timeout:${op}`;
    await sleep(TIMEOUT_MS);
    res.status(504).type('text/html').send('<html><head><title>504 Gateway Time-out</title></head><body><center><h1>504 Gateway Time-out</h1></center></body></html>');
    return true;
  }
  if (take(s.malformed_next, op)) {
    res.locals.injected = `malformed:${op}`;
    res.status(200).type('application/json').send('{"status":"ok","data":{"waybill":"28"');
    return true;
  }
  if (take(s.error_next, op)) {
    res.locals.injected = `error:${op}`;
    if (kind === 'delhivery') res.status(500).json({ error: 'Internal Server Error', success: false });
    else if (kind === 'pinelabs') res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable. Please retry.' });
    else res.status(503).json({ success: false, error: { type: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable.' } });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Load state -> run request -> save state + log, before the response is released
// ---------------------------------------------------------------------------
app.use(async (req, res, next) => {
  const isMcp = req.path.startsWith('/mcp/');
  const skipLog = req.path.startsWith('/mock/') || req.path.startsWith('/audio/') || req.path === '/favicon.ico' || req.path === '/'
    || (isMcp && !(req.body && req.body.method === 'tools/call'));
  let st = null;
  if (!isMcp) {
    try { const raw = await store.get('state'); st = raw ? JSON.parse(raw) : freshState(); }
    catch (e) { return res.status(500).json({ error: `state store unavailable: ${e.message}` }); }
  }
  const started = Date.now();
  const chunks = [];
  const origSend = res.send.bind(res);
  res.send = (body) => {
    if (Buffer.isBuffer(body)) chunks.push(`<${body.length} bytes binary>`);
    else chunks.push(typeof body === 'string' ? body : JSON.stringify(body));
    return origSend(body);
  };
  const origEnd = res.end.bind(res);
  let ended = false;
  res.end = (...args) => {
    if (ended) return origEnd(...args);
    ended = true;
    if (!chunks.length && args[0] && typeof args[0] !== 'function') chunks.push(Buffer.isBuffer(args[0]) ? args[0].toString('utf8') : String(args[0]));
    const work = [];
    if (st && !res.locals.readOnly) work.push(store.set('state', JSON.stringify(st)));
    if (!skipLog) {
      let request = req.body && Object.keys(req.body).length ? req.body : null;
      if (isMcp && request) request = { tool: request.params && request.params.name, arguments: request.params && request.params.arguments };
      let response = chunks.join('');
      if (isMcp) { try { const j = JSON.parse(response); response = (j.result && j.result.content && j.result.content[0] && j.result.content[0].text) || response; } catch { /* keep */ } }
      work.push(store.push('log', JSON.stringify({
        at: new Date(started).toISOString(), ms: Date.now() - started, method: isMcp ? 'MCP' : req.method,
        path: req.originalUrl, status: res.statusCode, injected: res.locals.injected || null, request, response: String(response).slice(0, 6000),
      })));
    }
    Promise.all(work).catch((e) => console.error('store error', e)).finally(() => origEnd(...args));
    return res;
  };
  if (st) als.run(st, next); else next();
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
const delhiveryAuth = (req, res, next) => (req.headers.authorization === `Token ${MOCK_TOKEN}` ? next() : res.status(401).json({ detail: 'Authentication credentials were not provided or are invalid.' }));
const pinelabsAuth = (req, res, next) => (req.headers.authorization === `Bearer ${MOCK_TOKEN}` ? next() : res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid or expired access token' }));
const relayAuth = (req, res, next) => (req.headers.authorization === `Bearer ${MOCK_TOKEN}` ? next() : res.status(401).json({ error: 'relay: invalid bearer token' }));
const controlAuth = (req, res, next) => ((req.query.key || req.headers['x-control-key']) === CONTROL_KEY ? next() : res.status(403).json({ error: 'control key required (?key=...)' }));

function parseDelhiveryPayload(req) {
  if (req.body && typeof req.body.data === 'string') { try { return JSON.parse(req.body.data); } catch { return null; } }
  return req.body || null;
}

// ===========================================================================
// DELHIVERY (MOCK)
// ===========================================================================
app.get('/c/api/pin-codes/json/', delhiveryAuth, async (req, res) => {
  if (await injectFault('delhivery_pincode_serviceability', res, 'delhivery')) return;
  const s = S().scenario;
  const codes = String(req.query.filter_codes || '').split(',').map((c) => c.trim()).filter((c) => /^\d{6}$/.test(c));
  res.json({
    delivery_codes: codes.map((pin) => {
      const info = PIN_DB[pin] || { city: 'NA', district: 'NA', state_code: 'NA', sort_code: 'NA' };
      const nsz = s.unserviceable_pins.includes(pin);
      return { postal_code: {
        pin: Number(pin), city: info.city, district: info.district, state_code: info.state_code, country_code: 'IN',
        sort_code: nsz ? '' : info.sort_code, pre_paid: nsz ? 'N' : 'Y', cod: nsz ? 'N' : 'Y', cash: nsz ? 'N' : 'Y',
        pickup: nsz ? 'N' : 'Y', repl: nsz ? 'N' : 'Y', is_oda: s.oda_pins.includes(pin) ? 'Y' : 'N', remarks: nsz ? 'NSZ' : '', max_amount: 0, max_weight: 0,
      } };
    }),
  });
});

function tatDays(o, d) {
  const a = PIN_DB[o]; const b = PIN_DB[d];
  return (a && b && a.state_code === b.state_code ? 2 : 4) + (S().scenario.delivery === 'delayed' ? 4 : 0);
}

app.get('/api/dc/expected_tat', delhiveryAuth, async (req, res) => {
  if (await injectFault('delhivery_expected_tat', res, 'delhivery')) return;
  const { origin_pin, destination_pin } = req.query;
  if (!/^\d{6}$/.test(String(origin_pin || '')) || !/^\d{6}$/.test(String(destination_pin || ''))) return res.status(400).json({ status: false, msg: 'origin_pin and destination_pin must be 6-digit pincodes', data: {} });
  if (S().scenario.unserviceable_pins.includes(String(destination_pin))) return res.json({ status: false, msg: 'Destination pincode not serviceable', data: {} });
  res.json({ status: true, msg: '', data: { tat: tatDays(String(origin_pin), String(destination_pin)) } });
});

// Shipping cost — GET /api/kinko/v1/invoice/charges/.json?md=S&ss=Delivered&d_pin=&o_pin=&cgm=&pt=Pre-paid
app.get('/api/kinko/v1/invoice/charges/.json', delhiveryAuth, async (req, res) => {
  if (await injectFault('delhivery_shipping_cost', res, 'delhivery')) return;
  const { md = 'S', ss = 'Delivered', d_pin, o_pin, cgm, pt = 'Pre-paid' } = req.query;
  if (!/^\d{6}$/.test(String(d_pin || '')) || !/^\d{6}$/.test(String(o_pin || '')) || !Number(cgm)) return res.status(400).json({ error: 'd_pin, o_pin (6 digits) and cgm (grams) are required' });
  const slabs = Math.ceil(Number(cgm) / 500);
  const same = PIN_DB[o_pin] && PIN_DB[d_pin] && PIN_DB[o_pin].state_code === PIN_DB[d_pin].state_code;
  const freight = slabs * (same ? 38 : 62) * (md === 'E' ? 1.8 : 1);
  const cod = pt === 'COD' ? 35 : 0;
  const gross = Math.round((freight + cod) * 100) / 100;
  const tax = Math.round(gross * 0.18 * 100) / 100;
  res.json([{ zone: same ? 'B' : 'D', status: ss, charged_weight: slabs * 500, charge_DL: freight, charge_COD: cod, gross_amount: gross, tax_data: { IGST: tax, SGST: 0, CGST: 0 }, total_amount: Math.round((gross + tax) * 100) / 100 }]);
});

function newWaybill() { return String(Date.now()).slice(-8) + String(Math.floor(100000 + Math.random() * 899999)); }

// Fetch waybills — GET /waybill/api/bulk/json/?count=5
app.get('/waybill/api/bulk/json/', delhiveryAuth, async (req, res) => {
  if (await injectFault('delhivery_fetch_waybills', res, 'delhivery')) return;
  const n = Math.min(Math.max(Number(req.query.count) || 1, 1), 50);
  res.type('text/plain').send(Array.from({ length: n }, newWaybill).join(','));
});

// Warehouse create / edit
app.post('/api/backend/clientwarehouse/create/', delhiveryAuth, async (req, res) => {
  if (await injectFault('delhivery_create_warehouse', res, 'delhivery')) return;
  const b = req.body || {};
  const missing = ['name', 'phone', 'address', 'pin', 'return_address'].filter((f) => !b[f]);
  if (missing.length) return res.status(400).json({ success: false, error: [`Missing mandatory field(s): ${missing.join(', ')}`] });
  if (S().warehouses[b.name]) return res.status(400).json({ success: false, error: ['Warehouse with this name already exists'] });
  S().warehouses[b.name] = { ...b, created_at: nowIso() };
  res.json({ success: true, data: { name: b.name, pincode: b.pin, business_hours: b.business_hours || null, message: 'Warehouse created' } });
});
app.post('/api/backend/clientwarehouse/edit/', delhiveryAuth, async (req, res) => {
  if (await injectFault('delhivery_edit_warehouse', res, 'delhivery')) return;
  const b = req.body || {};
  if (!S().warehouses[b.name]) return res.status(404).json({ success: false, error: ['ClientWarehouse matching query does not exist.'] });
  Object.assign(S().warehouses[b.name], b);
  res.json({ success: true, data: { name: b.name, message: 'Warehouse updated' } });
});

function createShipments(payload, res, { sellerClient }) {
  const st = S(); const s = st.scenario;
  const pickup = payload.pickup_location && payload.pickup_location.name;
  const shipments = Array.isArray(payload.shipments) ? payload.shipments : [];
  const allowed = sellerClient ? SELLERS[sellerClient].warehouses : Object.keys(st.warehouses);
  if (!pickup || !allowed.includes(pickup)) {
    return res.json({ cash_pickups_count: 0, package_count: 0, upload_wbn: null, replacement_count: 0, rmk: 'ClientWarehouse matching query does not exist.', pickups_count: 0, packages: [], cash_pickups: 0, cod_count: 0, success: false, prepaid_count: 0, cod_amount: 0 });
  }
  if (!shipments.length) return res.json({ success: false, rmk: 'No shipments found in payload', packages: [], package_count: 0 });
  const originPin = sellerClient ? SELLERS[sellerClient].warehouse_pin : st.warehouses[pickup].pin;
  const packages = []; let prepaid = 0; let cod = 0; let reverse = 0;
  for (const sh of shipments) {
    const missing = ['name', 'add', 'pin', 'phone', 'order', 'payment_mode'].filter((f) => !sh[f]);
    if (missing.length) { packages.push({ status: 'Fail', waybill: '', refnum: sh.order || '', serviceable: false, remarks: [`Missing mandatory field(s): ${missing.join(', ')}`] }); continue; }
    if (Object.values(st.shipments).some((x) => x.order === String(sh.order))) { packages.push({ status: 'Fail', waybill: '', refnum: String(sh.order), serviceable: true, remarks: ['Duplicate order id'] }); continue; }
    const pin = String(sh.pin);
    if (s.unserviceable_pins.includes(pin) || !/^\d{6}$/.test(pin)) { packages.push({ status: 'Fail', waybill: '', refnum: String(sh.order), serviceable: false, remarks: ['Non serviceable pincode'] }); continue; }
    const mode = String(sh.payment_mode);
    const isReverse = mode.toLowerCase() === 'pickup';
    const waybill = newWaybill();
    st.shipments[waybill] = {
      waybill, order: String(sh.order), pin, consignee: sh.name, add: sh.add, phone: sh.phone, created_at: nowIso(),
      expected: ymd(addDays(new Date(), tatDays(originPin, pin))), step: 0, polled: false, mode: s.delivery, reverse: isReverse,
      qc: sh.qc || null, ndr_reattempted: false, pending: false, delay_polls: 3, first_pending: null, cancelled: false, products_desc: sh.products_desc || '',
    };
    if (isReverse) reverse++; else if (mode.toLowerCase() === 'cod') cod++; else prepaid++;
    packages.push({ status: 'Success', client: sellerClient || 'PETPAL', sort_code: (PIN_DB[pin] || {}).sort_code || 'NA', remarks: [], waybill, cod_amount: 0, payment: mode, serviceable: true, refnum: String(sh.order) });
  }
  const ok = packages.filter((p) => p.status === 'Success');
  res.json({
    cash_pickups_count: 0, package_count: ok.length, upload_wbn: rid('UPL'), replacement_count: 0, pickups_count: reverse,
    packages, cash_pickups: 0, cod_count: cod, success: ok.length > 0, prepaid_count: prepaid, cod_amount: 0,
    ...(sellerClient ? { on_behalf_of: sellerClient, imagined_capability: true } : {}),
  });
}

// Shipment creation (forward, or reverse pickup with payment_mode "Pickup") from YOUR registered warehouse
app.post('/api/cmu/create.json', delhiveryAuth, async (req, res) => {
  if (await injectFault('delhivery_create_shipment', res, 'delhivery')) return;
  const p = parseDelhiveryPayload(req);
  if (!p) return res.status(400).json({ success: false, rmk: 'Invalid JSON in data parameter' });
  createShipments(p, res, { sellerClient: null });
});

// IMAGINED #2 — shipment from an approved seller's warehouse, on the owner's behalf, with seller consent
app.post('/api/cmu/create_on_behalf.json', delhiveryAuth, async (req, res) => {
  if (await injectFault('delhivery_create_shipment_on_behalf', res, 'delhivery')) return;
  const p = parseDelhiveryPayload(req);
  if (!p) return res.status(400).json({ success: false, rmk: 'Invalid JSON in data parameter' });
  const seller = SELLERS[p.seller_client];
  if (!seller) return res.status(404).json({ success: false, rmk: `Seller client '${p.seller_client}' not found`, imagined_capability: true });
  if (p.consent_token !== seller.consent_token) return res.status(403).json({ success: false, rmk: 'Seller has not granted this agent consent to create shipments (invalid consent_token)', imagined_capability: true });
  createShipments(p, res, { sellerClient: p.seller_client });
});

// Edit or cancel — POST /api/p/edit  {waybill, cancellation:"true"} or {waybill, name/add/phone...}
app.post('/api/p/edit', delhiveryAuth, async (req, res) => {
  if (await injectFault('delhivery_edit_or_cancel_shipment', res, 'delhivery')) return;
  const b = req.body || {};
  const sh = S().shipments[b.waybill];
  if (!sh) return res.json({ status: false, waybill: b.waybill || '', error: 'Waybill not found' });
  if (sh.step >= 4) return res.json({ status: false, waybill: sh.waybill, error: 'Shipment already delivered; edit/cancel not allowed' });
  if (String(b.cancellation).toLowerCase() === 'true') {
    if (sh.step >= 3) return res.json({ status: false, waybill: sh.waybill, error: 'Shipment is out for delivery; cancellation not allowed' });
    sh.cancelled = true;
    return res.json({ status: true, waybill: sh.waybill, remark: 'Shipment has been cancelled' });
  }
  for (const f of ['name', 'add', 'phone', 'products_desc']) if (b[f]) sh[f === 'name' ? 'consignee' : f] = b[f];
  res.json({ status: true, waybill: sh.waybill, remark: 'Shipment details updated' });
});

// Pickup request — POST /fm/request/new/
app.post('/fm/request/new/', delhiveryAuth, async (req, res) => {
  if (await injectFault('delhivery_pickup_request', res, 'delhivery')) return;
  const b = req.body || {};
  if (!b.pickup_location || !b.pickup_date || !b.pickup_time) return res.status(400).json({ error: 'pickup_location, pickup_date (YYYY-MM-DD) and pickup_time (HH:MM:SS) are required' });
  const known = Object.keys(S().warehouses).concat(...Object.values(SELLERS).map((x) => x.warehouses));
  if (!known.includes(b.pickup_location)) return res.status(400).json({ pr_exist: false, error: 'ClientWarehouse matching query does not exist.' });
  const pickup_id = Math.floor(10000000 + Math.random() * 89999999);
  S().pickups[pickup_id] = { ...b, created_at: nowIso() };
  res.json({ pickup_id, incoming_center_name: 'Lucknow_Gomtinagar_C (Uttar Pradesh)', pickup_date: b.pickup_date, pickup_time: b.pickup_time, expected_package_count: Number(b.expected_package_count || 1), pr_exist: false });
});

// Packing slip / label — GET /api/p/packing_slip?wbns=
app.get('/api/p/packing_slip', delhiveryAuth, async (req, res) => {
  if (await injectFault('delhivery_packing_slip', res, 'delhivery')) return;
  const ids = String(req.query.wbns || '').split(',').filter(Boolean);
  const packages = ids.map((w) => S().shipments[w]).filter(Boolean).map((sh) => ({ wbn: sh.waybill, oid: sh.order, name: sh.consignee, pin: Number(sh.pin), address: sh.add, sort_code: (PIN_DB[sh.pin] || {}).sort_code || 'NA', barcode: `data:image/png;base64,${Buffer.from(sh.waybill).toString('base64')}` }));
  res.json({ packages, packages_found: packages.length });
});

const STEPS = [
  { Status: 'Manifested', StatusType: 'UD', Instructions: 'Shipment information received', loc: 'Lucknow_Gomtinagar_C (Uttar Pradesh)' },
  { Status: 'In Transit', StatusType: 'UD', Instructions: 'Shipment picked up', loc: 'Lucknow_Gomtinagar_C (Uttar Pradesh)' },
  { Status: 'In Transit', StatusType: 'UD', Instructions: 'Shipment received at destination hub', loc: 'Lucknow_Hub (Uttar Pradesh)' },
  { Status: 'Dispatched', StatusType: 'UD', Instructions: 'Out for delivery', loc: 'Lucknow_Hub (Uttar Pradesh)' },
  { Status: 'Delivered', StatusType: 'DL', Instructions: 'Delivered to consignee', loc: 'Lucknow_Hub (Uttar Pradesh)' },
];
const RSTEPS = [
  { Status: 'Open', StatusType: 'PP', Instructions: 'Pickup request created', loc: 'Lucknow_Hub (Uttar Pradesh)' },
  { Status: 'Scheduled', StatusType: 'PP', Instructions: 'Pickup scheduled', loc: 'Lucknow_Hub (Uttar Pradesh)' },
  { Status: 'Picked Up', StatusType: 'PU', Instructions: 'Item picked up after QC check', loc: 'Lucknow_Gomtinagar_C (Uttar Pradesh)' },
  { Status: 'In Transit', StatusType: 'PU', Instructions: 'Return in transit to seller', loc: 'Lucknow_Hub (Uttar Pradesh)' },
  { Status: 'DTO', StatusType: 'DTO', Instructions: 'Delivered to origin (seller)', loc: 'Lucknow_Gomtinagar_C (Uttar Pradesh)' },
];
const NDR = { Status: 'Pending', StatusType: 'UD', Instructions: 'Consignee unavailable', loc: 'Lucknow_Hub (Uttar Pradesh)', NSLCode: 'EOD-11' };

function advance(sh) {
  const steps = sh.reverse ? RSTEPS : STEPS;
  if (sh.cancelled) return { Status: 'Cancelled', StatusType: 'CN', Instructions: 'Shipment cancelled by client', loc: steps[sh.step].loc };
  if (!sh.polled) { sh.polled = true; return steps[0]; }
  if (!sh.reverse) {
    if (sh.mode === 'ndr' && sh.step === 3 && !sh.ndr_reattempted && !sh.pending) { sh.pending = true; sh.first_pending = sh.first_pending || nowIso(); return NDR; }
    if (sh.pending) { if (!sh.ndr_reattempted) return NDR; sh.pending = false; sh.step = 3; return STEPS[3]; }
    if (sh.mode === 'delayed' && sh.step === 2 && sh.delay_polls > 0) { sh.delay_polls--; return { ...STEPS[2], Instructions: 'Shipment delayed at hub due to network congestion' }; }
  }
  if (sh.step < steps.length - 1) sh.step++;
  return steps[sh.step];
}

app.get('/api/v1/packages/json/', delhiveryAuth, async (req, res) => {
  if (await injectFault('delhivery_track_shipment', res, 'delhivery')) return;
  const ids = String(req.query.waybill || req.query.ref_ids || '').split(',').map((x) => x.trim()).filter(Boolean);
  const ShipmentData = [];
  for (const id of ids) {
    const sh = S().shipments[id] || Object.values(S().shipments).find((x) => x.order === id);
    if (!sh) continue;
    const st = advance(sh);
    sh.scans = (sh.scans || []).concat([{ ScanDetail: { ScanDateTime: nowIso(), ScanType: st.StatusType, Scan: st.Status, StatusDateTime: nowIso(), ScannedLocation: st.loc, Instructions: st.Instructions, StatusCode: st.NSLCode || '' } }]);
    ShipmentData.push({ Shipment: {
      AWB: sh.waybill, ReferenceNo: sh.order, OrderType: sh.reverse ? 'Pickup' : 'Pre-paid', Destination: (PIN_DB[sh.pin] || {}).city || 'NA',
      Consignee: { Name: sh.consignee, PinCode: Number(sh.pin) },
      Status: { Status: st.Status, StatusType: st.StatusType, StatusDateTime: nowIso(), StatusLocation: st.loc, Instructions: st.Instructions, StatusCode: st.NSLCode || '' },
      ExpectedDeliveryDate: sh.mode === 'delayed' && !sh.reverse ? ymd(addDays(new Date(sh.expected), 2)) : sh.expected, PickUpDate: sh.created_at, Scans: sh.scans,
    } });
  }
  if (!ShipmentData.length) return res.json({ ShipmentData: [], Error: 'No such waybill or Order Id found' });
  res.json({ ShipmentData });
});

app.post('/api/p/update', delhiveryAuth, async (req, res) => {
  if (await injectFault('delhivery_ndr_action', res, 'delhivery')) return;
  const items = Array.isArray(req.body && req.body.data) ? req.body.data : null;
  if (!items || !items.length) return res.status(400).json({ error: 'data must be a non-empty list of {waybill, act}' });
  const upl = crypto.randomUUID();
  const result = items.map((it) => {
    const sh = S().shipments[it.waybill]; const act = String(it.act || '').toUpperCase();
    if (!sh) return { waybill: it.waybill, status: 'Failure', remark: 'Waybill not found' };
    if (!['RE-ATTEMPT', 'DEFER_DLV', 'EDIT_DETAILS'].includes(act)) return { waybill: it.waybill, status: 'Failure', remark: `Invalid act '${it.act}'` };
    if (!sh.pending) return { waybill: it.waybill, status: 'Failure', remark: 'Action not allowed for current shipment status' };
    if (act === 'DEFER_DLV') {
      const d = new Date(it.deferred_date || ''); const limit = addDays(new Date(sh.first_pending), 6);
      if (isNaN(d) || d > limit) return { waybill: it.waybill, status: 'Failure', remark: 'Deferred date must be within 6 days of first pending date' };
    }
    sh.ndr_reattempted = true;
    return { waybill: it.waybill, status: 'Success', remark: `${act} applied` };
  });
  S().upls[upl] = { status: 'Completed', result, created_at: nowIso() };
  res.json({ request_id: upl });
});

app.get('/api/cmu/get_bulk_upl/:upl', delhiveryAuth, async (req, res) => {
  if (await injectFault('delhivery_ndr_status', res, 'delhivery')) return;
  const u = S().upls[req.params.upl];
  if (!u) return res.status(404).json({ status: 'Failure', error: 'UPL not found' });
  res.json({ status: u.status, request_id: req.params.upl, result: u.result });
});

// IMAGINED #3 — Delhivery Direct same-day rush delivery as an API (today: consumer app only)
app.post('/api/direct/v1/orders', delhiveryAuth, async (req, res) => {
  if (await injectFault('delhivery_direct_create', res, 'delhivery')) return;
  const b = req.body || {};
  const missing = ['pickup_address', 'pickup_pin', 'drop_address', 'drop_pin', 'item_description', 'receiver_phone'].filter((f) => !b[f]);
  if (missing.length) return res.status(400).json({ success: false, error: `Missing field(s): ${missing.join(', ')}`, imagined_capability: true });
  const inCity = (p) => DIRECT_PIN_PREFIXES.some((x) => String(p).startsWith(x));
  if (!inCity(b.pickup_pin) || !inCity(b.drop_pin)) {
    return res.status(422).json({ success: false, code: 'CITY_NOT_SERVICEABLE', message: 'Delhivery Direct is available in Delhi-NCR, Bengaluru, Mumbai, Hyderabad and Ahmedabad only', imagined_capability: true });
  }
  if (S().scenario.direct_riders === 'none') return res.status(409).json({ success: false, code: 'NO_RIDER_AVAILABLE', message: 'No rider available near pickup. Retry in 10 minutes or use standard delivery.', imagined_capability: true });
  const id = rid('DD-');
  S().direct[id] = { id, ...b, status: 'RIDER_ASSIGNED', polls: 0, created_at: nowIso() };
  res.json({ success: true, imagined_capability: true, order_id: id, status: 'RIDER_ASSIGNED', rider: { name: 'Rakesh', phone_masked: '98XXXXX210' }, pickup_eta_minutes: 12, drop_eta_minutes: 45 });
});
app.get('/api/direct/v1/orders/:id', delhiveryAuth, async (req, res) => {
  if (await injectFault('delhivery_direct_status', res, 'delhivery')) return;
  const o = S().direct[req.params.id];
  if (!o) return res.status(404).json({ success: false, error: 'Order not found', imagined_capability: true });
  const seq = ['RIDER_ASSIGNED', 'PICKED_UP', 'DELIVERED'];
  o.polls = Math.min(o.polls + 1, 2); o.status = seq[o.polls];
  res.json({ success: true, imagined_capability: true, order_id: o.id, status: o.status, updated_at: nowIso() });
});

// ===========================================================================
// PINE LABS (MOCK — mandate / Reserve Pay / P3P; payment links, orders, refunds use the built-in connector)
// ===========================================================================
const remainingPaise = (m) => Math.max(0, S().scenario.mandate_blocked_paise - S().debited_paise);

// Create mandate — owner must approve at deep_link before it becomes ACTIVE
app.post('/mpp/v1/mandates', pinelabsAuth, async (req, res) => {
  if (await injectFault('pinelabs_create_mandate', res, 'pinelabs')) return;
  const b = req.body || {};
  const amt = b.amount && Number(b.amount.value);
  if (!b.customerReference || !/^\d{10}$/.test(String(b.mobileNumber || '')) || !amt) return res.status(400).json({ code: 'INVALID_REQUEST', message: 'customerReference, mobileNumber (10 digits) and amount.value (paise) are required' });
  if (b.paymentMethod && b.paymentMethod !== 'RESERVE_PAY') return res.status(400).json({ code: 'UNSUPPORTED', message: 'Only RESERVE_PAY is supported in this sandbox' });
  const id = rid('AUTH-');
  S().mandates[id] = { authorizationId: id, customerReference: b.customerReference, mobileNumber: b.mobileNumber, amount: amt, paymentMethod: 'RESERVE_PAY', status: 'PENDING_APPROVAL', created_at: nowIso() };
  res.json({ authorizationId: id, status: 'PENDING_APPROVAL', amount: inr(amt), deep_link: `${PUBLIC_BASE_URL}/approve/${id}`, message: 'Owner must approve this mandate in their UPI app before any debit' });
});
app.get('/mpp/v1/mandates/:id', pinelabsAuth, async (req, res) => {
  if (await injectFault('pinelabs_get_mandate', res, 'pinelabs')) return;
  const m = S().mandates[req.params.id];
  if (!m) return res.status(404).json({ code: 'MANDATE_NOT_FOUND', message: 'No mandate found for this authorizationId' });
  if (m.authorizationId === AUTH_ID) m.status = S().scenario.mandate_status;
  res.json(m);
});
app.post('/mpp/v1/mandates/:id/revoke', pinelabsAuth, async (req, res) => {
  if (await injectFault('pinelabs_revoke_mandate', res, 'pinelabs')) return;
  const m = S().mandates[req.params.id];
  if (!m) return res.status(404).json({ code: 'MANDATE_NOT_FOUND', message: 'No mandate found for this authorizationId' });
  m.status = 'REVOKED'; if (m.authorizationId === AUTH_ID) S().scenario.mandate_status = 'REVOKED';
  res.json({ authorizationId: m.authorizationId, status: 'REVOKED', releasedAmount: inr(remainingPaise()) });
});
// Owner's approval screen (stand-in for the UPI app)
app.get('/approve/:id', (req, res) => {
  res.locals.readOnly = true;
  const m = S().mandates[req.params.id];
  if (!m) return res.status(404).send('Mandate not found');
  const amt = (m.amount / 100).toLocaleString('en-IN');
  res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve UPI mandate</title><style>body{font-family:system-ui;background:#f4f6f8;padding:24px}.c{max-width:380px;margin:auto;background:#fff;border-radius:14px;padding:24px}.a{font-size:32px;font-weight:700;margin:8px 0}button{width:100%;padding:14px;border:0;border-radius:10px;background:#0b6b3a;color:#fff;font-size:16px}</style></head><body><div class="c"><div>UPI Reserve Pay · PetPal</div><div class="a">Block ₹${amt}</div><p>PetPal may spend from this block on Buddy's routine care within your limits. Status: <b>${m.status}</b></p>${m.status === 'PENDING_APPROVAL' ? `<form method="post" action="/approve/${m.authorizationId}"><button>Approve with UPI PIN</button></form>` : ''}<p style="font-size:12px;color:#888">Mock approval screen (Round 3 simulation)</p></div></body></html>`);
});
app.post('/approve/:id', (req, res) => {
  const m = S().mandates[req.params.id];
  if (m && m.status === 'PENDING_APPROVAL') m.status = 'ACTIVE';
  res.redirect(`/approve/${req.params.id}`);
});

app.get('/mpp/v1/balance', pinelabsAuth, async (req, res) => {
  if (await injectFault('pinelabs_get_mandate_balance', res, 'pinelabs')) return;
  const { authorizationId, paymentMethod } = req.query;
  if (!authorizationId) return res.status(400).json({ code: 'INVALID_REQUEST', message: 'authorizationId is required' });
  const m = S().mandates[authorizationId];
  if (!m) return res.status(404).json({ code: 'MANDATE_NOT_FOUND', message: 'No mandate found for this authorizationId' });
  if (paymentMethod && paymentMethod !== 'RESERVE_PAY') return res.status(400).json({ code: 'UNSUPPORTED', message: 'Balance check is supported only for RESERVE_PAY mandates' });
  const s = S().scenario; const main = authorizationId === AUTH_ID;
  res.json({
    authorizationId, paymentMethod: 'RESERVE_PAY', status: main ? s.mandate_status : m.status,
    blockedAmount: inr(main ? s.mandate_blocked_paise : m.amount), debitedAmount: inr(main ? S().debited_paise : 0),
    remainingAmount: inr(main ? remainingPaise() : m.amount), perTransactionLimit: inr(s.per_txn_cap_paise),
    validTill: ymd(addDays(new Date(), 60)), fetchedAt: nowIso(),
  });
});

app.post('/mpp/v1/payments', pinelabsAuth, async (req, res) => {
  if (await injectFault('pinelabs_create_mandate_payment', res, 'pinelabs')) return;
  const b = req.body || {}; const st = S(); const s = st.scenario;
  const amt = b.amount && Number(b.amount.value);
  if (!b.authorizationId || !amt || !b.merchantOrderReference || !b.merchant) return res.status(400).json({ code: 'INVALID_REQUEST', message: 'authorizationId, amount.value (paise), merchantOrderReference and merchant are required' });
  if (b.authorizationId !== AUTH_ID) return res.status(404).json({ code: 'MANDATE_NOT_FOUND', message: 'No mandate found for this authorizationId' });
  if (s.mandate_status !== 'ACTIVE') return res.status(409).json({ code: 'MANDATE_NOT_ACTIVE', message: `Mandate status is ${s.mandate_status}` });
  const existing = Object.values(st.orders).find((o) => o.merchant_order_reference === b.merchantOrderReference);
  if (existing) return res.json({ decision: 'PROCEED', duplicate: true, message: 'Order already exists for this merchantOrderReference; no new debit made', orderId: existing.order_id, status: existing.status, amount: inr(existing.amount) });
  if (!b.p3pCredential) {
    const challengeId = rid('chl_');
    st.challenges[challengeId] = { amount: amt, ref: b.merchantOrderReference, expires: Date.now() + 5 * 60 * 1000 };
    return res.status(402).json({ code: 'PAYMENT_REQUIRED', message: 'Payment authorisation required. Resend the same request with p3pCredential set to challenge.challengeId within 5 minutes.', challenge: { challengeId, amount: inr(amt), merchant: b.merchant, expiresAt: new Date(st.challenges[challengeId].expires).toISOString() } });
  }
  const ch = st.challenges[b.p3pCredential];
  if (!ch || ch.expires < Date.now() || ch.amount !== amt || ch.ref !== b.merchantOrderReference) return res.status(401).json({ code: 'INVALID_CREDENTIAL', message: 'p3pCredential is invalid, expired, or does not match this amount/order' });
  delete st.challenges[b.p3pCredential];
  if (amt > s.per_txn_cap_paise) return res.status(403).json({ decision: 'DECLINE', reason: 'AMOUNT_EXCEEDS_SCOPE', message: 'Amount exceeds the per-transaction limit of this mandate', perTransactionLimit: inr(s.per_txn_cap_paise) });
  if (b.purpose && !PURPOSE_SCOPE.includes(b.purpose)) return res.status(403).json({ decision: 'DECLINE', reason: 'PURPOSE_OUT_OF_SCOPE', message: `Purpose '${b.purpose}' is outside this mandate's pet-care scope`, allowedPurposes: PURPOSE_SCOPE, imagined_capability: true });
  if (amt > remainingPaise()) return res.status(422).json({ decision: 'DECLINE', reason: 'INSUFFICIENT_MANDATE_BALANCE', message: 'Mandate balance is lower than the requested amount', remainingAmount: inr(remainingPaise()) });
  const order_id = rid('v1-'); const status = s.payment_outcome;
  if (status !== 'FAILED') st.debited_paise += amt;
  st.orders[order_id] = { order_id, merchant_order_reference: b.merchantOrderReference, amount: amt, status, purpose: b.purpose || null, pending_left: status === 'PENDING' ? s.pending_polls : 0, created_at: nowIso() };
  res.json({
    decision: 'PROCEED', orderId: order_id, status, amount: inr(amt),
    paymentReceipt: status === 'FAILED' ? null : { receiptId: rid('rcpt_'), issuedAt: nowIso(), signature: crypto.createHash('sha256').update(order_id).digest('hex').slice(0, 32) },
    ...(status === 'FAILED' ? { failureReason: 'Debit declined by remitter bank' } : {}),
  });
});

app.get('/api/pay/v1/orders/:order_id', pinelabsAuth, async (req, res) => {
  if (await injectFault('pinelabs_get_mandate_payment_status', res, 'pinelabs')) return;
  const o = S().orders[req.params.order_id];
  if (!o) return res.status(404).json({ code: 'ORDER_NOT_FOUND', message: 'Order not found' });
  if (o.status === 'PENDING') { if (o.pending_left > 0) o.pending_left--; else o.status = 'PROCESSED'; }
  res.json({ data: { order_id: o.order_id, merchant_order_reference: o.merchant_order_reference, status: o.status, amount: inr(o.amount), purpose: o.purpose, created_at: o.created_at, updated_at: nowIso() } });
});

// IMAGINED #1 — one purpose-scoped pet-care budget across all merchants
app.get('/mpp/v1/budget/summary', pinelabsAuth, async (req, res) => {
  if (await injectFault('pinelabs_get_pet_budget_summary', res, 'pinelabs')) return;
  if (req.query.authorizationId !== AUTH_ID) return res.status(404).json({ code: 'MANDATE_NOT_FOUND', message: 'No mandate found for this authorizationId' });
  const s = S().scenario;
  const byCategory = { GROOMING: s.budget_spent_before_paise, PET_FOOD: 0, PET_MEDICINE: 0, VET_CONSULT: 0 };
  for (const o of Object.values(S().orders)) if (o.status !== 'FAILED' && o.purpose && byCategory[o.purpose] !== undefined) byCategory[o.purpose] += o.amount;
  const spent = Object.values(byCategory).reduce((a, b) => a + b, 0);
  res.json({
    imagined_capability: true, authorizationId: AUTH_ID, month: new Date().toISOString().slice(0, 7), purposeScope: PURPOSE_SCOPE,
    allowedMerchants: Object.keys(SELLERS).concat(['VET_LKO_KIDNEY_CLINIC']), monthlyLimit: inr(s.monthly_budget_paise), spent: inr(spent),
    remaining: inr(Math.max(0, s.monthly_budget_paise - spent)), byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, inr(v)])),
  });
});

// ===========================================================================
// GNANI (REAL API via relay — only moves the audio file; Gnani's response is returned unchanged)
// ===========================================================================
app.post('/gnani/stt', relayAuth, async (req, res) => {
  if (await injectFault('gnani_stt', res, 'gnani')) return;
  if (!GNANI_API_KEY) return res.status(500).json({ relay_error: 'GNANI_API_KEY is not set on the server' });
  const b = req.body || {};
  try {
    let buf; let mime = 'audio/ogg'; let name = 'voice.ogg';
    if (b.audio_base64) buf = Buffer.from(b.audio_base64, 'base64');
    else if (b.audio_url) {
      const r = await fetch(b.audio_url, { headers: b.audio_auth_header ? { Authorization: b.audio_auth_header } : {} });
      if (!r.ok) return res.status(502).json({ relay_error: `could not download audio (${r.status})` });
      mime = (r.headers.get('content-type') || mime).split(';')[0];
      buf = Buffer.from(await r.arrayBuffer());
      name = `voice.${({ 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac' })[mime] || 'ogg'}`;
    } else return res.status(400).json({ relay_error: 'audio_url or audio_base64 is required' });
    const fd = new FormData();
    fd.append('audio_file', new Blob([buf], { type: mime }), name);
    fd.append('language_code', b.language_code || 'en-IN');
    fd.append('format', b.format || 'transcribe');
    const g = await fetch('https://api.vachana.ai/stt/v3', { method: 'POST', headers: { 'X-API-Key-ID': GNANI_API_KEY }, body: fd });
    const t = await g.text(); let gnani_response; try { gnani_response = JSON.parse(t); } catch { gnani_response = t; }
    res.status(g.ok ? 200 : g.status).json({ gnani_endpoint: 'POST https://api.vachana.ai/stt/v3', gnani_http_status: g.status, gnani_response });
  } catch (e) { res.status(502).json({ relay_error: String(e.message || e) }); }
});

app.post('/gnani/tts', relayAuth, async (req, res) => {
  if (await injectFault('gnani_tts', res, 'gnani')) return;
  if (!GNANI_API_KEY) return res.status(500).json({ relay_error: 'GNANI_API_KEY is not set on the server' });
  const b = req.body || {};
  if (!b.text) return res.status(400).json({ relay_error: 'text is required' });
  const body = { text: b.text, voice: b.voice || 'Poorvi', model: 'timbre-v2.5', language: b.language || 'hi-en', speed: b.speed || 1.0, audio_config: { sample_rate: 48000, num_channels: 1, sample_width: 2, encoding: 'oggopus', container: 'ogg' } };
  try {
    const g = await fetch('https://api.vachana.ai/api/v1/tts/inference', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key-ID': GNANI_API_KEY }, body: JSON.stringify(body) });
    if (!g.ok) { const t = await g.text(); let gnani_response; try { gnani_response = JSON.parse(t); } catch { gnani_response = t; } return res.status(g.status).json({ gnani_endpoint: 'POST https://api.vachana.ai/api/v1/tts/inference', gnani_http_status: g.status, gnani_response }); }
    const buf = Buffer.from(await g.arrayBuffer());
    const id = rid('aud_'); const type = g.headers.get('content-type') || 'audio/ogg';
    await store.set(`audio:${id}`, JSON.stringify({ type, b64: buf.toString('base64') }), 86400);
    res.json({ gnani_endpoint: 'POST https://api.vachana.ai/api/v1/tts/inference', gnani_http_status: g.status, content_type: type, bytes: buf.length, audio_url: `${PUBLIC_BASE_URL}/audio/${id}.ogg` });
  } catch (e) { res.status(502).json({ relay_error: String(e.message || e) }); }
});

app.get('/audio/:id.ogg', async (req, res) => {
  res.locals.readOnly = true;
  const raw = await store.get(`audio:${req.params.id}`);
  if (!raw) return res.status(404).send('not found');
  const a = JSON.parse(raw);
  res.type(a.type).send(Buffer.from(a.b64, 'base64'));
});

// ===========================================================================
// BEHIND THE CURTAIN
// ===========================================================================
app.get('/mock/scenario', controlAuth, (req, res) => { res.locals.readOnly = true; res.json(S().scenario); });
app.post('/mock/scenario', controlAuth, (req, res) => {
  const allowed = Object.keys(defaultScenario());
  for (const [k, v] of Object.entries(req.body || {})) if (allowed.includes(k)) S().scenario[k] = v;
  res.json({ ok: true, scenario: S().scenario });
});
app.post('/mock/reset', controlAuth, async (req, res) => {
  const f = freshState(); Object.keys(S()).forEach((k) => delete S()[k]); Object.assign(S(), f);
  if (req.query.clear_log === 'true') await store.del('log');
  res.json({ ok: true, scenario: S().scenario });
});
app.get('/mock/state', controlAuth, (req, res) => { res.locals.readOnly = true; res.json(S()); });
app.get('/mock/log', controlAuth, async (req, res) => { res.locals.readOnly = true; res.json((await store.range('log')).map((x) => JSON.parse(x))); });
app.get('/mock/console', controlAuth, (req, res) => {
  res.locals.readOnly = true;
  res.send(`<!doctype html><html><head><title>PetPal rails console</title><style>
body{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:#0f1419;color:#d6dde6;margin:0;padding:14px}h1{font:600 15px system-ui;margin:0 0 10px}
.row{border-bottom:1px solid #263040;padding:8px 0}.m{color:#7cc4ff;font-weight:700}.mcp{color:#c792ea;font-weight:700}.p{color:#fff}.ok{color:#5fd38d}.bad{color:#ff7a7a}
.inj{background:#5a3b00;color:#ffcf66;padding:1px 6px;border-radius:4px;margin-left:6px}pre{white-space:pre-wrap;word-break:break-all;margin:4px 0 0;color:#aab6c4;max-height:180px;overflow:auto}.t{color:#6b7787}</style></head><body>
<h1>PetPal · Gnani / Pine Labs / Delhivery calls (live)</h1><div id="l"></div><script>
const k=new URLSearchParams(location.search).get('key');const esc=s=>String(s).replace(/</g,'&lt;');
async function r(){const d=await (await fetch('/mock/log?key='+k)).json();
document.getElementById('l').innerHTML=d.slice().reverse().map(e=>'<div class="row"><span class="t">'+e.at.slice(11,19)+'</span> <span class="'+(e.method==='MCP'?'mcp':'m')+'">'+e.method+'</span> <span class="p">'+esc(e.method==='MCP'&&e.request?e.path+' · '+e.request.tool:e.path)+'</span> <span class="'+(e.status<400?'ok':'bad')+'">'+e.status+'</span> <span class="t">'+e.ms+'ms</span>'+(e.injected?'<span class="inj">'+e.injected+'</span>':'')+(e.request?'<pre>→ '+esc(JSON.stringify(e.request))+'</pre>':'')+'<pre>← '+esc(e.response)+'</pre></div>').join('')}
r();setInterval(r,2000)</script></body></html>`);
});

app.get('/', (req, res) => {
  res.locals.readOnly = true;
  res.json({
    service: 'PetPal rails server (Round 3)', storage: store.useRedis ? 'upstash-redis' : 'memory', gnani_key_configured: Boolean(GNANI_API_KEY),
    mcp_connectors: ['/mcp/gnani', '/mcp/delhivery', '/mcp/pinelabs'],
  });
});

require('./mcp')(app, { PUBLIC_BASE_URL, MOCK_TOKEN });

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ code: 'INVALID_JSON', message: 'Request body is not valid JSON' });
  res.status(500).json({ code: 'INTERNAL_ERROR', message: String((err && err.message) || err) });
});

module.exports = app;
