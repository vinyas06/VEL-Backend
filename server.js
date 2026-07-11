import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getPartyFinancialSummary, getDriverMonthSummary } from './calculations.js';
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
app.use(express.json());

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
const JWT_SECRET = process.env.JWT_SECRET || 'super-secure-vel-jwt-secret-key';

// Hashing utility matching client SHA-256 logic
function sha256(value) {
  return crypto.createHash('sha256').update(String(value || "")).digest('hex');
}

// Environment static main admins configuration
const staticMainAdmins = [
  {
    username: "vinyas06",
    password: process.env.VINYAS_PASSWORD || "vinyas@123",
    name: "Vinyas",
    email: "vinyassharana06@gmail.com",
    role: "main_admin",
    roleLabel: "Main Admin"
  },
  {
    username: "shera75",
    password: process.env.SHERA_PASSWORD || "shera@123",
    name: "Shera Mohandas Kolalagiri",
    email: "mohandassharana06@gmail.com",
    role: "main_admin",
    roleLabel: "Main Admin"
  }
];

// Helper to normalize input fields
const normalizeEmail = (value = "") => value.trim().toLowerCase();
const normalizeLoginId = (value = "") => value.trim().toLowerCase();

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: "Access denied. No token provided." });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: "Invalid or expired session token." });
    }
    req.user = user;
    next();
  });
};

// --- AUTHENTICATION ENDPOINTS ---

// Login endpoint (replacing insecure client-side comparison)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { companyKey, username, password } = req.body;
    const safeLoginId = normalizeLoginId(username);

    if (!safeLoginId || !password) {
      return res.status(400).json({ error: "Username and password are required." });
    }

    // 1. Check for Static Environment Main Admins
    const matchingStaticAdmin = staticMainAdmins.find(
      adminUser => adminUser.username === safeLoginId && adminUser.password === password
    );

    if (matchingStaticAdmin && companyKey === 'vel') {
      const token = jwt.sign(
        {
          loginId: matchingStaticAdmin.username,
          email: matchingStaticAdmin.email,
          name: matchingStaticAdmin.name,
          role: matchingStaticAdmin.role,
          companyKey
        },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      return res.json({
        token,
        user: {
          loginId: matchingStaticAdmin.username,
          email: matchingStaticAdmin.email,
          name: matchingStaticAdmin.name,
          role: matchingStaticAdmin.role,
          roleLabel: matchingStaticAdmin.roleLabel,
          companyKey,
          companyName: "Veerashaiva Express Logistics"
        }
      });
    }

    // 2. Check portal_users collection
    const portalUserSnap = await db.collection('portal_users')
      .where('companyKey', '==', companyKey)
      .where('username', '==', safeLoginId)
      .limit(1)
      .get();

    if (!portalUserSnap.empty) {
      const portalUser = portalUserSnap.docs[0].data();
      
      if (!portalUser.passwordHash) {
        return res.status(400).json({ error: "Account configuration error. Please contact the main admin." });
      }

      const hashToCompare = sha256(password);
      if (hashToCompare !== portalUser.passwordHash) {
        return res.status(400).json({ error: "Invalid credentials." });
      }

      if (portalUser.status !== 'approved') {
        return res.status(403).json({
          error: portalUser.status === 'pending'
            ? "Your registration is waiting for main admin approval."
            : "This user is not approved to login."
        });
      }

      const token = jwt.sign(
        {
          loginId: portalUser.username,
          email: portalUser.email,
          name: portalUser.name,
          role: portalUser.role || portalUser.requestedRole || "admin",
          companyKey
        },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      return res.json({
        token,
        user: {
          loginId: portalUser.username,
          email: portalUser.email,
          name: portalUser.name,
          role: portalUser.role || portalUser.requestedRole || "admin",
          roleLabel: portalUser.role === 'admin' ? 'Secondary Admin' : portalUser.role === 'staff' ? 'Office Staff' : 'Operations Team',
          companyKey,
          companyName: portalUser.companyName
        }
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
      
      if (driver.password !== password) {
        return res.status(400).json({ error: "Invalid credentials." });
      }

      if (driver.status === 'inactive') {
        return res.status(403).json({ error: "Your driver account is inactive. Please contact the admin." });
      }

      const token = jwt.sign(
        {
          loginId: driver.driverLoginId || driver.phone,
          driverId: driverDoc.id,
          name: driver.name,
          role: "driver",
          companyKey
        },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      return res.json({
        token,
        user: {
          loginId: driver.driverLoginId || driver.phone,
          role: "driver",
          roleLabel: "Driver",
          driverId: driverDoc.id,
          name: driver.name,
          email: driver.email || "",
          companyKey,
          companyName: "Veerashaiva Express Logistics"
        }
      });
    }

    return res.status(400).json({ error: "Invalid credentials." });
  } catch (error) {
    console.error("Login route error:", error);
    res.status(500).json({ error: "Internal server error during authentication." });
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

    const passwordHash = sha256(password);
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
app.get('/api/driver/dashboard-data', authenticateToken, async (req, res) => {
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
app.get('/api/calculations/party/:partyName', authenticateToken, async (req, res) => {
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
});

// Calculate and return driver monthly salary summary securely
app.get('/api/calculations/driver-salary/:driverName/:month', authenticateToken, async (req, res) => {
  try {
    const { driverName, month } = req.params;

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

// --- NOTIFICATIONS (EMAILJS PROXY) ---
app.post('/api/notifications/send-otp', async (req, res) => {
  try {
    const { toEmail, passcode, companyName, userName, expiryMinutes } = req.body;
    const serviceId = process.env.EMAILJS_SERVICE_ID || "service_a6calsj";
    const templateId = process.env.EMAILJS_TEMPLATE_ID || "template_j6wca4f";
    const publicKey = process.env.EMAILJS_PUBLIC_KEY || "Sdse_3EftZpcPBPYC";
    const privateKey = process.env.EMAILJS_PRIVATE_KEY;

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

app.post('/api/notifications/send-customer-bill', async (req, res) => {
  try {
    const { toEmail, customerName, trackingId, lrNumber, loadingDate, vehicle, fromLocation, toLocation, material, weight, paymentMode, freight, advance } = req.body;
    
    const serviceId = process.env.EMAILJS_SERVICE_ID || "service_a6calsj";
    const templateId = "template_pinwrjf";
    const publicKey = process.env.EMAILJS_PUBLIC_KEY || "Sdse_3EftZpcPBPYC";
    const privateKey = process.env.EMAILJS_PRIVATE_KEY;

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

// GET /api/driver/location-history/:driverName
// Returns coordinate trace points logged in the last 24 hours
app.get('/api/driver/location-history/:driverName', async (req, res) => {
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
