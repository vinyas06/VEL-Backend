const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const getTimestamp = (record = {}) => {
  const candidates = [record.createdAt, record.date, record.loadingDate];

  for (const value of candidates) {
    if (!value) continue;
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
};

const normalizeKey = (value) => String(value || "").trim().toLowerCase();

export const isMoneyInTransaction = (transaction = {}) =>
  transaction.type === "IN" || transaction.type === "TRANSFER_IN";

export const isSelfTransferTransaction = (transaction = {}) =>
  transaction.type === "TRANSFER_IN" ||
  transaction.type === "TRANSFER_OUT" ||
  transaction.category === "Self Transfer";

const getBookingKeys = (booking = {}) =>
  [booking.id, booking.trackingId, booking.lrNumber]
    .filter(Boolean)
    .map(normalizeKey);

const getTransactionBookingKeys = (transaction = {}) =>
  [
    transaction.bookingId,
    transaction.linkedBookingId,
    transaction.bookingTrackingId,
    transaction.trackingId,
    transaction.tripId,
    transaction.bookingLrNumber,
    transaction.lrNumber,
  ]
    .filter(Boolean)
    .map(normalizeKey);

const transactionMatchesBooking = (transaction, booking) => {
  const transactionKeys = getTransactionBookingKeys(transaction);
  if (!transactionKeys.length) {
    return false;
  }

  const bookingKeys = new Set(getBookingKeys(booking));
  return transactionKeys.some((key) => bookingKeys.has(key));
};

const allocateAmountsToBookings = (bookings, transactions) => {
  const allocatedBookings = bookings
    .map((booking) => ({
      ...booking,
      appliedAmount: 0,
      outstandingAmount: toNumber(booking.baseAmount),
    }))
    .sort((a, b) => getTimestamp(a) - getTimestamp(b));

  const sortedTransactions = [...transactions].sort((a, b) => getTimestamp(a) - getTimestamp(b));
  let unappliedAmount = 0;

  sortedTransactions.forEach((transaction) => {
    let remaining = toNumber(transaction.amount);
    if (remaining <= 0) {
      return;
    }

    const linkedBooking = allocatedBookings.find((booking) =>
      transactionMatchesBooking(transaction, booking)
    );

    if (linkedBooking) {
      const available = Math.max(toNumber(linkedBooking.baseAmount) - linkedBooking.appliedAmount, 0);
      const applied = Math.min(available, remaining);
      linkedBooking.appliedAmount += applied;
      linkedBooking.outstandingAmount = Math.max(
        toNumber(linkedBooking.baseAmount) - linkedBooking.appliedAmount,
        0
      );
      remaining -= applied;
    }

    if (remaining > 0) {
      for (const booking of allocatedBookings) {
        const available = Math.max(toNumber(booking.baseAmount) - booking.appliedAmount, 0);
        if (available <= 0) {
          continue;
        }

        const applied = Math.min(available, remaining);
        booking.appliedAmount += applied;
        booking.outstandingAmount = Math.max(toNumber(booking.baseAmount) - booking.appliedAmount, 0);
        remaining -= applied;

        if (remaining <= 0) {
          break;
        }
      }
    }

    if (remaining > 0) {
      unappliedAmount += remaining;
    }
  });

  return {
    bookings: allocatedBookings,
    unappliedAmount,
  };
};

const getPartyReceiptName = (transaction = {}) =>
  transaction.partyName || transaction.party || "";

const getPayeeName = (transaction = {}) =>
  transaction.payeeName || transaction.payee || "";

const buildBookingLabel = (booking = {}) =>
  booking.trackingId || booking.lrNumber || booking.id || "Booking";

const buildBookingDisplay = (booking = {}) => ({
  id: booking.id,
  trackingId: booking.trackingId || "",
  lrNumber: booking.lrNumber || "",
  loadingDate: booking.loadingDate || "",
  route: `${booking.from || "-"} to ${booking.to || "-"}`,
  label: buildBookingLabel(booking),
});

export const getPartyFinancialSummary = (party, bookings = [], transactions = []) => {
  if (!party?.name) {
    return {
      openingBalance: 0,
      bookingCharges: 0,
      totalReceived: 0,
      totalPaidOut: 0,
      currentBalance: 0,
      outstandingBookings: [],
      unappliedReceipts: 0,
    };
  }

  const partyBookings = bookings
    .filter((booking) => booking.party === party.name)
    .map((booking) => {
      const netDue = toNumber(booking.freight) - toNumber(booking.advance);
      return {
        ...buildBookingDisplay(booking),
        baseAmount: netDue,
        createdAt: booking.createdAt,
      };
    });

  const partyReceipts = transactions.filter(
    (transaction) =>
      transaction.type === "IN" &&
      getPartyReceiptName(transaction) === party.name &&
      transaction.category !== "Trip Advance"
  );

  const partyPayouts = transactions.filter(
    (transaction) =>
      transaction.type !== "IN" &&
      getPayeeName(transaction) === party.name
  );

  const positiveBookings = partyBookings.filter((booking) => toNumber(booking.baseAmount) > 0);
  const allocatedReceipts = allocateAmountsToBookings(positiveBookings, partyReceipts);
  const outstandingMap = new Map(
    allocatedReceipts.bookings.map((booking) => [booking.id, booking])
  );

  const enrichedBookings = partyBookings.map((booking) => {
    const matchedBooking = outstandingMap.get(booking.id);
    return {
      ...booking,
      appliedAmount: matchedBooking?.appliedAmount || 0,
      outstandingAmount:
        toNumber(booking.baseAmount) > 0 ? matchedBooking?.outstandingAmount || 0 : 0,
    };
  });

  const openingBalance = toNumber(party.balance);
  const bookingCharges = partyBookings.reduce((sum, booking) => sum + toNumber(booking.baseAmount), 0);
  const totalReceived = partyReceipts.reduce((sum, transaction) => sum + toNumber(transaction.amount), 0);
  const totalPaidOut = partyPayouts.reduce((sum, transaction) => sum + toNumber(transaction.amount), 0);

  return {
    openingBalance,
    bookingCharges,
    totalReceived,
    totalPaidOut,
    currentBalance: openingBalance + bookingCharges + totalPaidOut - totalReceived,
    outstandingBookings: enrichedBookings.filter(
      (booking) => toNumber(booking.outstandingAmount) > 0
    ),
    unappliedReceipts: allocatedReceipts.unappliedAmount,
  };
};

// --- DRIVER SALARY CALCULATIONS ---

export const getRecordMonthKey = (record = {}) =>
  String(record.loadingDate || record.date || record.createdAt || "").slice(0, 7);

const getDriverRecordName = (record = {}) =>
  record.driverName || record.payeeName || record.payee || record.targetName || "";

const getActiveSalaryScheme = (driver, month) => {
  if (driver.salaryHistory && driver.salaryHistory.length > 0) {
    const validSchemes = driver.salaryHistory.filter(h => h.effectiveMonth <= month);
    if (validSchemes.length > 0) {
      return validSchemes.reduce((max, current) => 
        current.effectiveMonth > max.effectiveMonth ? current : max
      );
    } else {
      return driver.salaryHistory.reduce((min, current) => 
        current.effectiveMonth < min.effectiveMonth ? current : min
      );
    }
  }
  return driver;
};

export const getDriverMonthSummary = (
  driver = {},
  month,
  bookings = [],
  transactions = [],
  submissions = [],
  odoLogs = []
) => {
  const activeScheme = getActiveSalaryScheme(driver, month);
  const driverName = driver.name || "";
  const salaryType = activeScheme.salaryType || "fixed";
  const commissionRate = salaryType === "fixed" ? 0 : toNumber(activeScheme.commissionRate);
  const fixedSalary = salaryType === "commission" ? 0 : toNumber(activeScheme.salary);
  const kmRate = toNumber(activeScheme.kmRate);

  let distanceEarnings = 0;
  let totalKmDriven = 0;

  if (salaryType === "fixed_km") {
    const calcDate = driver.salaryCalculationDate ? new Date(driver.salaryCalculationDate) : new Date(0);
    const validLogs = odoLogs.filter(log => {
      const logDate = new Date(log.timestamp || log.createdAt || log.date || 0);
      return log.driverName === driverName && 
             getRecordMonthKey(log) === month && 
             logDate >= calcDate &&
             log.odometer != null;
    });
    
    if (validLogs.length >= 2) {
      const readings = validLogs.map(l => Number(l.odometer)).filter(v => !isNaN(v));
      if (readings.length >= 2) {
        const minOdo = Math.min(...readings);
        const maxOdo = Math.max(...readings);
        totalKmDriven = maxOdo - minOdo;
        if (totalKmDriven > 0) {
          distanceEarnings = totalKmDriven * kmRate;
        } else {
          totalKmDriven = 0;
        }
      }
    }
  }

  const driverTrips = bookings.filter(
    (booking) =>
      getRecordMonthKey(booking) === month &&
      (booking.driver === driverName || booking.driver2 === driverName)
  );
  const bookingAmount = driverTrips.reduce(
    (sum, booking) => sum + toNumber(booking.freight),
    0
  );
  const commissionEarned = bookingAmount * (commissionRate / 100);
  const grossPayable = fixedSalary + commissionEarned + distanceEarnings;
  
  const approvedDeductions = transactions
    .filter(
      (transaction) =>
        getRecordMonthKey(transaction) === month &&
        getDriverRecordName(transaction) === driverName &&
        transaction.deductionSource === "driver_salary"
    )
    .reduce((sum, transaction) => sum + toNumber(transaction.amount), 0);
  
  const pendingDeductions = submissions
    .filter(
      (submission) =>
        getRecordMonthKey(submission) === month &&
        getDriverRecordName(submission) === driverName &&
        submission.deductionSource === "driver_salary"
    )
    .reduce((sum, submission) => sum + toNumber(submission.amount), 0);
  
  const paidSalary = transactions
    .filter(
      (transaction) =>
        getRecordMonthKey(transaction) === month &&
        getDriverRecordName(transaction) === driverName &&
        transaction.category === "Driver Salary"
    )
    .reduce((sum, transaction) => sum + toNumber(transaction.amount), 0);
  const netPayable = grossPayable - approvedDeductions - pendingDeductions;

  return {
    driverName,
    month,
    salaryType,
    fixedSalary,
    commissionRate,
    tripCount: driverTrips.length,
    bookingAmount,
    commissionEarned,
    distanceEarnings,
    totalKmDriven,
    kmRate,
    grossPayable,
    approvedDeductions,
    pendingDeductions,
    totalDeductions: approvedDeductions + pendingDeductions,
    paidSalary,
    remainingThisMonth: netPayable - paidSalary,
    netPayable,
  };
};
