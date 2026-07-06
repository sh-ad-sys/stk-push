import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import {
  initiateSTKPush,
  querySTKStatus,
} from "./mpesaService.js";

dotenv.config();

const app = express();
app.use(cors({
  origin: 'https://stk-push-zeta.vercel.app',
  credentials: true
}));
app.use(express.json());

// In-memory store of transactions, keyed by CheckoutRequestID.
// This is fine for a small payment-only app / demo. For production,
// replace with a real database (Postgres, MongoDB, etc).
const transactions = new Map();

function getQueryStatus(result) {
  const resultCode = String(result.ResultCode ?? "");
  const resultDesc = String(result.ResultDesc || result.errorMessage || "").toLowerCase();

  if (resultCode === "0") {
    return "SUCCESS";
  }

  if (
    result.ResultCode === undefined ||
    resultDesc.includes("under processing") ||
    resultDesc.includes("being processed") ||
    resultDesc.includes("request is being processed")
  ) {
    return "PENDING";
  }

  return "FAILED";
}

/**
 * POST /api/mpesa/stk-push
 * Body: { phone, amount, accountReference?, description? }
 * Triggers the STK push prompt on the customer's phone.
 */
app.post("/api/mpesa/stk-push", async (req, res) => {
  const { phone, amount, accountReference, description } = req.body;

  if (!phone || !amount) {
    return res.status(400).json({
      success: false,
      message: "phone and amount are required",
    });
  }

  try {
    console.log("STK push request received", { phone, amount, accountReference, description });
    const result = await initiateSTKPush({
      phone,
      amount,
      accountReference,
      description,
    });

    console.log("STK push response", result);

    if (result.ResponseCode === "0") {
      transactions.set(result.CheckoutRequestID, {
        status: "PENDING",
        phone,
        amount,
        merchantRequestId: result.MerchantRequestID,
        checkoutRequestId: result.CheckoutRequestID,
        createdAt: new Date().toISOString(),
      });

      return res.json({
        success: true,
        message: "STK push sent. Check your phone to complete payment.",
        checkoutRequestId: result.CheckoutRequestID,
        merchantRequestId: result.MerchantRequestID,
      });
    }

    return res.status(400).json({
      success: false,
      message: result.ResponseDescription || "Failed to initiate STK push",
      raw: result,
    });
  } catch (error) {
    const status = error?.response?.status;
    const responseData = error?.response?.data;
    const detail = responseData?.errorMessage || responseData?.ResponseDescription || responseData?.requestId || error.message;

    console.error("STK push error:", {
      status,
      detail,
      responseData,
      requestBody: { phone, amount, accountReference, description },
    });

    return res.status(status ? 502 : 500).json({
      success: false,
      message: detail || error.message,
      raw: responseData || null,
    });
  }
});

/**
 * POST /api/mpesa/callback
 * This is the URL Safaricom calls once the customer completes (or cancels)
 * the payment prompt on their phone. Must be a public HTTPS URL.
 */
app.post("/api/mpesa/callback", (req, res) => {
  console.log("M-Pesa callback received:", JSON.stringify(req.body, null, 2));

  const callback = req.body?.Body?.stkCallback;

  if (!callback) {
    console.warn("Unexpected callback payload shape");
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = callback;

  const existing = transactions.get(CheckoutRequestID) || {};

  if (ResultCode === 0) {
    // Payment successful — extract details from CallbackMetadata
    const items = CallbackMetadata?.Item || [];
    const get = (name) => items.find((i) => i.Name === name)?.Value;

    transactions.set(CheckoutRequestID, {
      ...existing,
      status: "SUCCESS",
      mpesaReceiptNumber: get("MpesaReceiptNumber"),
      amount: get("Amount"),
      phone: get("PhoneNumber"),
      transactionDate: get("TransactionDate"),
      resultDesc: ResultDesc,
      completedAt: new Date().toISOString(),
    });
    console.log(`Transaction ${CheckoutRequestID} marked SUCCESS`, transactions.get(CheckoutRequestID));
  } else {
    // Payment failed or was cancelled by the user
    transactions.set(CheckoutRequestID, {
      ...existing,
      status: "FAILED",
      resultDesc: ResultDesc,
      completedAt: new Date().toISOString(),
    });
    console.log(`Transaction ${CheckoutRequestID} marked FAILED`, transactions.get(CheckoutRequestID));
  }

  // Always acknowledge receipt to Safaricom, or it will retry the callback.
  return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

/**
 * GET /api/mpesa/status/:checkoutRequestId
 * The frontend polls this to find out whether payment succeeded.
 * Falls back to actively querying Safaricom if no callback has landed yet.
 */
app.get("/api/mpesa/status/:checkoutRequestId", async (req, res) => {
  const { checkoutRequestId } = req.params;
  const record = transactions.get(checkoutRequestId);

  console.log(`Status check for ${checkoutRequestId}:`, record ? record.status : "not found");

  if (record && record.status !== "PENDING") {
    return res.json({ success: true, status: record.status, ...record });
  }

  // No callback yet — actively ask Safaricom for the current status.
  try {
    const result = await querySTKStatus(checkoutRequestId);
    const status = getQueryStatus(result);

    return res.json({
      success: true,
      status,
      resultDesc: result.ResultDesc,
      raw: result,
    });
  } catch (error) {
    const statusCode = error?.response?.status;
    const responseData = error?.response?.data;
    const detail = responseData?.errorMessage || responseData?.ResponseDescription || error?.message || "Unable to query M-Pesa status";

    console.error("STK status query failed:", {
      checkoutRequestId,
      statusCode,
      detail,
      responseData,
    });

    return res.json({
      success: false,
      status: "PENDING",
      message: `Unable to verify status with M-Pesa (${statusCode || "network error"}). Still waiting for callback.`,
      detail,
      raw: responseData || null,
    });
  }
});

/**
 * GET /api/mpesa/history
 * Returns recent transactions for display in history/queue
 */
app.get("/api/mpesa/history", (req, res) => {
  const history = Array.from(transactions.values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 10);
  
  res.json({
    success: true,
    transactions: history,
  });
});

/**
 * POST /api/mpesa/resend/:checkoutRequestId
 * Resends the STK push for a pending transaction
 */
app.post("/api/mpesa/resend/:checkoutRequestId", async (req, res) => {
  const { checkoutRequestId } = req.params;
  const record = transactions.get(checkoutRequestId);

  if (!record) {
    return res.status(404).json({
      success: false,
      message: "Transaction not found",
    });
  }

  try {
    const result = await initiateSTKPush({
      phone: record.phone,
      amount: record.amount,
      accountReference: "Payment",
    });

    if (result.ResponseCode === "0") {
      // Update with new request IDs
      transactions.delete(checkoutRequestId);
      transactions.set(result.CheckoutRequestID, {
        status: "PENDING",
        phone: record.phone,
        amount: record.amount,
        merchantRequestId: result.MerchantRequestID,
        checkoutRequestId: result.CheckoutRequestID,
        createdAt: new Date().toISOString(),
        retriedAt: new Date().toISOString(),
      });

      return res.json({
        success: true,
        message: "STK push resent to your phone",
        checkoutRequestId: result.CheckoutRequestID,
      });
    }

    return res.status(400).json({
      success: false,
      message: "Failed to resend STK push",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`M-Pesa STK Push backend running on http://localhost:${PORT}`);
});
