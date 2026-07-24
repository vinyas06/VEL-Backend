import admin from "firebase-admin";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FINANCE_TRANSACTION_TYPES as T,
  getLedgerDirection,
  roundMoney,
} from "../finance.js";

const applyChanges = process.argv.includes("--apply");

const initializeFirebase = () => {
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    credential = admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON),
    );
  } else {
    const path = join(process.cwd(), "service-account.json");
    credential = admin.credential.cert(JSON.parse(readFileSync(path, "utf8")));
  }
  admin.initializeApp({ credential });
};

const legacyType = (record = {}) => {
  const category = String(record.category || "").trim().toLowerCase();
  if (category === "driver advance" || category === "trip advance") {
    return T.ADVANCE_GIVEN;
  }
  if (category === "driver salary") return T.SETTLEMENT_PAYMENT;
  if (category === "bonus") return T.BONUS;
  if (category === "incentive") return T.INCENTIVE;
  if (category === "penalty") return T.PENALTY;
  return null;
};

const driverName = (record = {}) =>
  String(
    record.driverName ||
      record.payeeName ||
      record.payee ||
      record.targetName ||
      "",
  ).trim();

initializeFirebase();
const db = admin.firestore();
const [driverSnap, transactionSnap] = await Promise.all([
  db.collection("drivers").get(),
  db.collection("transactions").get(),
]);
const driversByName = new Map(
  driverSnap.docs.map((doc) => [
    String(doc.data().name || "").trim().toLowerCase(),
    { id: doc.id, ...doc.data() },
  ]),
);

const candidates = transactionSnap.docs
  .map((doc) => ({ id: doc.id, ...doc.data() }))
  .map((record) => ({
    record,
    type: legacyType(record),
    driver: driversByName.get(driverName(record).toLowerCase()),
  }))
  .filter((item) => item.type && item.driver)
  .sort((a, b) =>
    String(a.record.createdAt || a.record.date || "").localeCompare(
      String(b.record.createdAt || b.record.date || ""),
    ),
  );

const grouped = new Map();
for (const item of candidates) {
  const items = grouped.get(item.driver.id) || [];
  items.push(item);
  grouped.set(item.driver.id, items);
}
let planned = 0;
let skipped = 0;
let batch = db.batch();
let batchWrites = 0;

const commitBatch = async () => {
  if (!applyChanges || batchWrites === 0) return;
  await batch.commit();
  batch = db.batch();
  batchWrites = 0;
};

for (const [id, items] of grouped) {
  const stateRef = db.collection("driver_finance_states").doc(id);
  const stateDoc = await stateRef.get();
  let balance = roundMoney(stateDoc.data()?.ledgerBalance || 0);
  let version = Number(stateDoc.data()?.version || 0);

  for (const { record, type, driver } of items) {
    const targetRef = db
      .collection("driver_financial_transactions")
      .doc(`legacy_${record.id}`);
    if ((await targetRef.get()).exists) {
      skipped += 1;
      continue;
    }

    const amount = roundMoney(record.amount);
    if (amount <= 0) {
      skipped += 1;
      continue;
    }
    const direction = getLedgerDirection(type);
    const previousBalance = balance;
    balance = roundMoney(
      balance + (direction === "credit" ? amount : -amount),
    );
    version += 1;
    const createdAt =
      record.createdAt ||
      (record.date ? `${record.date}T00:00:00.000Z` : new Date().toISOString());
    const migrated = {
      id: targetRef.id,
      transactionId: `LEGACY-${record.id}`,
      driverId: driver.id,
      driverName: driver.name || driverName(record),
      relatedTripId: record.tripId || record.bookingId || "",
      transactionType: type,
      amount,
      debitAmount: direction === "debit" ? amount : 0,
      creditAmount: direction === "credit" ? amount : 0,
      previousBalance,
      updatedBalance: balance,
      status: "approved",
      date: record.date || String(createdAt).slice(0, 10),
      createdAt,
      approvedAt: createdAt,
      createdBy: "finance-ledger-migration",
      approvedBy: "finance-ledger-migration",
      remarks: record.notes || "Migrated legacy financial transaction",
      referenceNumber: record.voucherNo || record.referenceNo || "",
      paymentMode: record.paymentMode || record.paymentAccount || "",
      legacyCollection: "transactions",
      legacyDocumentId: record.id,
      isDeleted: false,
    };
    planned += 1;
    if (applyChanges) {
      batch.set(targetRef, migrated);
      batch.set(db.collection("finance_audit_logs").doc(), {
        action: "legacy_finance_transaction_migrated",
        transactionId: migrated.transactionId,
        actor: "finance-ledger-migration",
        actorRole: "system",
        createdAt: new Date().toISOString(),
        after: migrated,
      });
      batchWrites += 2;
      if (batchWrites >= 400) await commitBatch();
    }
  }

  if (applyChanges && items.length > 0) {
    batch.set(
      stateRef,
      {
        driverId: id,
        driverName: items[0].driver.name || "",
        ledgerBalance: balance,
        version,
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    );
    batchWrites += 1;
    if (batchWrites >= 400) await commitBatch();
  }
}

await commitBatch();
console.log(
  JSON.stringify(
    {
      mode: applyChanges ? "applied" : "dry-run",
      candidateTransactions: candidates.length,
      planned,
      skipped,
    },
    null,
    2,
  ),
);
