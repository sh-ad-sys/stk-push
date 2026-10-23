import axios from "axios";

const isProd = process.env.MPESA_ENV === "production";

const BASE_URL = isProd
  ? "https://api.safaricom.co.ke"
  : "https://sandbox.safaricom.co.ke";

function describeDarajaError(operation, error) {
  const status = error.response?.status;
  const responseBody = error.response?.data;
  const responseText = typeof responseBody === "string"
    ? responseBody
    : JSON.stringify(responseBody || {});
  const incidentId = responseText.match(/incident_id=([^&"\\]+)/i)?.[1]
    || responseText.match(/incident ID:\s*([^\s<]+)/i)?.[1];

  if (incidentId) {
    return `M-Pesa ${operation} was blocked by its security gateway${status ? ` (HTTP ${status})` : ""}. Contact Daraja support with incident ID ${incidentId}.`;
  }

  const detail = responseBody?.errorMessage
    || responseBody?.ResponseDescription
    || responseBody?.error
    || error.message;
  return `M-Pesa ${operation} failed${status ? ` (HTTP ${status})` : ""}: ${detail}`;
}

/**
 * Generates the Daraja OAuth access token.
 * Tokens are valid for ~1 hour, but we just fetch a fresh one each time
 * since STK pushes are infrequent for a small payment app.
 */
export async function getAccessToken() {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret) {
    throw new Error(
      "Missing MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET in environment variables"
    );
  }

  const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString(
    "base64"
  );

  try {
    const response = await axios.get(
      `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          Accept: "application/json",
        },
        timeout: 20000,
      }
    );
    if (!response.data?.access_token) {
      throw new Error("M-Pesa OAuth response did not include an access token");
    }
    return response.data.access_token;
  } catch (error) {
    throw new Error(describeDarajaError("OAuth request", error));
  }
}

/**
 * Builds the timestamp string M-Pesa expects: YYYYMMDDHHmmss
 */
function getTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

/**
 * Normalizes a Kenyan phone number to the 2547XXXXXXXX format M-Pesa requires.
 * Accepts formats like 07XXXXXXXX, 7XXXXXXXX, +2547XXXXXXXX, 2547XXXXXXXX
 */
export function normalizePhoneNumber(rawPhone) {
  let phone = String(rawPhone).trim().replace(/\s+/g, "").replace(/^\+/, "");

  if (phone.startsWith("0")) {
    phone = "254" + phone.slice(1);
  } else if (phone.startsWith("7") || phone.startsWith("1")) {
    phone = "254" + phone;
  }

  const isValid = /^254(7|1)\d{8}$/.test(phone);
  if (!isValid) {
    throw new Error(
      "Invalid phone number format. Use a Safaricom number like 07XXXXXXXX or 2547XXXXXXXX"
    );
  }

  return phone;
}

/**
 * Initiates an STK Push (Lipa Na M-Pesa Online) request.
 * This is what triggers the payment prompt on the customer's phone.
 */
export async function initiateSTKPush({ phone, amount, accountReference, description }) {
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const callbackUrl = process.env.MPESA_CALLBACK_URL;

  if (!shortcode || !passkey) {
    throw new Error("Missing MPESA_SHORTCODE or MPESA_PASSKEY in environment variables");
  }
  if (!callbackUrl || callbackUrl.includes("your-public-url")) {
    throw new Error(
      "MPESA_CALLBACK_URL is not configured. Set a public HTTPS URL (e.g. via ngrok) in your .env file."
    );
  }

  const accessToken = await getAccessToken();
  const timestamp = getTimestamp();
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString(
    "base64"
  );

  const normalizedPhone = normalizePhoneNumber(phone);
  const wholeAmount = Math.round(Number(amount));

  if (!wholeAmount || wholeAmount < 1) {
    throw new Error("Amount must be a positive number");
  }

  const payload = {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: wholeAmount,
    PartyA: normalizedPhone,
    PartyB: shortcode,
    PhoneNumber: normalizedPhone,
    CallBackURL: callbackUrl,
    AccountReference: (accountReference || "Payment").slice(0, 12),
    TransactionDesc: (description || "Payment").slice(0, 13),
  };

  try {
    const response = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 20000,
      }
    );
    return response.data;
  } catch (error) {
    throw new Error(describeDarajaError("STK push request", error));
  }
}

/**
 * Queries the status of an STK push transaction.
 * Useful for polling whether the customer completed/cancelled the prompt.
 */
export async function querySTKStatus(checkoutRequestId) {
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;

  const accessToken = await getAccessToken();
  const timestamp = getTimestamp();
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString(
    "base64"
  );

  const payload = {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    CheckoutRequestID: checkoutRequestId,
  };

  try {
    const response = await axios.post(
      `${BASE_URL}/mpesa/stkpushquery/v1/query`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 20000,
      }
    );
    return response.data;
  } catch (error) {
    throw new Error(describeDarajaError("STK status query", error));
  }
}
