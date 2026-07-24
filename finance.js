const APPROVED_STATUSES = new Set(["approved", "completed", "posted"]);
const CANCELLED_STATUSES = new Set(["cancelled", "reversed", "rejected", "deleted"]);

export const FINANCE_TRANSACTION_TYPES = Object.freeze({
  BONUS: "BONUS",
  INCENTIVE: "INCENTIVE",
  PENALTY: "PENALTY",
  DEDUCTION: "DEDUCTION",
  ADVANCE_GIVEN: "ADVANCE_GIVEN",
  ADVANCE_RECOVERY: "ADVANCE_RECOVERY",
  CASH_COLLECTED: "CASH_COLLECTED",
  CASH_DEPOSIT: "CASH_DEPOSIT",
  ADJUSTMENT_CREDIT: "ADJUSTMENT_CREDIT",
  ADJUSTMENT_DEBIT: "ADJUSTMENT_DEBIT",
  SETTLEMENT_PAYMENT: "SETTLEMENT_PAYMENT",
  SETTLEMENT_RECOVERY: "SETTLEMENT_RECOVERY",
  REVERSAL: "REVERSAL",
});

export const roundMoney = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
};

export const requirePositiveMoney = (value, fieldName = "amount") => {
  const amount = roundMoney(value);
  if (amount <= 0) {
    throw new Error(`${fieldName} must be greater than zero.`);
  }
  return amount;
};

const normalize = (value) => String(value || "").trim().toLowerCase();

const getDateValue = (record = {}) =>
  String(record.date || record.loadingDate || record.createdAt || "").slice(0, 10);

const isWithinRange = (record, from, to) => {
  const date = getDateValue(record);
  if (!date) return true;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
};

const isApproved = (record = {}) => {
  const status = normalize(record.status || "approved");
  return APPROVED_STATUSES.has(status) || !status;
};

const isPending = (record = {}) => normalize(record.status) === "pending";

const isCancelled = (record = {}) =>
  CANCELLED_STATUSES.has(normalize(record.status)) || record.isDeleted === true;

const matchesDriver = (record = {}, driver = {}) => {
  const driverId = normalize(driver.id || driver.driverId);
  const driverName = normalize(driver.name || driver.driverName);
  const recordIds = [
    record.driverId,
    record.payeeId,
    record.targetId,
  ].map(normalize);
  const recordNames = [
    record.driverName,
    record.driver,
    record.driver2,
    record.payeeName,
    record.payee,
    record.targetName,
  ].map(normalize);

  return (driverId && recordIds.includes(driverId)) ||
    (driverName && recordNames.includes(driverName));
};

const getBookingCashCollected = (booking = {}) => {
  const paymentMode = normalize(booking.paymentMode || booking.tripPaymentMode);
  const isCash = paymentMode.includes("cash") || booking.paymentCollectedInCash === true;
  if (!isCash || booking.paymentCollected === false) return 0;

  const candidates = [
    booking.paymentCollectedAmount,
    booking.cashCollected,
    booking.amountCollected,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && candidate !== "") {
      return Math.max(roundMoney(candidate), 0);
    }
  }

  return Math.max(
    roundMoney(Number(booking.freight || 0) - Number(booking.advance || 0)),
    0,
  );
};

const getBookingCompanyCommission = (booking = {}) => {
  const explicit = booking.companyCommissionAmount ?? booking.companyCommission;
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    return Math.max(roundMoney(explicit), 0);
  }
  return 0;
};

const uniqueEntries = (entries = []) => {
  const seen = new Set();
  return entries.filter((entry, index) => {
    const key = String(
      entry.transactionId || entry.id || entry.referenceNumber || `index:${index}`,
    );
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const sumType = (entries, ...types) =>
  roundMoney(
    entries
      .filter((entry) => types.includes(String(entry.transactionType || "").toUpperCase()))
      .reduce((sum, entry) => sum + roundMoney(entry.amount), 0),
  );

export const calculateDriverSettlement = ({
  driver = {},
  salarySummary = {},
  bookings = [],
  ledgerEntries = [],
  from,
  to,
} = {}) => {
  const driverBookings = bookings.filter(
    (booking) =>
      matchesDriver(booking, driver) &&
      isWithinRange(booking, from, to) &&
      !isCancelled(booking),
  );
  const entries = uniqueEntries(ledgerEntries).filter(
    (entry) => matchesDriver(entry, driver) && isWithinRange(entry, from, to) && !isCancelled(entry),
  );
  const approvedEntries = entries.filter(isApproved);
  const pendingEntries = entries.filter(isPending);

  const grossEarnings = roundMoney(
    salarySummary.grossPayable ?? salarySummary.grossEarnings ?? 0,
  );
  const companyCommission = roundMoney(
    driverBookings.reduce(
      (sum, booking) => sum + getBookingCompanyCommission(booking),
      0,
    ) + sumType(approvedEntries, "COMPANY_COMMISSION"),
  );
  const bonuses = sumType(approvedEntries, FINANCE_TRANSACTION_TYPES.BONUS);
  const incentives = sumType(approvedEntries, FINANCE_TRANSACTION_TYPES.INCENTIVE);
  const penalties = sumType(approvedEntries, FINANCE_TRANSACTION_TYPES.PENALTY);
  const deductions = roundMoney(
    Number(salarySummary.totalDeductions || 0) +
      sumType(approvedEntries, FINANCE_TRANSACTION_TYPES.DEDUCTION),
  );
  const advancesGiven = sumType(
    approvedEntries,
    FINANCE_TRANSACTION_TYPES.ADVANCE_GIVEN,
  );
  const advanceRecovery = sumType(
    approvedEntries,
    FINANCE_TRANSACTION_TYPES.ADVANCE_RECOVERY,
  );
  const cashCollectedFromTrips = roundMoney(
    driverBookings.reduce(
      (sum, booking) => sum + getBookingCashCollected(booking),
      0,
    ),
  );
  const manualCashCollected = sumType(
    approvedEntries,
    FINANCE_TRANSACTION_TYPES.CASH_COLLECTED,
  );
  const cashCollected = roundMoney(cashCollectedFromTrips + manualCashCollected);
  const cashDeposited = sumType(
    approvedEntries,
    FINANCE_TRANSACTION_TYPES.CASH_DEPOSIT,
  );
  const cashLiability = roundMoney(cashCollected - cashDeposited);
  const pendingCash = Math.max(cashLiability, 0);
  const excessCashDeposited = Math.max(roundMoney(-cashLiability), 0);
  const approvedAdjustments = roundMoney(
    sumType(approvedEntries, FINANCE_TRANSACTION_TYPES.ADJUSTMENT_CREDIT) -
      sumType(approvedEntries, FINANCE_TRANSACTION_TYPES.ADJUSTMENT_DEBIT),
  );
  const settlementPaid = sumType(
    approvedEntries,
    FINANCE_TRANSACTION_TYPES.SETTLEMENT_PAYMENT,
  );
  const settlementRecovered = sumType(
    approvedEntries,
    FINANCE_TRANSACTION_TYPES.SETTLEMENT_RECOVERY,
  );

  const amountBeforeSettlements = roundMoney(
    grossEarnings +
      bonuses +
      incentives -
      companyCommission -
      penalties -
      deductions -
      advanceRecovery -
      cashLiability +
      approvedAdjustments,
  );
  const finalBalance = roundMoney(
    amountBeforeSettlements - settlementPaid + settlementRecovered,
  );

  const tripDetails = driverBookings.map((booking) => ({
    tripId: booking.id || booking.tripId || booking.trackingId || "",
    trackingId: booking.trackingId || "",
    date: getDateValue(booking),
    route: `${booking.from || "-"} to ${booking.to || "-"}`,
    freight: roundMoney(booking.freight),
    companyCommission: getBookingCompanyCommission(booking),
    cashCollected: getBookingCashCollected(booking),
    paymentMode: booking.paymentMode || booking.tripPaymentMode || "",
    status: booking.status || "",
  }));

  return {
    driverId: driver.id || driver.driverId || "",
    driverName: driver.name || driver.driverName || "",
    from: from || "",
    to: to || "",
    grossEarnings,
    companyCommission,
    bonuses,
    incentives,
    penalties,
    deductions,
    advancesGiven,
    advanceRecovery,
    advanceRemaining: Math.max(roundMoney(advancesGiven - advanceRecovery), 0),
    cashCollected,
    cashCollectedFromTrips,
    cashDeposited,
    pendingCash,
    excessCashDeposited,
    approvedAdjustments,
    settlementPaid,
    settlementRecovered,
    amountBeforeSettlements,
    finalBalance,
    balanceDirection:
      finalBalance > 0 ? "payable_to_driver" : finalBalance < 0 ? "recoverable_from_driver" : "settled",
    pendingApprovalAmount: roundMoney(
      pendingEntries.reduce((sum, entry) => sum + roundMoney(entry.amount), 0),
    ),
    pendingApprovalCount: pendingEntries.length,
    tripCount: tripDetails.length,
    tripDetails,
  };
};

export const calculateLedgerBalance = (entries = []) =>
  roundMoney(
    uniqueEntries(entries)
      .filter(
        (entry) =>
          isApproved(entry) &&
          !isCancelled(entry) &&
          String(entry.transactionType || "").toUpperCase() !==
            FINANCE_TRANSACTION_TYPES.REVERSAL,
      )
      .reduce((balance, entry) => {
        const credit = roundMoney(entry.creditAmount);
        const debit = roundMoney(entry.debitAmount);
        return balance + credit - debit;
      }, 0),
  );

export const getLedgerDirection = (transactionType) => {
  const creditTypes = new Set([
    FINANCE_TRANSACTION_TYPES.BONUS,
    FINANCE_TRANSACTION_TYPES.INCENTIVE,
    FINANCE_TRANSACTION_TYPES.CASH_DEPOSIT,
    FINANCE_TRANSACTION_TYPES.ADJUSTMENT_CREDIT,
    FINANCE_TRANSACTION_TYPES.SETTLEMENT_RECOVERY,
  ]);
  return creditTypes.has(String(transactionType || "").toUpperCase())
    ? "credit"
    : "debit";
};
