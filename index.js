require("dotenv").config();
const cors = require('cors');
const express = require("express");
const axios = require("axios");
const CryptoJS = require("crypto-js");
const { ethers } = require("ethers");

const app = express();
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self' http://localhost:3000 http://localhost:5000;");
  next();
});

/* ---------------- BLOCKCHAIN SETUP ---------------- */

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const abi = require("./contractABI.json");

const contract = new ethers.Contract(
  process.env.CONTRACT_ADDRESS,
  abi,
  wallet
);

/* ---------------- FIREBASE SETUP ---------------- */

// Ensure this does NOT have a trailing slash in your .env
const FIREBASE_DB = process.env.FIREBASE_DB_URL;
// Temporary storage (In a real app, use a database like MongoDB or Firebase)
let activeTransports = {};

app.post('/local-pickup', (req, res) => {
    const { batchId, transporter, location, time } = req.body;
    
    if (!batchId || !transporter) {
        return res.status(400).json({ error: "Missing pickup data" });
    }

    // Store the pickup details locally on the server
    activeTransports[batchId] = {
        transporter,
        pickupLocation: location,
        pickupTime: time,
        status: "In Transit"
    };

    console.log(`Driver ${transporter} picked up Batch ${batchId} at ${location}`);
    res.json({ success: true, message: "Pickup recorded in backend" });
});
// This route is specifically for the consumer page to read sensor data
app.get("/consumer-data/:batchId", async (req, res) => {
    try {
        const { batchId } = req.params;
        
        // 1. Fetch the raw data from your Firebase
        const fbUrl = `${process.env.FIREBASE_DB_URL}/vehicle_data/BATCH_${batchId}.json`;
        const response = await axios.get(fbUrl);
        const data = response.data;

        if (!data) {
            return res.status(404).json({ error: "No sensor data found for this batch" });
        }

        // 2. Calculate the averages (matching your aggregation logic)
        const temps = [];
        const hums = [];
        Object.values(data).forEach(r => {
            if (r.temperature_C !== undefined) temps.push(Number(r.temperature_C));
            if (r.humidity_pct !== undefined) hums.push(Number(r.humidity_pct));
        });

        // 3. Send the JSON back to the frontend
        res.json({
            avgTemp: (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(2),
            avgHumidity: (hums.reduce((a, b) => a + b, 0) / hums.length).toFixed(2)
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error fetching Firebase data" });
    }
});

/* ---------------- SENSOR AGGREGATION & ANCHORING ---------------- */

app.post("/aggregateAndAnchor", async (req, res) => {
  try {
    const { batchId } = req.body;

    if (!batchId) {
      return res.status(400).json({ error: "batchId is required (e.g., 8)" });
    }

    // 1. Fetch from Firebase using the REST API (.json)
    // Path matches your console: /vehicle_data/BATCH_8.json
    const firebaseURL = `${FIREBASE_DB}/vehicle_data/BATCH_${batchId}.json`;
    console.log(`📡 Fetching data from: ${firebaseURL}`);
    
    const response = await axios.get(firebaseURL);
    const rawData = response.data;

    if (!rawData) {
      return res.status(404).json({ error: `No data found for BATCH_${batchId}` });
    }

    // 2. Parse the Push IDs (The "-OiNe..." keys)
    const temps = [];
    const hums = [];
    let lastTimestamp = 0;

    // Firebase returns an object of objects: { "-ID1": {temp, hum}, "-ID2": {temp, hum} }
    Object.values(rawData).forEach((reading) => {
      if (reading.temperature_C !== undefined && reading.humidity_pct !== undefined) {
        temps.push(Number(reading.temperature_C));
        hums.push(Number(reading.humidity_pct));
        
        // Track the latest timestamp for the anchor record
        if (reading.local_timestamp_ms > lastTimestamp) {
          lastTimestamp = reading.local_timestamp_ms;
        }
      }
    });

    if (temps.length === 0) {
      return res.status(404).json({ error: "No valid temperature/humidity fields found in the records" });
    }

    // 3. Create Aggregated Summary
    const aggregate = {
      batchId: batchId.toString(),
      avgTemp: avg(temps).toFixed(2),
      avgHumidity: avg(hums).toFixed(2),
      minTemp: Math.min(...temps),
      maxTemp: Math.max(...temps),
      sampleCount: temps.length,
      periodEnd: lastTimestamp || Date.now()
    };

    // 4. Generate SHA-256 Hash
    const hash = CryptoJS.SHA256(JSON.stringify(aggregate)).toString();
    console.log(`🔒 Generated Hash: ${hash}`);

    // 5. Anchor to Blockchain
    console.log("🔗 Sending to Blockchain...");
    const tx = await contract.storeSensorHash(
      batchId, 
      hash, 
      aggregate.periodEnd
    );
    
    const receipt = await tx.wait();

    // 6. Final Response
    res.json({
      status: "SUCCESS",
      batchId,
      blockchainTx: receipt.hash,
      hash: hash,
      dataSummary: aggregate
    });

  } catch (err) {
    console.error("❌ Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- NEW PROXY ROUTE ---
// This prevents CORS errors and 403 blocks from Nominatim
app.get("/get-placename", async (req, res) => {
    const { lat, lng } = req.query;
    try {
        const response = await axios.get(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`, {
            headers: { 
                'User-Agent': 'SriLankaFoodTraceability/1.0 (Student Research Project)' 
            }
        });
        // We only send back the specific name to keep it simple
        const address = response.data.address;
        const displayName = address.amenity || address.shop || address.road || address.city || "Unknown Location";
        res.json({ name: displayName });
    } catch (e) {
        console.error("Geocoding Error:", e.message);
        res.status(500).json({ name: "Location Selected" });
    }
});

// --- UPDATED LOCATION UPDATE ---
app.post("/update-location", async (req, res) => {
    try {
        const { batchId, lat, lng } = req.body;
        
        // Log what we received to make sure the frontend is working
        console.log(`📥 Received: Batch ${batchId}, Lat ${lat}, Lng ${lng}`);

        if (!process.env.FIREBASE_DB_URL) {
            throw new Error("FIREBASE_URL is missing in your .env file!");
        }

        const url = `${process.env.FIREBASE_DB_URL}/batches/BATCH_${batchId}/route.json`;
        
        await axios.post(url, { 
            lat: parseFloat(lat), 
            lng: parseFloat(lng), 
            timestamp: Date.now() 
        });

        console.log("✅ Firebase updated successfully");
        res.sendStatus(200);

    } catch (error) {
        // THIS LOG WILL TELL YOU THE REAL PROBLEM:
        console.error("❌ BACKEND CRASHED:");
        console.error(error.message); 
        
        if (error.response) {
            console.error("Firebase Response Error:", error.response.data);
        }

        res.status(500).json({ error: error.message });
    }
});
/* ---------------- UTILS ---------------- */

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/* ---------------- SERVER ---------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend active on http://localhost:${PORT}`);
});