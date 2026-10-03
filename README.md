# PetPal rails server — Vercel

One deployment, three MCP connectors for AgenticOrg:

| Register as (MCP ✓) | URL | What it is |
|---|---|---|
| `gnani_petpal` | `https://YOUR-APP.vercel.app/mcp/gnani` | **Real** Gnani STT + TTS (only needed if Gnani isn't a built-in Provider) |
| `delhivery_petpal_mock` | `https://YOUR-APP.vercel.app/mcp/delhivery` | Delhivery mock + imagined #2, #3 |
| `pinelabs_mandate_petpal` | `https://YOUR-APP.vercel.app/mcp/pinelabs` | Pine Labs mandate mock + imagined #1 |

Payment links, order status and refunds use the platform's built-in **Pine Labs (Plural)** connector, so they are not mocked here.

## Capabilities

**Delhivery (mock, endpoint names and fields as in Delhivery's B2C docs)**

| Tool | Endpoint |
|---|---|
| delhivery_pincode_serviceability | GET /c/api/pin-codes/json/ |
| delhivery_expected_tat | GET /api/dc/expected_tat |
| delhivery_shipping_cost | GET /api/kinko/v1/invoice/charges/.json |
| delhivery_fetch_waybills | GET /waybill/api/bulk/json/ |
| delhivery_create_warehouse / edit_warehouse | POST /api/backend/clientwarehouse/create/ , /edit/ |
| delhivery_create_shipment (forward, or reverse with payment_mode "Pickup") | POST /api/cmu/create.json |
| delhivery_edit_or_cancel_shipment | POST /api/p/edit |
| delhivery_pickup_request | POST /fm/request/new/ |
| delhivery_packing_slip | GET /api/p/packing_slip |
| delhivery_track_shipment | GET /api/v1/packages/json/ |
| delhivery_ndr_action / ndr_status | POST /api/p/update , GET /api/cmu/get_bulk_upl/{id} |

**Pine Labs (mock, only what the built-in connector lacks)**

| Tool | Endpoint |
|---|---|
| pinelabs_create_mandate / get_mandate / revoke_mandate | POST /mpp/v1/mandates , GET /mpp/v1/mandates/{id} , POST …/revoke |
| pinelabs_get_mandate_balance | GET /mpp/v1/balance |
| pinelabs_create_mandate_payment (402 challenge, then pay) | POST /mpp/v1/payments |
| pinelabs_get_mandate_payment_status | GET /api/pay/v1/orders/{order_id} |

**Gnani (real API)**: `gnani_speech_to_text` → POST https://api.vachana.ai/stt/v3 , `gnani_text_to_speech` → POST https://api.vachana.ai/api/v1/tts/inference. The server only moves the audio file; Gnani's response comes back unchanged in `gnani_response`.

**Imagined capabilities (3), flagged `imagined_capability: true`**

| # | Partner | Endpoint | Data the partner already holds |
|---|---|---|---|
| 1 | Pine Labs | GET /mpp/v1/budget/summary, plus a `purpose` scope on /mpp/v1/payments | Every mandate debit and each merchant's category code: enough to sum one pet budget across stores, vets and groomers, and to refuse spends outside pet care |
| 2 | Delhivery | POST /api/cmu/create_on_behalf.json | Every seller's client account and registered warehouses: enough to let a seller grant an agent consent to ship from its warehouse |
| 3 | Delhivery | POST /api/direct/v1/orders , GET /api/direct/v1/orders/{id} | Delhivery Direct's live rider fleet and city coverage (today usable only in the consumer app) |

## Deploy (about 15 minutes)

1. Push this folder to a GitHub repo.
2. vercel.com → **Add New → Project** → import the repo → **Deploy** (no settings needed).
3. In the project, **Storage → Create / Connect → Upstash for Redis** (free) → connect it to the project. This adds the Redis env vars automatically.
4. **Settings → Environment Variables**, add:
   - `GNANI_API_KEY` = your key from app.gnani.ai/voice
   - `PUBLIC_BASE_URL` = your production URL, e.g. `https://petpal-rails.vercel.app` (no trailing slash)
   - `MOCK_TOKEN` = `petpal-demo-token`
   - `CONTROL_KEY` = `curtain`
5. **Deployments → ⋯ → Redeploy** so the variables take effect.
6. Open `https://YOUR-APP.vercel.app/` and check: `"storage":"upstash-redis"` and `"gnani_key_configured":true`.

Always use the **production** URL (`*.vercel.app` without a hash). Preview URLs sit behind Vercel login and the platform can't reach them.

## Test Gnani first

```bash
curl -X POST https://YOUR-APP.vercel.app/gnani/tts -H "Authorization: Bearer petpal-demo-token" \
  -H "Content-Type: application/json" -d '{"text":"Buddy ka khana chaar din mein khatam ho jayega."}'
```
Open the returned `audio_url`. Then transcribe it back:
```bash
curl -X POST https://YOUR-APP.vercel.app/gnani/stt -H "Authorization: Bearer petpal-demo-token" \
  -H "Content-Type: application/json" -d '{"audio_url":"<audio_url>","language_code":"en-IN"}'
```

## Behind the curtain (switch scenarios between eval runs)

Live call log, to keep open while recording: `https://YOUR-APP.vercel.app/mock/console?key=curtain`

```bash
curl -X POST "https://YOUR-APP.vercel.app/mock/reset?key=curtain&clear_log=true"
curl -X POST "https://YOUR-APP.vercel.app/mock/scenario?key=curtain" -H "Content-Type: application/json" -d '{"delivery":"ndr"}'
curl "https://YOUR-APP.vercel.app/mock/state?key=curtain"
```

| Situation | Set before the run |
|---|---|
| Happy path | reset |
| Over Rs 3,000 per-payment cap | nothing (agent tries a spend over Rs 3,000) |
| Mandate balance too low | `{"mandate_blocked_paise":100000}` |
| Payment stuck PENDING | `{"payment_outcome":"PENDING","pending_polls":2}` |
| Debit FAILED | `{"payment_outcome":"FAILED"}` |
| Mandate revoked | `{"mandate_status":"REVOKED"}` |
| Address not serviceable | owner asks for delivery to 744301 |
| Failed delivery (NDR) | `{"delivery":"ndr"}` |
| Delivery delayed past run-out | `{"delivery":"delayed"}` |
| No rider for rush delivery | `{"direct_riders":"none"}` (and use NCR pincodes, since Lucknow is outside Direct's cities) |
| Timeout | `{"timeout_next":["delhivery_create_shipment_on_behalf"]}` (25 s, then 504) |
| Malformed reply | `{"malformed_next":["delhivery_track_shipment"]}` |
| Service down | `{"error_next":["pinelabs_get_mandate_balance"]}` or `["gnani_stt"]` |

Fault names fire once, on the next call to that operation, so the agent's retry succeeds.

## Day-one data

Mandate `AUTH-BUDDY-RP-001` (ACTIVE, Rs 4,000 blocked, Rs 3,000 per payment) · monthly pet budget Rs 5,000 with Rs 1,200 spent on grooming · seller `HAPPYPAWS_LKO`, warehouse `HAPPYPAWS_GOMTINAGAR`, consent `CONSENT-BUDDY-001` · home pincode 226010 (Lucknow) · all amounts in **paise**.

## Caveats to state honestly in the write-up

- Field names for the Pine Labs `/mpp/v1/*` mandate APIs and for Delhivery's expected-TAT and NDR-status responses follow the docs as we read them in Round 2. Re-check them against the docs and edit `app.js` where they differ.
- Tracking moves one step per poll so the demo fits in five minutes; real shipments take days.
