import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { initiateSTKPush } from "./mpesaService.js";
import {
  closeTransactionStore,
  connectTransactionStore,
  createPendingTransaction,
  deleteTransaction,
  getRecentTransactions,
  getTransaction,
  saveTransaction,
} from "./transactionStore.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

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
    const result = await initiateSTKPush({
      phone,
      amount,
      accountReference,
      description,
    });

    if (result.ResponseCode === "0") {
      const transaction = {
        status: "PENDING",
        phone,
        amount,
        merchantRequestId: result.MerchantRequestID,
        checkoutRequestId: result.CheckoutRequestID,
        createdAt: new Date().toISOString(),
      };

      try {
        await createPendingTransaction(result.CheckoutRequestID, transaction);
      } catch (error) {
        console.error("Unable to persist accepted STK push:", error.message);
      }

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
    console.error("STK push error:", error.message);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/**
 * POST /api/mpesa/callback
 * This is the URL Safaricom calls once the customer completes (or cancels)
 * the payment prompt on their phone. Must be a public HTTPS URL.
 */
app.post("/api/mpesa/callback", async (req, res) => {
  const callback = req.body?.Body?.stkCallback;

  if (!callback) {
    console.warn("Unexpected callback payload shape");
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = callback;
  const isSuccess = String(ResultCode) === "0";
  console.info("M-Pesa callback received:", {
    checkoutRequestId: CheckoutRequestID,
    resultCode: ResultCode,
    status: isSuccess ? "SUCCESS" : "FAILED",
  });

  try {
    const existing = await getTransaction(CheckoutRequestID) || {};

    if (isSuccess) {
      const items = CallbackMetadata?.Item || [];
      const get = (name) => items.find((i) => i.Name === name)?.Value;

      await saveTransaction(CheckoutRequestID, {
        ...existing,
        status: "SUCCESS",
        mpesaReceiptNumber: get("MpesaReceiptNumber"),
        amount: get("Amount") ?? existing.amount,
        phone: get("PhoneNumber") ?? existing.phone,
        transactionDate: get("TransactionDate"),
        resultDesc: ResultDesc,
        completedAt: new Date().toISOString(),
      });
    } else {
      await saveTransaction(CheckoutRequestID, {
        ...existing,
        status: "FAILED",
        resultDesc: ResultDesc,
        completedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    console.error("Unable to persist M-Pesa callback:", error.message);
    return res.status(500).json({ ResultCode: 1, ResultDesc: "Callback persistence failed" });
  }

  // Always acknowledge receipt to Safaricom, or it will retry the callback.
  return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

/**
 * GET /api/mpesa/status/:checkoutRequestId
 * The frontend polls this endpoint for the result saved by the Daraja callback.
 */
app.get("/api/mpesa/status/:checkoutRequestId", async (req, res) => {
  const { checkoutRequestId } = req.params;
  try {
    const record = await getTransaction(checkoutRequestId);

    return res.json({
      success: true,
      ...(record || {
        status: "PENDING",
        checkoutRequestId,
        message: "Waiting for M-Pesa payment confirmation.",
      }),
    });
  } catch (error) {
    console.error("Unable to read payment status:", error.message);
    return res.status(503).json({
      success: false,
      message: "Payment status is temporarily unavailable. Please keep this page open.",
    });
  }
});

/**
 * GET /api/mpesa/history
 * Returns recent transactions for display in history/queue
 */
app.get("/api/mpesa/history", async (req, res) => {
  try {
    const history = await getRecentTransactions();
    return res.json({ success: true, transactions: history });
  } catch (error) {
    console.error("Unable to read transaction history:", error.message);
    return res.status(503).json({
      success: false,
      message: "Transaction history is temporarily unavailable.",
    });
  }
});

/**
 * POST /api/mpesa/resend/:checkoutRequestId
 * Resends the STK push for a pending transaction
 */
app.post("/api/mpesa/resend/:checkoutRequestId", async (req, res) => {
  const { checkoutRequestId } = req.params;
  let record;
  try {
    record = await getTransaction(checkoutRequestId);
  } catch (error) {
    console.error("Unable to read transaction for resend:", error.message);
    return res.status(503).json({
      success: false,
      message: "Transaction data is temporarily unavailable.",
    });
  }

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
      const newTransaction = {
        status: "PENDING",
        phone: record.phone,
        amount: record.amount,
        merchantRequestId: result.MerchantRequestID,
        checkoutRequestId: result.CheckoutRequestID,
        createdAt: new Date().toISOString(),
        retriedAt: new Date().toISOString(),
      };
      await createPendingTransaction(result.CheckoutRequestID, newTransaction);
      await deleteTransaction(checkoutRequestId);

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

const PORT = process.env.PORT || 3001;

async function startServer() {
  await connectTransactionStore();

  const server = app.listen(PORT, () => {
    console.log(`M-Pesa STK Push backend running on http://localhost:${PORT}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close(async () => {
        await closeTransactionStore();
        process.exit(0);
      });
    });
  }
}

startServer().catch((error) => {
  console.error("Backend startup failed:", error.message);
  process.exitCode = 1;
});
