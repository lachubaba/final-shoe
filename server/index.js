import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import PDFDocumentPkg from 'pdfkit-table';
const PDFDocument = PDFDocumentPkg.default || PDFDocumentPkg;
import admin from 'firebase-admin';
import { google } from 'googleapis';
import stream from 'stream';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = 'super-secret-cashbook-key-2026';
const USERNAME = 'fancyfootstyle';
const PASSWORD = 'omprakashvalecha';

let db = null;

// Initialize Firebase Admin
try {
  const serviceAccount = JSON.parse(fs.readFileSync('./serviceAccountKey.json', 'utf8'));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = admin.firestore();
  console.log("Firebase Admin Initialized successfully.");
} catch (error) {
  console.error("Warning: Failed to load serviceAccountKey.json.");
}

// Initialize Google Drive OAuth2 Client
let oauth2Client = null;
try {
  const oauthKeys = JSON.parse(fs.readFileSync('./oauth2.keys.json', 'utf8'));
  const web = oauthKeys.web || oauthKeys.installed;
  oauth2Client = new google.auth.OAuth2({
    clientId: web.client_id,
    clientSecret: web.client_secret,
    redirectUri: "http://127.0.0.1:3000/api/oauth2callback"
  });
  
  if (fs.existsSync('./tokens.json')) {
    const tokens = JSON.parse(fs.readFileSync('./tokens.json', 'utf8'));
    oauth2Client.setCredentials(tokens);
    console.log("Google Drive OAuth2 Initialized with saved tokens.");
  } else {
    console.log("Google Drive OAuth2 requires authentication. Please visit http://127.0.0.1:3000/api/auth");
  }
} catch (error) {
  console.error("Warning: Failed to load oauth2.keys.json.", error.message);
}

const drive = oauth2Client ? google.drive({ version: 'v3', auth: oauth2Client }) : null;

// OAuth Endpoints
app.get('/api/auth', (req, res) => {
  if (!oauth2Client) return res.status(500).send("OAuth2 client not configured. Check oauth2.keys.json");
  
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive.file'],
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/api/oauth2callback', async (req, res) => {
  const { code, error: authError } = req.query;
  
  if (authError) {
    return res.status(400).send(`Authentication failed: Google returned an error: ${authError}`);
  }
  
  if (!code) {
    return res.status(400).send("Authentication failed: No authorization code provided. Please start at /api/auth");
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync('./tokens.json', JSON.stringify(tokens));
    res.send("Authentication successful! You can close this tab and generate PDFs now.");
  } catch (error) {
    res.status(500).send("Authentication failed: " + error.message);
  }
});

// Middleware
function authenticateToken(req, res, next) {
  // Auth temporarily bypassed
  next();
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === USERNAME && password === PASSWORD) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/api/pdf/generate', authenticateToken, async (req, res) => {
  try {
    const { title, dateRange, transactions, summary, reportType } = req.body;
    
    if (!transactions || transactions.length === 0) {
      return res.status(400).json({ error: 'No data available for selected range' });
    }

    if (!oauth2Client || !fs.existsSync('./tokens.json')) {
      return res.status(500).json({ error: 'Google Drive is not authenticated. Please visit http://127.0.0.1:3000/api/auth first.' });
    }
    
    if (!drive || !db) {
      return res.status(500).json({ error: 'Google Drive or Firebase Admin not configured.' });
    }
    
    // Create Document
    const doc = new PDFDocument({ margin: 50 });
    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    
    // Header
    doc.fontSize(22).text('Shop Report', { align: 'center' });
    doc.moveDown();
    doc.fontSize(14).text(`Report: ${title}`);
    doc.fontSize(12).text(`Date: ${dateRange}`);
    doc.moveDown(2);
    
    // Summary Section
    doc.fontSize(14).text('Summary', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(12).text(`Total Incoming: Rs. ${summary.incoming}`);
    doc.text(`Total Outgoing: Rs. ${summary.outgoing}`);
    doc.text(`Net Balance: Rs. ${summary.net}`);
    doc.moveDown(2);
    
    // Table
    const tableData = {
      title: "Transactions",
      headers: ["Date", "Type", "Amount", "Note"],
      rows: transactions.map(tx => [
        new Date(tx.timestamp).toLocaleString(),
        String(tx.type || ""),
        `Rs. ${tx.amount || 0}`,
        String(tx.note || (tx.referenceName ? `Ref: ${tx.referenceName}` : "-"))
      ]),
    };

    await doc.table(tableData);
    
    // Finalize
    doc.end();
    
    // Wait for buffer
    await new Promise(resolve => doc.on('end', resolve));
    const pdfData = Buffer.concat(buffers);
    
    // File Paths
    const now = new Date();
    const isMonthly = reportType === "monthly";
    const prefix = isMonthly ? `monthly-${now.getFullYear()}-${String(now.getMonth()+1).padStart(2, '0')}` : `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const fileName = `${prefix}-${Date.now()}.pdf`;
    
    
    // Upload to Google Drive
    const bufferStream = new stream.PassThrough();
    bufferStream.end(pdfData);

    const driveResponse = await drive.files.create({
      requestBody: {
        name: fileName,
        mimeType: 'application/pdf',
        parents: ["1UgtWJZOKR5m6SFiKSjhPVJF7h_I8_iat"]
        // parents: ['YOUR_FOLDER_ID']  Uncomment and add your folder ID here to put it in a specific folder
      },
      media: {
        mimeType: 'application/pdf',
        body: bufferStream,
      },
      fields: 'id, webViewLink, webContentLink',
    });

    const fileId = driveResponse.data.id;
    
    // Make file accessible to anyone with link
    await drive.permissions.create({
      fileId: fileId,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });

    // Refresh to get updated links
    const updatedFile = await drive.files.get({
      fileId: fileId,
      fields: 'webViewLink, webContentLink',
    });

    const downloadUrl = updatedFile.data.webViewLink;
    
    try {
      await db.collection('reports').add({
        fileName: fileName.replace('reports/', ''),
        driveLink: downloadUrl,
        dateRange: dateRange,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (dbError) {
      console.error("Warning: Failed to save metadata to Firestore:", dbError.message);
      // Continue anyway so the user gets their PDF
    }
    
    res.json({ url: downloadUrl, fileName });
  } catch (error) {
    console.error('Error generating PDF:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to generate PDF',
      stack: error.stack 
    });
  }
});

const PORT = 3000;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Cashbook Server running on http://127.0.0.1:${PORT}`);
});
