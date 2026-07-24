import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getPartyFinancialSummary, getDriverMonthSummary } from './calculations.js';
import {
  calculateDriverSettlement,
  FINANCE_TRANSACTION_TYPES,
  getLedgerDirection,
  requirePositiveMoney,
  roundMoney,
} from './finance.js';
import { createServer } from 'http';
import { Server } from 'socket.io';

dotenv.config();

const app = express();
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://localhost:3000",
  "https://veerashaivamart.com",
  "https://www.veerashaivamart.com",
  "https://veerashiava-express-logistics.web.app",
  "https://veerashiava-express-logistics.firebaseapp.com",
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// Root path health check endpoint for Uptime Robot
app.get('/', (req, res) => {
  res.status(200).send("VEL Backend API is running safely.");
});

// Setup HTTP Server & WebSockets
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  }
});

// WebSockets connection handler
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on('driver_location_update', async (data) => {
    // Expected payload: { driverName, latitude, longitude }
    const { driverName, latitude, longitude } = data;
    if (!driverName || latitude == null || longitude == null) return;

    console.log(`Location update from ${driverName}: ${latitude}, ${longitude}`);

    try {
      const timestamp = new Date().toISOString();

      // 1. Update driver's current active location in Firestore (doc ID is driverName)
      await db.collection('driver_locations').doc(driverName).set({
        driverName,
        latitude: Number(latitude),
        longitude: Number(longitude),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 2. Fetch last saved history point from Firestore to prevent duplicate coordinate spam
      const lastHistSnap = await db.collection('driver_locations').doc(driverName).get();
      let shouldSaveHistory = true;
      
      const lastHist = lastHistSnap.exists ? lastHistSnap.data() : null;
      if (lastHist && lastHist.lastHistLat != null && lastHist.lastHistLng != null) {
        // Approximate distance check (under 50m)
        const dy = Number(latitude) - Number(lastHist.lastHistLat);
        const dx = (Number(longitude) - Number(lastHist.lastHistLng)) * Math.cos(Number(latitude) * Math.PI / 180);
        const distanceMeters = Math.sqrt(dx * dx + dy * dy) * 111320;
        if (distanceMeters < 50) {
          shouldSaveHistory = false;
        }
      }

      if (shouldSaveHistory) {
        await db.collection('driver_location_history').add({
          driverName,
          latitude: Number(latitude),
          longitude: Number(longitude),
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
        
        // Save this as the last cached history coordinate
        await db.collection('driver_locations').doc(driverName).update({
          lastHistLat: Number(latitude),
          lastHistLng: Number(longitude),
        });
      }

      // 3. Broadcast the location event to all other connected clients
      io.emit('location_update', {
        driverName,
        latitude: Number(latitude),
        longitude: Number(longitude),
        updatedAt: timestamp,
      });

    } catch (err) {
      console.error(`WebSocket location update failed for ${driverName}:`, err);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// Initialize Firebase Admin SDK
let serviceAccount = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch (error) {
    console.error("Error parsing FIREBASE_SERVICE_ACCOUNT_JSON env var:", error.message);
  }
} else {
  try {
    const localKeyPath = join(process.cwd(), 'service-account.json');
    serviceAccount = JSON.parse(readFileSync(localKeyPath, 'utf8'));
    console.log("Loaded Firebase service account from local service-account.json file");
  } catch (error) {
    console.log("Local service-account.json not found, attempting default credentials initialization");
  }
}

try {
  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized successfully via Service Account certificate");
  } else {
    admin.initializeApp();
    console.log("Firebase Admin SDK initialized with default credentials");
  }
} catch (initError) {
  console.error("Critical error during Firebase Admin SDK initialization:", initError.message);
}

const db = admin.firestore();
const JWT_SECRET = process.env.JWT_SECRET ||
  (process.env.NODE_ENV === 'production'
    ? null
    : crypto.randomBytes(48).toString('hex'));
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ||
  (JWT_SECRET ? crypto.createHash('sha256').update(`${JWT_SECRET}:refresh`).digest('hex') : null);

if (!JWT_SECRET || !REFRESH_SECRET) {
  throw new Error('JWT_SECRET and JWT_REFRESH_SECRET are required in production.');
}

if (!process.env.JWT_SECRET && process.env.NODE_ENV !== 'production') {
  console.warn('JWT_SECRET is not configured; using an ephemeral development key.');
}

// Hashing utility matching client SHA-256 logic
function sha256(value) {
  return crypto.createHash('sha256').update(String(value || "")).digest('hex');
}

// Environment static main admins configuration
const staticMainAdmins = [
  process.env.VINYAS_PASSWORD ? {
    username: "vinyas06",
    password: process.env.VINYAS_PASSWORD,
    name: "Vinyas",
    email: "vinyassharana06@gmail.com",
    role: "main_admin",
    roleLabel: "Main Admin"
  } : null,
  process.env.SHERA_PASSWORD ? {
    username: "shera75",
    password: process.env.SHERA_PASSWORD,
    name: "Shera Mohandas Kolalagiri",
    email: "mohandassharana06@gmail.com",
    role: "main_admin",
    roleLabel: "Main Admin"
  } : null,
].filter(Boolean);

// Helper to normalize input fields
const normalizeEmail = (value = "") => value.trim().toLowerCase();
const normalizeLoginId = (value = "") => value.trim().toLowerCase();
const secureCompare = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer);
};
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
const REFRESH_TOKEN_TTL = process.env.REFRESH_TOKEN_TTL || '7d';

const buildTokenPayload = (user = {}) => ({
  loginId: user.loginId || user.username || "",
  email: user.email || "",
  name: user.name || "",
  role: user.role || "staff",
  permissions: Array.isArray(user.permissions) ? user.permissions : [],
  companyKey: user.companyKey || "vel",
  driverId: user.driverId || undefined,
});

const issueTokens = (user) => {
  const payload = buildTokenPayload(user);
  return {
    token: jwt.sign({ ...payload, tokenType: 'access' }, JWT_SECRET, {
      expiresIn: ACCESS_TOKEN_TTL,
    }),
    refreshToken: jwt.sign(
      { loginId: payload.loginId, role: payload.role, driverId: payload.driverId, tokenType: 'refresh' },
      REFRESH_SECRET,
      { expiresIn: REFRESH_TOKEN_TTL },
    ),
    expiresIn: ACCESS_TOKEN_TTL,
  };
};

const safeUserResponse = (user = {}) => ({
  loginId: user.loginId || user.username || "",
  email: user.email || "",
  name: user.name || "",
  role: user.role || "staff",
  roleLabel: user.roleLabel || user.role || "Staff",
  permissions: Array.isArray(user.permissions) ? user.permissions : [],
  companyKey: user.companyKey || "vel",
  companyName: user.companyName || "Veerashaiva Express Logistics",
  driverId: user.driverId || undefined,
  phone: user.phone || undefined,
  vehicle: user.vehicle || undefined,
});

const ROLE_PERMISSIONS = Object.freeze({
  main_admin: ['*'],
  admin: [
    'finance.read',
    'finance.advance.create',
    'finance.deposit.create',
    'finance.adjustment.create',
    'finance.rules.manage',
    'finance.approve',
    'finance.settle',
    'finance.reverse',
    'tracking.read',
    'notifications.send',
  ],
  staff: ['finance.read', 'tracking.read'],
  driver: ['finance.self.read', 'finance.advance.request', 'finance.deposit.request'],
});

const hasPermission = (user = {}, permission) => {
  const permissions = new Set([
    ...(ROLE_PERMISSIONS[user.role] || []),
    ...(Array.isArray(user.permissions) ? user.permissions : []),
  ]);
  return permissions.has('*') || permissions.has(permission);
};

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: "Access denied. No token provided." });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err || user?.tokenType !== 'access') {
      return res.status(403).json({ error: "Invalid or expired session token." });
    }
    req.user = user;
    next();
  });
};

const requirePermission = (permission) => (req, res, next) => {
  if (!hasPermission(req.user, permission)) {
    return res.status(403).json({ error: `Permission '${permission}' is required.` });
  }
  next();
};

const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) {
    return res.status(403).json({ error: 'This account cannot access the requested resource.' });
  }
  next();
};

const loginAttempts = new Map();
const loginRateLimit = (req, res, next) => {
  const key = `${req.ip}:${normalizeLoginId(req.body?.username || '')}`;
  const now = Date.now();
  const recent = (loginAttempts.get(key) || []).filter((time) => now - time < 15 * 60 * 1000);
  if (recent.length >= 10) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  }
  recent.push(now);
  loginAttempts.set(key, recent);
  next();
};

// --- AUTHENTICATION ENDPOINTS ---

// Login endpoint (replacing insecure client-side comparison)
app.post('/api/auth/login', loginRateLimit, async (req, res) => {
  try {
    const { companyKey, username, password } = req.body;
    const safeLoginId = normalizeLoginId(username);

    if (!safeLoginId || !password) {
      return res.status(400).json({ error: "Username and password are required." });
    }

    // 1. Check for Static Environment Main Admins
    const matchingStaticAdmin = staticMainAdmins.find((adminUser) => {
      if (adminUser.username !== safeLoginId) return false;
      const expected = Buffer.from(String(adminUser.password));
      const supplied = Buffer.from(String(password));
      return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
    });

    if (matchingStaticAdmin && companyKey === 'vel') {
      const authUser = {
        ...matchingStaticAdmin,
        loginId: matchingStaticAdmin.username,
        companyKey,
        companyName: "Veerashaiva Express Logistics",
      };

      return res.json({
        ...issueTokens(authUser),
        user: safeUserResponse(authUser),
      });
    }

    // 2. Check portal_users collection
    const portalUserSnap = await db.collection('portal_users')
      .where('companyKey', '==', companyKey)
      .where('username', '==', safeLoginId)
      .limit(1)
      .get();

    if (!portalUserSnap.empty) {
      const portalUserDoc = portalUserSnap.docs[0];
      const portalUser = portalUserDoc.data();
      
      if (!portalUser.passwordHash) {
        return res.status(400).json({ error: "Account configuration error. Please contact the main admin." });
      }

      const isBcryptHash = String(portalUser.passwordHash).startsWith('$2');
      const passwordMatches = isBcryptHash
        ? await bcrypt.compare(password, portalUser.passwordHash)
        : secureCompare(sha256(password), portalUser.passwordHash);
      if (!passwordMatches) {
        return res.status(400).json({ error: "Invalid credentials." });
      }

      if (portalUser.status !== 'approved') {
        return res.status(403).json({
          error: portalUser.status === 'pending'
            ? "Your registration is waiting for main admin approval."
            : "This user is not approved to login."
        });
      }

      if (!isBcryptHash) {
        await portalUserDoc.ref.update({
          passwordHash: await bcrypt.hash(password, 12),
          passwordMigratedAt: new Date().toISOString(),
        });
      }
      const authUser = {
        ...portalUser,
        loginId: portalUser.username,
        role: portalUser.role || portalUser.requestedRole || "admin",
        roleLabel: portalUser.role === 'admin'
          ? 'Secondary Admin'
          : portalUser.role === 'staff'
            ? 'Office Staff'
            : 'Operations Team',
        companyKey,
      };

      return res.json({
        ...issueTokens(authUser),
        user: safeUserResponse(authUser),
      });
    }

    // 3. Check drivers collection
    const driverSnap = await db.collection('drivers')
      .where('driverLoginId', '==', safeLoginId)
      .limit(1)
      .get();

    let driverDoc = null;
    if (!driverSnap.empty) {
      driverDoc = driverSnap.docs[0];
    } else {
      const driverPhoneSnap = await db.collection('drivers')
        .where('phone', '==', safeLoginId)
        .limit(1)
        .get();
      if (!driverPhoneSnap.empty) {
        driverDoc = driverPhoneSnap.docs[0];
      }
    }

    if (driverDoc) {
      const driver = driverDoc.data();
      
      const driverHash = driver.passwordHash || driver.password || "";
      const driverUsesBcrypt = String(driverHash).startsWith('$2');
      const driverPasswordMatches = driverUsesBcrypt
        ? await bcrypt.compare(password, driverHash)
        : String(driverHash) === String(password);
      if (!driverPasswordMatches) {
        return res.status(400).json({ error: "Invalid credentials." });
      }

      if (driver.status === 'inactive') {
        return res.status(403).json({ error: "Your driver account is inactive. Please contact the admin." });
      }

      if (!driverUsesBcrypt) {
        await driverDoc.ref.update({
          passwordHash: await bcrypt.hash(password, 12),
          password: admin.firestore.FieldValue.delete(),
          passwordMigratedAt: new Date().toISOString(),
        });
      }
      const authUser = {
        ...driver,
        loginId: driver.driverLoginId || driver.phone,
        driverId: driverDoc.id,
        role: "driver",
        roleLabel: "Driver",
        companyKey,
        companyName: "Veerashaiva Express Logistics",
      };

      return res.json({
        ...issueTokens(authUser),
        user: safeUserResponse(authUser),
      });
    }

    return res.status(400).json({ error: "Invalid credentials." });
  } catch (error) {
    console.error("Login route error:", error);
    res.status(500).json({ error: "Internal server error during authentication." });
  }
});

app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token is required.' });
    }
    const claims = jwt.verify(refreshToken, REFRESH_SECRET);
    if (claims.tokenType !== 'refresh') {
      return res.status(403).json({ error: 'Invalid refresh token.' });
    }

    let authUser = null;
    if (claims.role === 'driver' && claims.driverId) {
      const driverDoc = await db.collection('drivers').doc(claims.driverId).get();
      if (driverDoc.exists && driverDoc.data().status !== 'inactive') {
        const driver = driverDoc.data();
        authUser = {
          ...driver,
          loginId: driver.driverLoginId || driver.phone,
          driverId: driverDoc.id,
          role: 'driver',
          roleLabel: 'Driver',
        };
      }
    } else {
      const portalSnap = await db.collection('portal_users')
        .where('username', '==', normalizeLoginId(claims.loginId))
        .limit(1)
        .get();
      if (!portalSnap.empty && portalSnap.docs[0].data().status === 'approved') {
        const portalUser = portalSnap.docs[0].data();
        authUser = {
          ...portalUser,
          loginId: portalUser.username,
          role: portalUser.role || portalUser.requestedRole || 'staff',
        };
      } else {
        const staticUser = staticMainAdmins.find((user) => user.username === claims.loginId);
        if (staticUser) authUser = { ...staticUser, loginId: staticUser.username };
      }
    }

    if (!authUser) {
      return res.status(403).json({ error: 'Account is inactive or no longer available.' });
    }
    return res.json({ ...issueTokens(authUser), user: safeUserResponse(authUser) });
  } catch {
    return res.status(403).json({ error: 'Invalid or expired refresh token.' });
  }
});

// Register request endpoint (inserts securely)
app.post('/api/auth/register-request', async (req, res) => {
  try {
    const { name, username, email, password, companyKey, companyName, requestedRole } = req.body;

    if (!name || !username || !email || !password || !companyKey) {
      return res.status(400).json({ error: "Missing required registration details." });
    }

    // Check if user already exists
    const existingSnap = await db.collection('portal_users')
      .where('username', '==', username.toLowerCase())
      .limit(1)
      .get();

    if (!existingSnap.empty) {
      return res.status(400).json({ error: "Username is already registered." });
    }

    if (String(password).length < 10) {
      return res.status(400).json({ error: 'Password must contain at least 10 characters.' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const userDocId = `${companyKey.trim().toLowerCase()}__${email.trim().toLowerCase()}`;

    await db.collection('portal_users').doc(userDocId).set({
      name,
      username: username.toLowerCase().trim(),
      email: email.toLowerCase().trim(),
      passwordHash,
      companyKey,
      companyName: companyName || "Veerashaiva Express Logistics",
      requestedRole: requestedRole || "admin",
      status: "pending",
      createdAt: new Date().toISOString()
    });

    res.status(201).json({ success: "Registration request submitted. Awaiting admin approval." });
  } catch (error) {
    console.error("Register request error:", error);
    res.status(500).json({ error: "Internal server error during registration." });
  }
});

// --- SECURE DATA RETRIEVAL (DRIVER DASHBOARD) ---

// Returns sanitized dashboard data for logged-in driver only
app.get('/api/driver/dashboard-data', authenticateToken, requireRole('driver'), async (req, res) => {
  try {
    const driverName = req.user.name;

    if (!driverName) {
      return res.status(400).json({ error: "Driver name not found in token." });
    }

    // Parallel fetch of driver profile, bookings, transactions and submissions
    const [driverProfileSnap, bookingsSnap, transactionsSnap, submissionsSnap] = await Promise.all([
      db.collection('drivers').where('name', '==', driverName).limit(1).get(),
      db.collection('bookings').get(), // Let's optimize: query where driver or driver2 matches
      db.collection('transactions').get(), // We will scan/filter based on driverName to construct calculations
      db.collection('driver_submissions').get()
    ]);

    let profile = null;
    if (!driverProfileSnap.empty) {
      profile = driverProfileSnap.docs[0].data();
    }

    const bookings = bookingsSnap.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(booking => booking.driver === driverName || booking.driver2 === driverName);

    const allTransactions = transactionsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const allSubmissions = submissionsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const getDriverTransactionName = (record = {}) =>
      record.driverName || record.payeeName || record.payee || "";

    const driverTransactions = allTransactions.filter(
      t => getDriverTransactionName(t) === driverName
    );

    const driverSubmissions = allSubmissions.filter(
      s => getDriverTransactionName(s) === driverName
    );

    // Calculate wallet balance securely on backend
    const givenByAdmin = driverTransactions
      .filter(t => t.category === "Driver Advance")
      .reduce((sum, t) => sum + Number(t.amount || 0), 0);

    const approvedSpent = driverTransactions
      .filter(t => 
        t.category !== "Driver Advance" &&
        t.category !== "Driver Salary" &&
        t.deductionSource !== "driver_salary" &&
        t.type !== "IN" &&
        t.type !== "TRANSFER_IN"
      )
      .reduce((sum, t) => sum + Number(t.amount || 0), 0);

    const pendingSpent = driverSubmissions
      .filter(s => s.deductionSource !== "driver_salary")
      .reduce((sum, s) => sum + Number(s.amount || 0), 0);

    const wallet = {
      givenByAdmin,
      approvedSpent,
      pendingSpent,
      available: givenByAdmin - approvedSpent - pendingSpent
    };

    res.json({
      profile,
      bookings,
      transactions: driverTransactions,
      submissions: driverSubmissions,
      wallet
    });
  } catch (error) {
    console.error("Driver dashboard fetch error:", error);
    res.status(500).json({ error: "Internal server error fetching dashboard data." });
  }
});

// Calculate and return party financial summary securely
app.get(
  '/api/calculations/party/:partyName',
  authenticateToken,
  requirePermission('finance.read'),
  async (req, res) => {
  try {
    const { partyName } = req.params;

    // Fetch the party profile
    const partySnap = await db.collection('parties')
      .where('name', '==', partyName)
      .limit(1)
      .get();

    if (partySnap.empty) {
      return res.status(404).json({ error: `Party '${partyName}' not found.` });
    }

    const party = partySnap.docs[0].data();

    // Fetch bookings and transactions in parallel
    const [bookingsSnap, transactionsSnap] = await Promise.all([
      db.collection('bookings').where('party', '==', partyName).get(),
      db.collection('transactions').get()
    ]);

    const bookings = bookingsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const allTransactions = transactionsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const summary = getPartyFinancialSummary(party, bookings, allTransactions);

    res.json(summary);
  } catch (error) {
    console.error("Party financial summary error:", error);
    res.status(500).json({ error: "Internal server error calculating party summary." });
  }
  },
);

// Calculate and return driver monthly salary summary securely
app.get('/api/calculations/driver-salary/:driverName/:month', authenticateToken, async (req, res) => {
  try {
    const { driverName, month } = req.params;
    if (
      req.user.role === 'driver'
        ? req.user.name !== driverName
        : !hasPermission(req.user, 'finance.read')
    ) {
      return res.status(403).json({ error: 'You cannot access this driver salary record.' });
    }

    // Fetch driver profile
    const driverSnap = await db.collection('drivers')
      .where('name', '==', driverName)
      .limit(1)
      .get();

    if (driverSnap.empty) {
      return res.status(404).json({ error: `Driver '${driverName}' not found.` });
    }

    const driver = driverSnap.docs[0].data();

    // Parallel fetch of driver bookings, transactions, submissions, and odometer logs
    const [bookingsSnap, transactionsSnap, submissionsSnap, odoLogsSnap] = await Promise.all([
      db.collection('bookings').get(),
      db.collection('transactions').get(),
      db.collection('driver_submissions').get(),
      db.collection('odometer_logs').get()
    ]);

    const bookings = bookingsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const transactions = transactionsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const submissions = submissionsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    
    let odoLogs = [];
    if (odoLogsSnap && !odoLogsSnap.empty) {
      odoLogs = odoLogsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }

    const summary = getDriverMonthSummary(driver, month, bookings, transactions, submissions, odoLogs);

    res.json(summary);
  } catch (error) {
    console.error("Driver salary summary calculation error:", error);
    res.status(500).json({ error: "Internal server error calculating driver salary." });
  }
});

// --- AUTHORITATIVE DRIVER FINANCIAL LEDGER ---

const financeTransactions = db.collection('driver_financial_transactions');
const financeStates = db.collection('driver_finance_states');
const financeIdempotency = db.collection('finance_idempotency');
const financeAudit = db.collection('finance_audit_logs');

const httpError = (status, message) => Object.assign(new Error(message), { status });

const cleanText = (value, maxLength = 500) =>
  String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);

const parseDateRange = (query = {}) => {
  const today = new Date();
  const defaultMonth = today.toISOString().slice(0, 7);
  const from = cleanText(query.from || `${defaultMonth}-01`, 10);
  const to = cleanText(
    query.to || new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().slice(0, 10),
    10,
  );
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(from) || !datePattern.test(to) || from > to) {
    throw httpError(400, 'A valid from/to date range is required.');
  }
  return { from, to };
};

const monthKeysInRange = (from, to) => {
  const months = [];
  let cursor = new Date(`${from.slice(0, 7)}-01T00:00:00.000Z`);
  const last = new Date(`${to.slice(0, 7)}-01T00:00:00.000Z`);
  while (cursor <= last && months.length < 24) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  if (cursor <= last) throw httpError(400, 'Date range cannot exceed 24 months.');
  return months;
};

const recordDriverName = (record = {}) =>
  record.driverName || record.payeeName || record.payee || record.targetName || "";

const normalizedEqual = (actual, expected) =>
  !expected || String(actual || "").trim().toLowerCase() === String(expected).trim().toLowerCase();

const calculateRuleBasedCommission = (driver, bookings, rules, range) => {
  if ((driver.salaryType || 'fixed') === 'fixed') return null;
  const driverBookings = bookings.filter((booking) => {
    const date = String(booking.loadingDate || booking.date || booking.createdAt || "").slice(0, 10);
    return (
      date >= range.from &&
      date <= range.to &&
      (booking.driver === driver.name || booking.driver2 === driver.name)
    );
  });
  let matchedRuleCount = 0;
  const details = driverBookings.map((booking) => {
    const date = String(booking.loadingDate || booking.date || booking.createdAt || "").slice(0, 10);
    const matchingRules = rules
      .filter((rule) => String(rule.status || 'active').toLowerCase() === 'active')
      .filter((rule) => !rule.effectiveFrom || date >= rule.effectiveFrom)
      .filter((rule) => !rule.effectiveTo || date <= rule.effectiveTo)
      .filter((rule) => normalizedEqual(driver.category, rule.driverCategory))
      .filter((rule) => normalizedEqual(booking.vehicleType, rule.vehicleType))
      .filter((rule) => normalizedEqual(booking.serviceType, rule.serviceType))
      .filter((rule) => normalizedEqual(booking.tripType, rule.tripType))
      .filter(
        (rule) =>
          !rule.city ||
          normalizedEqual(booking.from, rule.city) ||
          normalizedEqual(booking.to, rule.city),
      )
      .map((rule) => ({
        ...rule,
        specificity: [
          rule.driverCategory,
          rule.vehicleType,
          rule.serviceType,
          rule.tripType,
          rule.city,
        ].filter(Boolean).length,
      }))
      .sort(
        (a, b) =>
          b.specificity - a.specificity ||
          Number(b.priority || 0) - Number(a.priority || 0),
      );
    const rule = matchingRules[0];
    const freight = roundMoney(booking.freight);
    let earning;
    if (rule) {
      matchedRuleCount += 1;
      earning = rule.commissionType === 'fixed'
        ? roundMoney(rule.commissionValue)
        : roundMoney(freight * (Number(rule.commissionValue || 0) / 100));
    } else {
      earning = roundMoney(freight * (Number(driver.commissionRate || 0) / 100));
    }
    return {
      bookingId: booking.id,
      ruleId: rule?.id || null,
      ruleName: rule?.name || 'Driver default',
      earning,
    };
  });
  if (matchedRuleCount === 0) return null;
  return {
    commissionEarned: roundMoney(details.reduce((sum, item) => sum + item.earning, 0)),
    details,
  };
};

const legacyFinanceEntries = (
  driver,
  transactions,
  submissions,
  migratedLegacyIds = new Set(),
) => {
  const driverName = driver.name || "";
  const transactionEntries = transactions
    .filter(
      (record) =>
        recordDriverName(record) === driverName &&
        !migratedLegacyIds.has(record.id),
    )
    .map((record) => {
      const category = cleanText(record.category, 80).toLowerCase();
      let transactionType = null;
      if (category === 'driver advance' || category === 'trip advance') {
        transactionType = FINANCE_TRANSACTION_TYPES.ADVANCE_GIVEN;
      } else if (category === 'driver salary') {
        transactionType = FINANCE_TRANSACTION_TYPES.SETTLEMENT_PAYMENT;
      } else if (category === 'bonus') {
        transactionType = FINANCE_TRANSACTION_TYPES.BONUS;
      } else if (category === 'incentive') {
        transactionType = FINANCE_TRANSACTION_TYPES.INCENTIVE;
      } else if (category === 'penalty') {
        transactionType = FINANCE_TRANSACTION_TYPES.PENALTY;
      }
      if (!transactionType) return null;
      return {
        id: `legacy:${record.id}`,
        transactionId: `legacy:${record.id}`,
        driverId: driver.id,
        driverName,
        transactionType,
        amount: roundMoney(record.amount),
        status: 'approved',
        date: record.date || record.createdAt || "",
        createdAt: record.createdAt || record.date || "",
        remarks: record.notes || 'Legacy transaction',
        referenceNumber: record.voucherNo || record.referenceNo || "",
      };
    })
    .filter(Boolean);
  const pendingEntries = submissions
    .filter(
      (record) =>
        recordDriverName(record) === driverName &&
        record.deductionSource === 'driver_salary' &&
        ['pending', 'pending approval'].includes(
          String(record.status || 'pending').toLowerCase(),
        ),
    )
    .map((record) => ({
      id: `legacy-submission:${record.id}`,
      transactionId: `legacy-submission:${record.id}`,
      driverId: driver.id,
      driverName,
      transactionType: FINANCE_TRANSACTION_TYPES.DEDUCTION,
      amount: roundMoney(record.amount),
      status: 'pending',
      date: record.date || record.createdAt || "",
      createdAt: record.createdAt || record.date || "",
      remarks: record.notes || 'Pending driver deduction',
    }));
  return [...transactionEntries, ...pendingEntries];
};

const loadDriverFinanceContext = async (driverId, range) => {
  const driverDoc = await db.collection('drivers').doc(driverId).get();
  if (!driverDoc.exists) throw httpError(404, 'Driver not found.');
  const driver = { id: driverDoc.id, ...driverDoc.data() };

  const [bookingsSnap, transactionsSnap, submissionsSnap, odoLogsSnap, ledgerSnap, stateSnap, rulesSnap] =
    await Promise.all([
      db.collection('bookings').get(),
      db.collection('transactions').get(),
      db.collection('driver_submissions').get(),
      db.collection('odometer_logs').get(),
      financeTransactions.where('driverId', '==', driverId).get(),
      financeStates.doc(driverId).get(),
      db.collection('driver_commission_rules').get(),
    ]);

  const bookings = bookingsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const transactions = transactionsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const submissions = submissionsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const odoLogs = odoLogsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const ledgerEntries = ledgerSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const commissionRules = rulesSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const migratedLegacyIds = new Set(
    ledgerEntries.map((entry) => entry.legacyDocumentId).filter(Boolean),
  );

  const salarySummaries = monthKeysInRange(range.from, range.to).map((month) =>
    getDriverMonthSummary(driver, month, bookings, transactions, submissions, odoLogs),
  );
  const salarySummary = salarySummaries.reduce(
    (total, summary) => ({
      grossPayable: roundMoney(total.grossPayable + summary.grossPayable),
      totalDeductions: roundMoney(total.totalDeductions + summary.approvedDeductions),
      fixedSalary: roundMoney(total.fixedSalary + summary.fixedSalary),
      commissionEarned: roundMoney(total.commissionEarned + summary.commissionEarned),
      distanceEarnings: roundMoney(total.distanceEarnings + summary.distanceEarnings),
    }),
    { grossPayable: 0, totalDeductions: 0, fixedSalary: 0, commissionEarned: 0, distanceEarnings: 0 },
  );
  const ruleCommission = calculateRuleBasedCommission(
    driver,
    bookings,
    commissionRules,
    range,
  );
  if (ruleCommission) {
    salarySummary.commissionEarned = ruleCommission.commissionEarned;
    salarySummary.grossPayable = roundMoney(
      salarySummary.fixedSalary +
        salarySummary.distanceEarnings +
        ruleCommission.commissionEarned,
    );
  }
  const allLedgerEntries = [
    ...ledgerEntries,
    ...legacyFinanceEntries(driver, transactions, submissions, migratedLegacyIds),
  ];
  const summary = calculateDriverSettlement({
    driver,
    salarySummary,
    bookings,
    ledgerEntries: allLedgerEntries,
    ...range,
  });
  const lifetimeAdvanceSummary = calculateDriverSettlement({
    driver,
    salarySummary: { grossPayable: 0, totalDeductions: 0 },
    bookings: [],
    ledgerEntries: allLedgerEntries,
  });

  return {
    driver,
    salarySummary,
    salarySummaries,
    ledgerEntries: allLedgerEntries,
    summary: {
      ...summary,
      advanceRemaining: lifetimeAdvanceSummary.advanceRemaining,
      salaryBreakdown: salarySummary,
      commissionRuleDetails: ruleCommission?.details || [],
      version: Number(stateSnap.data()?.version || 0),
    },
  };
};

const assertDriverScope = (req, driverId, adminPermission = 'finance.read') => {
  if (req.user.role === 'driver') {
    if (req.user.driverId !== driverId) {
      throw httpError(403, 'Drivers can access only their own financial records.');
    }
    if (!hasPermission(req.user, 'finance.self.read')) {
      throw httpError(403, 'Permission denied.');
    }
  } else if (!hasPermission(req.user, adminPermission)) {
    throw httpError(403, `Permission '${adminPermission}' is required.`);
  }
};

const getIdempotencyKey = (req) => {
  const key = cleanText(req.get('Idempotency-Key') || req.body?.idempotencyKey, 128);
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    throw httpError(400, 'A unique Idempotency-Key of at least 8 characters is required.');
  }
  return key;
};

const createFinanceEntry = async ({
  req,
  driver,
  transactionType,
  status = 'approved',
  amount,
  details = {},
  expectedVersion,
}) => {
  const idempotencyKey = getIdempotencyKey(req);
  const idempotencyId = sha256(`${req.user.companyKey || 'vel'}:${idempotencyKey}`);
  const idempotencyRef = financeIdempotency.doc(idempotencyId);
  const entryRef = financeTransactions.doc();
  const stateRef = financeStates.doc(driver.id);
  const auditRef = financeAudit.doc();
  const now = new Date().toISOString();
  const direction = getLedgerDirection(transactionType);
  const safeAmount = requirePositiveMoney(amount);

  return db.runTransaction(async (transaction) => {
    const [existingRequest, stateDoc] = await Promise.all([
      transaction.get(idempotencyRef),
      transaction.get(stateRef),
    ]);
    if (existingRequest.exists) return existingRequest.data().response;

    const state = stateDoc.data() || {};
    const version = Number(state.version || 0);
    if (expectedVersion !== undefined && Number(expectedVersion) !== version) {
      throw httpError(409, 'Financial data changed. Refresh and try again.');
    }
    const previousBalance = roundMoney(state.ledgerBalance || 0);
    const approved = status === 'approved';
    const delta = direction === 'credit' ? safeAmount : -safeAmount;
    const updatedBalance = approved ? roundMoney(previousBalance + delta) : previousBalance;
    const transactionId = `DFT-${now.slice(0, 10).replaceAll('-', '')}-${crypto.randomUUID()}`;
    const entry = {
      id: entryRef.id,
      transactionId,
      driverId: driver.id,
      driverName: driver.name || "",
      relatedTripId: cleanText(details.relatedTripId, 120),
      transactionType,
      amount: safeAmount,
      debitAmount: direction === 'debit' ? safeAmount : 0,
      creditAmount: direction === 'credit' ? safeAmount : 0,
      previousBalance,
      updatedBalance,
      status,
      date: cleanText(details.date || now.slice(0, 10), 10),
      createdAt: now,
      approvedAt: approved ? now : null,
      createdBy: req.user.loginId || req.user.name || "",
      approvedBy: approved ? req.user.loginId || req.user.name || "" : null,
      remarks: cleanText(details.remarks, 500),
      referenceNumber: cleanText(details.referenceNumber, 120),
      paymentMode: cleanText(details.paymentMode, 50),
      proofUrl: cleanText(details.proofUrl, 1000),
      recoveryMode: cleanText(details.recoveryMode, 30),
      installmentCount: Math.max(Number(details.installmentCount || 0), 0),
      metadata: details.metadata || {},
      isDeleted: false,
    };

    transaction.set(entryRef, entry);
    if (approved) {
      transaction.set(stateRef, {
        driverId: driver.id,
        driverName: driver.name || "",
        ledgerBalance: updatedBalance,
        version: version + 1,
        updatedAt: now,
      }, { merge: true });
    }
    transaction.set(auditRef, {
      action: status === 'pending' ? 'finance_request_created' : 'finance_transaction_created',
      transactionId,
      actor: req.user.loginId || req.user.name || "",
      actorRole: req.user.role,
      createdAt: now,
      after: entry,
    });
    transaction.set(idempotencyRef, {
      keyHash: idempotencyId,
      createdAt: now,
      response: entry,
    });
    return entry;
  });
};

app.get(
  '/api/finance/commission-rules',
  authenticateToken,
  requirePermission('finance.read'),
  async (_req, res) => {
    try {
      const snapshot = await db.collection('driver_commission_rules').get();
      const items = snapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .sort(
          (a, b) =>
            Number(b.priority || 0) - Number(a.priority || 0) ||
            String(a.name || "").localeCompare(String(b.name || "")),
        );
      res.json({ items });
    } catch (error) {
      console.error('Commission rules load error:', error);
      res.status(500).json({ error: 'Failed to load commission rules.' });
    }
  },
);

app.post(
  '/api/finance/commission-rules',
  authenticateToken,
  requirePermission('finance.rules.manage'),
  async (req, res) => {
    try {
      const commissionType = req.body.commissionType === 'fixed' ? 'fixed' : 'percentage';
      const commissionValue = requirePositiveMoney(req.body.commissionValue, 'commissionValue');
      if (commissionType === 'percentage' && commissionValue > 100) {
        throw httpError(400, 'Percentage commission cannot exceed 100.');
      }
      const idempotencyKey = getIdempotencyKey(req);
      const idemRef = financeIdempotency.doc(
        sha256(`${req.user.companyKey || 'vel'}:${idempotencyKey}`),
      );
      const ruleRef = req.body.id
        ? db.collection('driver_commission_rules').doc(cleanText(req.body.id, 160))
        : db.collection('driver_commission_rules').doc();
      const now = new Date().toISOString();
      const rule = {
        id: ruleRef.id,
        name: cleanText(req.body.name || 'Commission rule', 120),
        commissionType,
        commissionValue,
        driverCategory: cleanText(req.body.driverCategory, 80),
        vehicleType: cleanText(req.body.vehicleType, 80),
        city: cleanText(req.body.city, 120),
        serviceType: cleanText(req.body.serviceType, 80),
        tripType: cleanText(req.body.tripType, 80),
        effectiveFrom: cleanText(req.body.effectiveFrom, 10),
        effectiveTo: cleanText(req.body.effectiveTo, 10),
        priority: Math.max(Math.floor(Number(req.body.priority || 0)), 0),
        status: req.body.status === 'inactive' ? 'inactive' : 'active',
        updatedAt: now,
        updatedBy: req.user.loginId || req.user.name || "",
      };
      if (
        (rule.effectiveFrom && !/^\d{4}-\d{2}-\d{2}$/.test(rule.effectiveFrom)) ||
        (rule.effectiveTo && !/^\d{4}-\d{2}-\d{2}$/.test(rule.effectiveTo)) ||
        (rule.effectiveFrom && rule.effectiveTo && rule.effectiveFrom > rule.effectiveTo)
      ) {
        throw httpError(400, 'Commission rule effective dates are invalid.');
      }
      const response = await db.runTransaction(async (transaction) => {
        const idemDoc = await transaction.get(idemRef);
        if (idemDoc.exists) return idemDoc.data().response;
        const existing = await transaction.get(ruleRef);
        const saved = {
          ...(existing.data() || {}),
          ...rule,
          createdAt: existing.data()?.createdAt || now,
          createdBy:
            existing.data()?.createdBy || req.user.loginId || req.user.name || "",
        };
        transaction.set(ruleRef, saved);
        transaction.set(financeAudit.doc(), {
          action: existing.exists ? 'commission_rule_updated' : 'commission_rule_created',
          ruleId: ruleRef.id,
          actor: req.user.loginId || req.user.name || "",
          actorRole: req.user.role,
          createdAt: now,
          before: existing.data() || null,
          after: saved,
        });
        transaction.set(idemRef, { createdAt: now, response: saved });
        return saved;
      });
      res.status(req.body.id ? 200 : 201).json(response);
    } catch (error) {
      res.status(error.status || 500).json({
        error: error.status ? error.message : 'Failed to save commission rule.',
      });
    }
  },
);

app.get('/api/finance/drivers/:driverId/summary', authenticateToken, async (req, res) => {
  try {
    assertDriverScope(req, req.params.driverId);
    const range = parseDateRange(req.query);
    const context = await loadDriverFinanceContext(req.params.driverId, range);
    res.json(context.summary);
  } catch (error) {
    console.error('Driver finance summary error:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to calculate driver finances.' });
  }
});

app.get('/api/finance/drivers/:driverId/ledger', authenticateToken, async (req, res) => {
  try {
    assertDriverScope(req, req.params.driverId);
    const range = parseDateRange(req.query);
    const context = await loadDriverFinanceContext(req.params.driverId, range);
    const status = cleanText(req.query.status, 30).toLowerCase();
    const type = cleanText(req.query.type, 50).toUpperCase();
    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
    const filtered = context.ledgerEntries
      .filter((entry) => {
        const date = String(entry.date || entry.createdAt || "").slice(0, 10);
        return date >= range.from && date <= range.to;
      })
      .filter((entry) => !status || String(entry.status || "").toLowerCase() === status)
      .filter((entry) => !type || String(entry.transactionType || "").toUpperCase() === type)
      .sort((a, b) => String(b.createdAt || b.date || "").localeCompare(String(a.createdAt || a.date || "")));
    const start = (page - 1) * limit;
    res.json({
      items: filtered.slice(start, start + limit),
      page,
      limit,
      total: filtered.length,
      totalPages: Math.max(Math.ceil(filtered.length / limit), 1),
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to load the financial ledger.' });
  }
});

app.post('/api/finance/advances', authenticateToken, async (req, res) => {
  try {
    const driverId = req.user.role === 'driver' ? req.user.driverId : cleanText(req.body.driverId, 160);
    const permission = req.user.role === 'driver' ? 'finance.advance.request' : 'finance.advance.create';
    if (!hasPermission(req.user, permission)) throw httpError(403, `Permission '${permission}' is required.`);
    const driverDoc = await db.collection('drivers').doc(driverId).get();
    if (!driverDoc.exists) throw httpError(404, 'Driver not found.');
    const driver = { id: driverDoc.id, ...driverDoc.data() };
    const recoveryMode = req.body.recoveryMode === 'installments' ? 'installments' : 'one_time';
    const installmentCount = recoveryMode === 'installments'
      ? Math.max(Math.floor(Number(req.body.installmentCount || 0)), 2)
      : 1;
    const entry = await createFinanceEntry({
      req,
      driver,
      transactionType: FINANCE_TRANSACTION_TYPES.ADVANCE_GIVEN,
      status: req.user.role === 'driver' ? 'pending' : 'approved',
      amount: req.body.amount,
      details: {
        ...req.body,
        recoveryMode,
        installmentCount,
      },
    });
    res.status(201).json(entry);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to record advance.' });
  }
});

app.post('/api/finance/cash-deposits', authenticateToken, async (req, res) => {
  try {
    const driverId = req.user.role === 'driver' ? req.user.driverId : cleanText(req.body.driverId, 160);
    const permission = req.user.role === 'driver' ? 'finance.deposit.request' : 'finance.deposit.create';
    if (!hasPermission(req.user, permission)) throw httpError(403, `Permission '${permission}' is required.`);
    const driverDoc = await db.collection('drivers').doc(driverId).get();
    if (!driverDoc.exists) throw httpError(404, 'Driver not found.');
    const driver = { id: driverDoc.id, ...driverDoc.data() };
    const entry = await createFinanceEntry({
      req,
      driver,
      transactionType: FINANCE_TRANSACTION_TYPES.CASH_DEPOSIT,
      status: req.user.role === 'driver' ? 'pending' : 'approved',
      amount: req.body.amount,
      details: req.body,
    });
    res.status(201).json(entry);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to record cash deposit.' });
  }
});

app.post(
  '/api/finance/adjustments',
  authenticateToken,
  requirePermission('finance.adjustment.create'),
  async (req, res) => {
    try {
      const driverDoc = await db.collection('drivers').doc(cleanText(req.body.driverId, 160)).get();
      if (!driverDoc.exists) throw httpError(404, 'Driver not found.');
      const adjustmentType = req.body.direction === 'debit'
        ? FINANCE_TRANSACTION_TYPES.ADJUSTMENT_DEBIT
        : req.body.kind === 'bonus'
          ? FINANCE_TRANSACTION_TYPES.BONUS
          : req.body.kind === 'incentive'
            ? FINANCE_TRANSACTION_TYPES.INCENTIVE
            : req.body.kind === 'penalty'
              ? FINANCE_TRANSACTION_TYPES.PENALTY
              : FINANCE_TRANSACTION_TYPES.ADJUSTMENT_CREDIT;
      const entry = await createFinanceEntry({
        req,
        driver: { id: driverDoc.id, ...driverDoc.data() },
        transactionType: adjustmentType,
        amount: req.body.amount,
        details: req.body,
      });
      res.status(201).json(entry);
    } catch (error) {
      res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to record adjustment.' });
    }
  },
);

app.post(
  '/api/finance/advance-recoveries',
  authenticateToken,
  requirePermission('finance.adjustment.create'),
  async (req, res) => {
    try {
      const driverDoc = await db.collection('drivers').doc(cleanText(req.body.driverId, 160)).get();
      if (!driverDoc.exists) throw httpError(404, 'Driver not found.');
      const entry = await createFinanceEntry({
        req,
        driver: { id: driverDoc.id, ...driverDoc.data() },
        transactionType: FINANCE_TRANSACTION_TYPES.ADVANCE_RECOVERY,
        amount: req.body.amount,
        details: req.body,
      });
      res.status(201).json(entry);
    } catch (error) {
      res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to recover advance.' });
    }
  },
);

app.post(
  '/api/finance/requests/:transactionId/decision',
  authenticateToken,
  requirePermission('finance.approve'),
  async (req, res) => {
    try {
      const decision = cleanText(req.body.decision, 20).toLowerCase();
      if (!['approve', 'reject'].includes(decision)) throw httpError(400, 'Decision must be approve or reject.');
      const idempotencyKey = getIdempotencyKey(req);
      const idemRef = financeIdempotency.doc(sha256(`${req.user.companyKey || 'vel'}:${idempotencyKey}`));
      const entryRef = financeTransactions.doc(req.params.transactionId);
      const now = new Date().toISOString();
      const response = await db.runTransaction(async (transaction) => {
        const entryDoc = await transaction.get(entryRef);
        if (!entryDoc.exists) throw httpError(404, 'Financial request not found.');
        const entry = entryDoc.data();
        const stateRef = financeStates.doc(entry.driverId);
        const [idemDoc, stateDoc] = await Promise.all([
          transaction.get(idemRef),
          transaction.get(stateRef),
        ]);
        if (idemDoc.exists) return idemDoc.data().response;
        if (entry.status !== 'pending') throw httpError(409, 'This request has already been decided.');
        const state = stateDoc.data() || {};
        const previousBalance = roundMoney(state.ledgerBalance || 0);
        const delta = roundMoney(entry.creditAmount) - roundMoney(entry.debitAmount);
        const approved = decision === 'approve';
        const updatedBalance = approved ? roundMoney(previousBalance + delta) : previousBalance;
        const updated = {
          status: approved ? 'approved' : 'rejected',
          approvedAt: approved ? now : null,
          approvedBy: req.user.loginId || req.user.name || "",
          decisionRemarks: cleanText(req.body.remarks, 500),
          previousBalance,
          updatedBalance,
          updatedAt: now,
        };
        transaction.update(entryRef, updated);
        if (approved) {
          transaction.set(stateRef, {
            driverId: entry.driverId,
            driverName: entry.driverName,
            ledgerBalance: updatedBalance,
            version: Number(state.version || 0) + 1,
            updatedAt: now,
          }, { merge: true });
        }
        const result = { id: entryDoc.id, ...entry, ...updated };
        transaction.set(financeAudit.doc(), {
          action: approved ? 'finance_request_approved' : 'finance_request_rejected',
          transactionId: entry.transactionId,
          actor: req.user.loginId || req.user.name || "",
          actorRole: req.user.role,
          createdAt: now,
          before: entry,
          after: result,
        });
        transaction.set(idemRef, { createdAt: now, response: result });
        return result;
      });
      res.json(response);
    } catch (error) {
      res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to decide request.' });
    }
  },
);

app.post(
  '/api/finance/settlements',
  authenticateToken,
  requirePermission('finance.settle'),
  async (req, res) => {
    try {
      const driverId = cleanText(req.body.driverId, 160);
      const range = parseDateRange(req.body);
      const context = await loadDriverFinanceContext(driverId, range);
      const currentBalance = roundMoney(context.summary.finalBalance);
      if (currentBalance === 0) throw httpError(409, 'This driver is already settled for the selected range.');
      const amount = requirePositiveMoney(req.body.amount);
      if (amount > Math.abs(currentBalance)) {
        throw httpError(400, 'Settlement amount cannot exceed the current payable or recoverable balance.');
      }
      if (!Number.isInteger(Number(req.body.expectedVersion))) {
        throw httpError(400, 'expectedVersion is required. Refresh the summary before settling.');
      }
      const transactionType = currentBalance > 0
        ? FINANCE_TRANSACTION_TYPES.SETTLEMENT_PAYMENT
        : FINANCE_TRANSACTION_TYPES.SETTLEMENT_RECOVERY;
      const entry = await createFinanceEntry({
        req,
        driver: context.driver,
        transactionType,
        amount,
        expectedVersion: Number(req.body.expectedVersion),
        details: {
          ...req.body,
          metadata: { from: range.from, to: range.to, balanceBefore: currentBalance },
        },
      });
      res.status(201).json(entry);
    } catch (error) {
      res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to complete settlement.' });
    }
  },
);

app.post(
  '/api/finance/transactions/:transactionId/reverse',
  authenticateToken,
  requirePermission('finance.reverse'),
  async (req, res) => {
    try {
      const idempotencyKey = getIdempotencyKey(req);
      const idemRef = financeIdempotency.doc(sha256(`${req.user.companyKey || 'vel'}:${idempotencyKey}`));
      const originalRef = financeTransactions.doc(req.params.transactionId);
      const reversalRef = financeTransactions.doc();
      const now = new Date().toISOString();
      const response = await db.runTransaction(async (transaction) => {
        const originalDoc = await transaction.get(originalRef);
        if (!originalDoc.exists) throw httpError(404, 'Financial transaction not found.');
        const original = originalDoc.data();
        const stateRef = financeStates.doc(original.driverId);
        const [idemDoc, stateDoc] = await Promise.all([
          transaction.get(idemRef),
          transaction.get(stateRef),
        ]);
        if (idemDoc.exists) return idemDoc.data().response;
        if (original.status !== 'approved') throw httpError(409, 'Only approved transactions can be reversed.');
        const state = stateDoc.data() || {};
        const previousBalance = roundMoney(state.ledgerBalance || 0);
        const originalDelta = roundMoney(original.creditAmount) - roundMoney(original.debitAmount);
        const updatedBalance = roundMoney(previousBalance - originalDelta);
        const reversal = {
          ...original,
          id: reversalRef.id,
          transactionId: `DFT-REV-${crypto.randomUUID()}`,
          transactionType: FINANCE_TRANSACTION_TYPES.REVERSAL,
          debitAmount: roundMoney(original.creditAmount),
          creditAmount: roundMoney(original.debitAmount),
          previousBalance,
          updatedBalance,
          status: 'approved',
          createdAt: now,
          date: now.slice(0, 10),
          approvedAt: now,
          createdBy: req.user.loginId || req.user.name || "",
          approvedBy: req.user.loginId || req.user.name || "",
          remarks: cleanText(req.body.remarks || `Reversal of ${original.transactionId}`, 500),
          reversesTransactionId: original.transactionId,
        };
        delete reversal.reversedAt;
        delete reversal.reversalTransactionId;
        transaction.update(originalRef, {
          status: 'reversed',
          reversedAt: now,
          reversedBy: req.user.loginId || req.user.name || "",
          reversalTransactionId: reversal.transactionId,
        });
        transaction.set(reversalRef, reversal);
        transaction.set(stateRef, {
          ledgerBalance: updatedBalance,
          version: Number(state.version || 0) + 1,
          updatedAt: now,
        }, { merge: true });
        transaction.set(financeAudit.doc(), {
          action: 'finance_transaction_reversed',
          transactionId: original.transactionId,
          actor: req.user.loginId || req.user.name || "",
          actorRole: req.user.role,
          createdAt: now,
          before: original,
          after: reversal,
        });
        transaction.set(idemRef, { createdAt: now, response: reversal });
        return reversal;
      });
      res.status(201).json(response);
    } catch (error) {
      res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to reverse transaction.' });
    }
  },
);

// --- NOTIFICATIONS (EMAILJS PROXY) ---
app.post('/api/notifications/send-otp', loginRateLimit, async (req, res) => {
  try {
    const { toEmail, passcode, companyName, userName, expiryMinutes } = req.body;
    const serviceId = process.env.EMAILJS_SERVICE_ID;
    const templateId = process.env.EMAILJS_TEMPLATE_ID || "template_j6wca4f";
    const publicKey = process.env.EMAILJS_PUBLIC_KEY;
    const privateKey = process.env.EMAILJS_PRIVATE_KEY;
    if (!serviceId || !publicKey) {
      return res.status(503).json({ error: 'Email notifications are not configured.' });
    }

    const payload = {
      service_id: serviceId,
      template_id: templateId,
      user_id: publicKey,
      template_params: {
        email: toEmail,
        passcode,
        time: `${expiryMinutes || 10} minutes`,
        company_name: companyName,
        user_name: userName || "Team User",
      },
    };
    
    if (privateKey) payload.accessToken = privateKey;

    const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || "Failed to send OTP email.");
    }
    res.json({ success: true });
  } catch (error) {
    console.error("Email OTP error:", error);
    res.status(500).json({ error: "Failed to send email." });
  }
});

app.post('/api/notifications/send-customer-bill', authenticateToken, requirePermission('notifications.send'), async (req, res) => {
  try {
    const { toEmail, customerName, trackingId, lrNumber, loadingDate, vehicle, fromLocation, toLocation, material, weight, paymentMode, freight, advance } = req.body;
    
    const serviceId = process.env.EMAILJS_SERVICE_ID;
    const templateId = "template_pinwrjf";
    const publicKey = process.env.EMAILJS_PUBLIC_KEY;
    const privateKey = process.env.EMAILJS_PRIVATE_KEY;
    if (!serviceId || !publicKey) {
      return res.status(503).json({ error: 'Email notifications are not configured.' });
    }

    const balanceDue = Number(freight || 0) - Number(advance || 0);

    const payload = {
      service_id: serviceId,
      template_id: templateId,
      user_id: publicKey,
      template_params: {
        to_email: toEmail,
        customer_email: toEmail,
        customer_name: customerName,
        tracking_id: trackingId,
        lr_number: lrNumber || "Pending",
        loading_date: loadingDate,
        vehicle: vehicle,
        from_location: fromLocation,
        to_location: toLocation,
        material: material || "General Goods",
        weight: weight || "N/A",
        payment_mode: paymentMode,
        freight: Number(freight || 0).toLocaleString('en-IN'),
        advance: Number(advance || 0).toLocaleString('en-IN'),
        balance: balanceDue.toLocaleString('en-IN')
      },
    };
    if (privateKey) payload.accessToken = privateKey;

    const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || "Failed to send customer notification.");
    }
    res.json({ success: true });
  } catch (error) {
    console.error("Email notification error:", error);
    res.status(500).json({ error: "Failed to send email." });
  }
});

// GET /api/driver/locations
// Returns all active driver locations
app.get('/api/driver/locations', authenticateToken, requirePermission('tracking.read'), async (req, res) => {
  try {
    const snapshot = await db.collection('driver_locations').get();
    const locations = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));
    res.json(locations);
  } catch (error) {
    console.error("Error fetching driver locations:", error);
    res.status(500).json({ error: "Failed to load driver locations." });
  }
});

// GET /api/driver/location-history/:driverName
// Returns coordinate trace points logged in the last 24 hours
app.get('/api/driver/location-history/:driverName', authenticateToken, requirePermission('tracking.read'), async (req, res) => {
  try {
    const { driverName } = req.params;
    if (!driverName) {
      return res.status(400).json({ error: "Missing driverName parameter." });
    }

    // 24 hours ago timestamp
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const snapshot = await db.collection('driver_location_history')
        .where('driverName', '==', driverName)
        .where('timestamp', '>=', twentyFourHoursAgo)
        .get();

    const pathData = snapshot.docs
        .map(doc => {
          const data = doc.data();
          const timestamp = data.timestamp;
          return {
            lat: data.latitude,
            lng: data.longitude,
            time: timestamp && timestamp.toDate ? timestamp.toDate().toISOString() : (timestamp || ""),
          };
        });

    // Sort path points chronologically
    pathData.sort((a, b) => a.time.localeCompare(b.time));

    res.json(pathData);
  } catch (error) {
    console.error("Error fetching driver location history:", error);
    res.status(500).json({ error: "Failed to load location history." });
  }
});

// Run server
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`Backend server is running securely on port ${PORT}`);
});
