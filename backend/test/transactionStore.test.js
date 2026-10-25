import test from "node:test";
import assert from "node:assert/strict";

import { connectTransactionStore } from "../transactionStore.js";

test("transaction store requires a MongoDB connection string", async () => {
  const originalUri = process.env.MONGODB_URI;
  const originalLegacyUri = process.env.MONGO_URI;
  delete process.env.MONGODB_URI;
  delete process.env.MONGO_URI;

  try {
    await assert.rejects(
      connectTransactionStore(),
      /Missing MONGODB_URI \(or MONGO_URI\) in environment variables/
    );
  } finally {
    if (originalUri === undefined) {
      delete process.env.MONGODB_URI;
    } else {
      process.env.MONGODB_URI = originalUri;
    }
    if (originalLegacyUri === undefined) {
      delete process.env.MONGO_URI;
    } else {
      process.env.MONGO_URI = originalLegacyUri;
    }
  }
});
