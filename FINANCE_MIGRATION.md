# Driver finance ledger migration

The new finance APIs use these Firestore collections:

- `driver_financial_transactions`: immutable typed debit/credit entries
- `driver_finance_states`: per-driver ledger balance and optimistic-lock version
- `finance_idempotency`: duplicate-submission protection
- `finance_audit_logs`: before/after audit events

Legacy `transactions`, `bookings`, and `driver_submissions` remain readable so
existing website and mobile features continue to work. No legacy record is
deleted by the migration.

## Before deploying

1. Back up Firestore.
2. Configure `JWT_SECRET`, `JWT_REFRESH_SECRET`, and
   `FIREBASE_SERVICE_ACCOUNT_JSON` from `.env.example`.
3. Deploy the backend before releasing either mobile app.
4. Build the apps with the deployed backend URL:

   `flutter build apk --dart-define=VEL_API_BASE_URL=https://your-api.example.com`

## Migrate legacy driver payments

Run a dry run first:

`node scripts/migrate-finance-ledger.js`

Review the counts, then apply:

`node scripts/migrate-finance-ledger.js --apply`

The script is restart-safe: each migrated record uses the deterministic
`legacy_<document-id>` document ID and is skipped on subsequent runs.

## Rollout notes

- Existing approved salary payments and advances are included in API summaries
  even before migration. After migration, deterministic transaction IDs prevent
  double-counting.
- Admin settlement requests must send the summary `version`; stale concurrent
  approvals receive HTTP 409 and must refresh.
- Financial entries must be reversed through the API. Do not delete ledger or
  audit documents.
- The Admin and Driver apps require a fresh login after upgrade because legacy
  local sessions did not contain backend refresh tokens.
