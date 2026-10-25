import { MongoClient } from "mongodb";

let client;
let transactions;

export async function connectTransactionStore() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    throw new Error("Missing MONGODB_URI (or MONGO_URI) in environment variables");
  }

  const mongoClient = new MongoClient(uri);
  try {
    await mongoClient.connect();

    const database = mongoClient.db(process.env.MONGODB_DATABASE || "stk_push");
    const collection = database.collection("transactions");
    await collection.createIndex({ createdAt: -1 }, { name: "createdAt_desc" });

    client = mongoClient;
    transactions = collection;
  } catch (error) {
    await mongoClient.close();
    throw error;
  }
}

function getCollection() {
  if (!transactions) {
    throw new Error("Transaction store is not connected");
  }
  return transactions;
}

export async function getTransaction(checkoutRequestId) {
  const transaction = await getCollection().findOne({ _id: checkoutRequestId });
  if (!transaction) return undefined;

  const { _id, ...record } = transaction;
  return record;
}

export async function saveTransaction(checkoutRequestId, record) {
  await getCollection().replaceOne(
    { _id: checkoutRequestId },
    { ...record, _id: checkoutRequestId },
    { upsert: true }
  );
}

export async function createPendingTransaction(checkoutRequestId, record) {
  await getCollection().updateOne(
    { _id: checkoutRequestId },
    { $setOnInsert: { ...record, _id: checkoutRequestId } },
    { upsert: true }
  );
}

export async function deleteTransaction(checkoutRequestId) {
  await getCollection().deleteOne({ _id: checkoutRequestId });
}

export async function getRecentTransactions(limit = 10) {
  const records = await getCollection()
    .find({}, { projection: { _id: 0 } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();

  return records;
}

export async function closeTransactionStore() {
  if (client) {
    await client.close();
    client = undefined;
    transactions = undefined;
  }
}
