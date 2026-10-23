# M-Pesa STK Push — Payment App

A minimal, payment-only app: a customer enters their phone number and an amount,
clicks **Pay now**, and gets an M-Pesa STK push prompt on their phone to enter
their PIN. Once they pay, the page automatically shows a success message with
the M-Pesa receipt number.

```
mpesa-stk-push/
├── backend/          Express server, Daraja API integration
│   ├── server.js
│   ├── mpesaService.js
│   ├── package.json
│   └── .env.example
└── frontend/
    └── index.html    The payment page (no build step needed)
```

## 1. How it works

1. Customer fills in phone + amount on `frontend/index.html` and clicks **Pay now**.
2. The frontend calls your backend's `/api/mpesa/stk-push` endpoint.
3. The backend authenticates with Safaricom's Daraja API and triggers an STK push.
4. The customer's phone receives a prompt to enter their M-Pesa PIN.
5. Once they respond (success, cancel, or timeout), Safaricom calls your backend's
   `/api/mpesa/callback` URL with the result.
6. The frontend polls `/api/mpesa/status/:checkoutRequestId` every few seconds and
   shows the final result.

**The callback URL in step 5 must be a public HTTPS URL.** Safaricom's servers
cannot reach `localhost`. This is the part that trips people up — see step 3 below.

## 2. Get your Daraja credentials

You said you already have sandbox credentials. If you need to look them up again:

1. Go to https://developer.safaricom.co.ke/ and log in.
2. Open your app under **My Apps** — you'll see the **Consumer Key** and
   **Consumer Secret**.
3. Go to **APIs → Lipa Na M-Pesa Online** and copy the test credentials:
   **Shortcode** (usually `174379` for sandbox) and **Passkey**.

## 3. Configure the backend

```bash
cd backend
npm install
cp .env.example .env
```

Edit `.env` and fill in:

```
MPESA_CONSUMER_KEY=...
MPESA_CONSUMER_SECRET=...
MPESA_SHORTCODE=174379
MPESA_PASSKEY=...
MPESA_CALLBACK_URL=https://YOUR-PUBLIC-URL/api/mpesa/callback
```

### Getting a public callback URL for local testing

While developing on your own machine, use [ngrok](https://ngrok.com) (free) to
expose your local server publicly:

```bash
# In one terminal: start your backend
npm start

# In another terminal: expose port 3000
ngrok http 3000
```

ngrok will print a URL like `https://abcd1234.ngrok-free.app`. Put that in your
`.env` as:

```
MPESA_CALLBACK_URL=https://abcd1234.ngrok-free.app/api/mpesa/callback
```

Restart the backend after changing `.env` (it only reads it on startup). Note
that ngrok's free URL changes every time you restart it, so you'll need to
update `.env` again each session — fine for testing, but for a real launch
you'll want a real deployment (see below).

### Deploy the backend to Render

1. Push this repository to GitHub and in Render choose **New → Web Service**.
2. Connect the repository and set **Root Directory** to `backend`,
   **Build Command** to `npm install`, and **Start Command** to `npm start`.
   Render supplies the `PORT` environment variable; do not hard-code a port in
   the Render dashboard.
3. In the service's **Environment** settings, add the Daraja variables from
   `backend/.env.example`. Start with `MPESA_ENV=sandbox` and sandbox
   credentials. Do not upload or commit your local `.env` file.
4. Deploy the service. In its Render page, copy the public `onrender.com` URL.
   Set `MPESA_CALLBACK_URL` to that URL followed by
   `/api/mpesa/callback` (for example,
   `https://your-service.onrender.com/api/mpesa/callback`) and save the
   environment variable. Render will redeploy the service.
5. Check that `https://your-service.onrender.com/api/health` returns
   `{"status":"ok"}`.
6. Update `API_BASE_URL` in `frontend/index.html` to the Render service's
   `https://` URL, then redeploy the frontend. If your frontend uses a different
   domain from the one already allowed in `backend/server.js`, add that exact
   origin to the backend CORS allowlist and redeploy.

Use production Daraja credentials and `MPESA_ENV=production` only after
Safaricom approves the app for Go Live. Never put consumer secrets or passkeys
in frontend code or in a public repository.

The backend currently keeps transaction records in memory, so a restart or
instance replacement loses those records. Replace that store with a persistent
database before relying on this service for production payments. Render's free
web services can also spin down when idle; choose an always-on instance if
payment callback responsiveness is important.

## 4. Run it locally

Terminal 1 — backend:
```bash
cd backend
npm start
```
You should see: `M-Pesa STK Push backend running on http://localhost:3000`

Terminal 2 — frontend (any static file server works):
```bash
cd frontend
python3 -m http.server 8080
```
Then open http://localhost:8080 in your browser.

**Note:** the STK push *request* itself will work even without ngrok, since
that's your backend calling Safaricom. But you won't get the final success/
failure confirmation until the callback URL is publicly reachable, since
that's Safaricom calling *you*. Until then, the frontend will show "still
awaiting" indefinitely after you approve the prompt on your phone.

## 5. Testing in sandbox

Safaricom's sandbox doesn't send real STK prompts to arbitrary numbers — it
only works with their designated test number. Use phone number `254708374149`
(or whatever test MSISDN your sandbox account specifies) and any amount. You
can simulate the customer's PIN entry directly from the Daraja portal's
**Simulate** tool if no physical prompt arrives.

## 6. Going to production

- Apply for "Go Live" on the Daraja portal to get production credentials and a
  real paybill/till shortcode.
- Switch `MPESA_ENV=production` in your `.env`.
- Replace the in-memory `transactions` Map in `server.js` with a real database
  — right now, transaction records are lost if the server restarts.
- Add HTTPS, request logging, and basic rate limiting on the public endpoints
  before handling real money.
- Consider verifying the callback's authenticity (Safaricom doesn't sign
  callbacks by default, so many integrators allowlist Safaricom's IP ranges
  at the network/firewall level).

## Troubleshooting

**"STK Push request failed"** — check your Consumer Key/Secret and that
`MPESA_CALLBACK_URL` isn't still the placeholder value.

**Prompt never arrives on phone** — confirm you're using a sandbox-registered
test number, not your own.

**Frontend says "still awaiting" forever** — your callback URL isn't publicly
reachable. Confirm ngrok (or your deployment) is running and the URL in `.env`
matches exactly, including `https://` and the `/api/mpesa/callback` path.
