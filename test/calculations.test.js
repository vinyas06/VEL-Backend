import test from "node:test";
import assert from "node:assert/strict";
import { getDriverMonthSummary } from "../calculations.js";

const trip = (freight, extra = {}) => ({
  id: `trip-${freight}`,
  driver: "Driver One",
  loadingDate: "2026-07-12",
  freight,
  ...extra,
});

test("fixed salary does not accidentally add commission", () => {
  const summary = getDriverMonthSummary(
    { name: "Driver One", salaryType: "fixed", salary: 20000, commissionRate: 10 },
    "2026-07",
    [trip(50000)],
  );

  assert.equal(summary.fixedSalary, 20000);
  assert.equal(summary.commissionEarned, 0);
  assert.equal(summary.grossPayable, 20000);
});

test("commission salary is calculated from matching trips only", () => {
  const summary = getDriverMonthSummary(
    { name: "Driver One", salaryType: "commission", commissionRate: 8 },
    "2026-07",
    [
      trip(10000),
      trip(5000, { driver: "Another Driver" }),
      trip(7000, { loadingDate: "2026-06-30" }),
    ],
  );

  assert.equal(summary.bookingAmount, 10000);
  assert.equal(summary.commissionEarned, 800);
  assert.equal(summary.grossPayable, 800);
});

test("hybrid fixed and commission plan applies both components", () => {
  const summary = getDriverMonthSummary(
    {
      name: "Driver One",
      salaryType: "fixed_commission",
      salary: 15000,
      commissionRate: 5,
    },
    "2026-07",
    [trip(20000)],
  );

  assert.equal(summary.fixedSalary, 15000);
  assert.equal(summary.commissionEarned, 1000);
  assert.equal(summary.grossPayable, 16000);
});

test("approved deductions and salary payments reduce remaining amount once", () => {
  const summary = getDriverMonthSummary(
    { name: "Driver One", salaryType: "fixed", salary: 10000 },
    "2026-07",
    [],
    [
      {
        id: "deduction",
        driverName: "Driver One",
        date: "2026-07-10",
        deductionSource: "driver_salary",
        amount: 500,
      },
      {
        id: "payment",
        driverName: "Driver One",
        date: "2026-07-20",
        category: "Driver Salary",
        amount: 4000,
      },
    ],
  );

  assert.equal(summary.netPayable, 9500);
  assert.equal(summary.paidSalary, 4000);
  assert.equal(summary.remainingThisMonth, 5500);
});

test("per-kilometre salary ignores invalid or negative odometer spans", () => {
  const summary = getDriverMonthSummary(
    {
      name: "Driver One",
      salaryType: "fixed_km",
      salary: 5000,
      kmRate: 4,
      salaryCalculationDate: "2026-01-01",
    },
    "2026-07",
    [],
    [],
    [],
    [
      { driverName: "Driver One", date: "2026-07-01", odometer: 1000 },
      { driverName: "Driver One", date: "2026-07-30", odometer: 1250 },
      { driverName: "Driver One", date: "2026-07-20", odometer: "invalid" },
    ],
  );

  assert.equal(summary.totalKmDriven, 250);
  assert.equal(summary.distanceEarnings, 1000);
  assert.equal(summary.grossPayable, 6000);
});
