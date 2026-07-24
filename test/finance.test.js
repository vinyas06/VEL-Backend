import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateDriverSettlement,
  calculateLedgerBalance,
  FINANCE_TRANSACTION_TYPES as T,
} from "../finance.js";

const driver = { id: "d1", name: "Driver One" };
const salarySummary = { grossPayable: 10000, totalDeductions: 0 };

const entry = (transactionType, amount, extra = {}) => ({
  transactionId: `${transactionType}-${Math.random()}`,
  driverId: "d1",
  driverName: "Driver One",
  transactionType,
  amount,
  status: "approved",
  date: "2026-07-10",
  ...extra,
});

test("online-only trips do not create a cash liability", () => {
  const result = calculateDriverSettlement({
    driver,
    salarySummary,
    bookings: [
      {
        id: "t1",
        driver: "Driver One",
        paymentMode: "Online",
        freight: 5000,
        loadingDate: "2026-07-01",
      },
    ],
  });

  assert.equal(result.cashCollected, 0);
  assert.equal(result.finalBalance, 10000);
});

test("cash trips are offset by approved deposits", () => {
  const result = calculateDriverSettlement({
    driver,
    salarySummary,
    bookings: [
      {
        id: "t1",
        driver: "Driver One",
        paymentMode: "Cash",
        paymentCollectedAmount: 7000,
        loadingDate: "2026-07-01",
      },
    ],
    ledgerEntries: [entry(T.CASH_DEPOSIT, 4500)],
  });

  assert.equal(result.pendingCash, 2500);
  assert.equal(result.finalBalance, 7500);
});

test("mixed cash, bonuses, penalties, advance recovery and partial settlement reconcile", () => {
  const result = calculateDriverSettlement({
    driver,
    salarySummary,
    bookings: [
      {
        id: "cash",
        driver: "Driver One",
        paymentMode: "Cash",
        paymentCollectedAmount: 3000,
        loadingDate: "2026-07-01",
      },
      {
        id: "online",
        driver: "Driver One",
        paymentMode: "Online",
        loadingDate: "2026-07-02",
      },
    ],
    ledgerEntries: [
      entry(T.BONUS, 500),
      entry(T.PENALTY, 200),
      entry(T.ADVANCE_GIVEN, 2000),
      entry(T.ADVANCE_RECOVERY, 750),
      entry(T.CASH_DEPOSIT, 1000),
      entry(T.SETTLEMENT_PAYMENT, 1000),
    ],
  });

  assert.equal(result.advanceRemaining, 1250);
  assert.equal(result.amountBeforeSettlements, 7550);
  assert.equal(result.finalBalance, 6550);
});

test("excess cash deposit becomes payable to the driver", () => {
  const result = calculateDriverSettlement({
    driver,
    salarySummary: { grossPayable: 0 },
    ledgerEntries: [entry(T.CASH_DEPOSIT, 500)],
  });

  assert.equal(result.excessCashDeposited, 500);
  assert.equal(result.finalBalance, 500);
});

test("pending and duplicate entries do not change approved balance", () => {
  const bonus = entry(T.BONUS, 500, { transactionId: "same" });
  const result = calculateDriverSettlement({
    driver,
    salarySummary,
    ledgerEntries: [
      bonus,
      { ...bonus },
      entry(T.PENALTY, 200, { status: "pending" }),
    ],
  });

  assert.equal(result.bonuses, 500);
  assert.equal(result.pendingApprovalAmount, 200);
  assert.equal(result.finalBalance, 10500);
});

test("ledger balance uses credit/debit and ignores cancelled records", () => {
  const result = calculateLedgerBalance([
    { transactionId: "1", creditAmount: 500, debitAmount: 0, status: "approved" },
    { transactionId: "2", creditAmount: 0, debitAmount: 125, status: "approved" },
    { transactionId: "3", creditAmount: 900, debitAmount: 0, status: "reversed" },
  ]);

  assert.equal(result, 375);
});

test("reversals and cancelled financial records do not affect settlement totals", () => {
  const result = calculateDriverSettlement({
    driver,
    salarySummary,
    ledgerEntries: [
      entry(T.BONUS, 500, { status: "reversed" }),
      entry(T.REVERSAL, 500),
      entry(T.PENALTY, 250, { status: "cancelled" }),
    ],
  });

  assert.equal(result.bonuses, 0);
  assert.equal(result.penalties, 0);
  assert.equal(result.finalBalance, 10000);
});
