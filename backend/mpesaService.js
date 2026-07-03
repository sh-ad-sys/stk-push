import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const baseUrl = process.env.MPESA_ENV === "production"
  ? "https://api.safaricom.co.ke"
  : "https://sandbox.safaricom.co.ke";

function normalizePhone(rawPhone) {
  let phone = String(rawPhone ?? "").trim().replace(/\s+/g, "").replace(/^\+/, "");

  if (phone.startsWith("0")) {
    phone = `254${phone.slice(1)}`;
  } else if (/^(7|1)\d{8}$/.test(phone)) {
    phone = `254${phone}`;
  }

  return phone;
}

function getAuthHeader() {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret) {
    throw new Error("Missing MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET in environment");
  }

  const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
  return {
    Authorization: `Basic ${credentials}`
  };
}

async function getAccessToken() {
  const response = await axios.get(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: getAuthHeader(),
    timeout: 30000,
  });

  return response.data.access_token;
}

export async function initiateSTKPush({ phone, amount, accountReference, description }) {
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const callbackUrl = process.env.MPESA_CALLBACK_URL;
  const normalizedPhone = normalizePhone(phone);

  if (!shortcode || !passkey || !callbackUrl) {
    throw new Error("Missing MPESA_SHORTCODE, MPESA_PASSKEY, or MPESA_CALLBACK_URL in environment");
  }

  const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");

  const token = await getAccessToken();
  const response = await axios.post(
    `${baseUrl}/mpesa/stkpush/v1/processrequest`,
    {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Number(amount),
      PartyA: normalizedPhone,
      PartyB: shortcode,
      PhoneNumber: normalizedPhone,
      CallBackURL: callbackUrl,
      AccountReference: accountReference || "STKPush",
      TransactionDesc: description || "STK Push Payment",
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );

  return response.data;
}

export async function querySTKStatus(checkoutRequestId) {
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;

  if (!shortcode || !passkey) {
    throw new Error("Missing MPESA_SHORTCODE or MPESA_PASSKEY in environment");
  }

  const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");

  const token = await getAccessToken();
  const response = await axios.post(
    `${baseUrl}/mpesa/stkpushquery/v1/query`,
    {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );

  return response.data;
}
