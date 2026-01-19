require("dotenv").config();
const cors = require('cors');
const express = require("express");
const axios = require("axios");
const { ethers } = require("ethers");

const app = express();
app.use(cors());
app.use(express.json());

/* ---------------- BLOCKCHAIN SETUP ---------------- */
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const abi = require("./contractABI.json");
const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, abi, wallet);

const FIREBASE_DB = process.env.FIREBASE_DB_URL;

/* ---------------- 1. START JOURNEY (CLEAN LOGS) ---------------- */
// Logic: Clears old sensor data so the trip starts with a fresh log
app.post('/start-transport', async (req, res) => {
    const { batchId, vehicleId } = req.body;
    try {
        const deleteUrl = `${FIREBASE_DB}/vehicle_data/${vehicleId}.json`;
        await axios.delete(deleteUrl);

        console.log(`🚚 Trip Started: Logs cleared for ${vehicleId} (Batch ${batchId})`);
        res.json({ success: true, message: "IoT monitoring started fresh." });
    } catch (err) {
        console.error("Start Transport Error:", err.message);
        res.status(500).json({ error: "Failed to initialize trip logs" });
    }
});

app.post("/update-location", async (req, res) => {
    try {
        const { batchId, lat, lng } = req.body;
        
        if (!batchId || !lat || !lng) {
            return res.status(400).json({ error: "Missing GPS data" });
        }

        const gpsData = {
            lat: parseFloat(lat),
            lng: parseFloat(lng),
            timestamp: Date.now()
        };

        // 1. Append to the HISTORY (The Breadcrumb Trail)
        // This is for drawing the line on the map later
        const historyUrl = `${FIREBASE_DB}/batches/BATCH_${batchId}/route.json`;
        await axios.post(historyUrl, gpsData);

        // 2. Overwrite the LATEST (The Real-time Pin)
        // This is so the consumer portal can show a "Live" moving icon 
        // without downloading the whole route every 5 seconds.
        const latestUrl = `${FIREBASE_DB}/batches/BATCH_${batchId}/lastLocation.json`;
        await axios.put(latestUrl, gpsData);

        res.sendStatus(200);
    } catch (err) {
        console.error("GPS Logging Error:", err.message);
        res.status(500).json({ error: "Failed to log location" });
    }
});

/* ---------------- 2. PROXY GEOCAL (GPS to Name) ---------------- */
app.get("/get-placename", async (req, res) => {
    const { lat, lng } = req.query;
    try {
        const response = await axios.get(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`, {
            headers: { 'User-Agent': 'SriLankaFoodTrace/1.0' }
        });
        const addr = response.data.address;
        res.json({ name: addr.road || addr.suburb || addr.city || addr.town || "Point on Map" });
    } catch (e) {
        res.json({ name: "Location Selected" });
    }
});

/* ---------------- 3. AGGREGATION & FINAL ANCHORING ---------------- */
// Logic: Triggered when truck reaches destination (Geofence)
app.post("/aggregateAndAnchor", async (req, res) => {
    try {
        const { batchId, vehicleId, arrivalLat, arrivalLng } = req.body;

        // 1. Fetch Batch from Blockchain (to calculate trip duration)
        const batchData = await contract.batches(batchId);
        const pickupTimestamp = Number(batchData.transport.pickupTimestamp);
        const currentTimestamp = Math.floor(Date.now() / 1000);
        let duration = pickupTimestamp > 0 ? (currentTimestamp - pickupTimestamp) : 0;

        // 2. Fetch Sensor Data from Firebase
        const firebaseURL = `${FIREBASE_DB}/vehicle_data/${vehicleId}.json`;
        const fbRes = await axios.get(firebaseURL);
        const rawData = fbRes.data;

        if (!rawData) return res.status(404).json({ error: "No sensor data found" });

        const temps = [], hums = [];
        Object.values(rawData).forEach(r => {
            if (r.temperature_C !== undefined) temps.push(Number(r.temperature_C));
            if (r.humidity_pct !== undefined) hums.push(Number(r.humidity_pct));
        });

        // 3. Prepare the Summary Struct (Matches Solidity Order)
        const summaryStruct = {
            minTemperature: temps.length ? Math.round(Math.min(...temps)) : 0,
            averageTemperature: temps.length ? Math.round(temps.reduce((a, b) => a + b, 0) / temps.length) : 0,
            maxTemperature: temps.length ? Math.round(Math.max(...temps)) : 0,
            averageHumidity: hums.length ? Math.round(hums.reduce((a, b) => a + b, 0) / hums.length) : 0,
            travelDurationSeconds: duration,
            maxGForce: 0, 
            averageGForce: 0,
            vibrationIndex: 0,
            totalShockCount: 0,
            maxShockLatitude: arrivalLat.toString(),
            maxShockLongitude: arrivalLng.toString(),
            maxShockTimestamp: currentTimestamp
        };

        // 4. TRIGGER BLOCKCHAIN TRANSACTION (ASYNCHRONOUS)
        console.log(`⚓ Anchoring Batch ${batchId}...`);
        const tx = await contract.anchorTransportSummary(
            batchId,
            arrivalLat.toString(),
            arrivalLng.toString(),
            summaryStruct
        );

        // 5. SEND RESPONSE IMMEDIATELY (Avoids Render Timeout)
        const finalHash = tx.hash || tx.transactionHash || "Pending";
        res.json({ 
            status: "PROCESSING", 
            tx: finalHash, 
            summary: summaryStruct 
        });

        // 6. BACKGROUND TASKS: Wait for Blockchain & Clear Firebase
        tx.wait().then(async (receipt) => {
            console.log("✅ Block Mined:", receipt.transactionHash || receipt.hash);
            
            // Clean up Firebase so the truck is ready for the next batch
            await axios.delete(firebaseURL);
            console.log(`🧹 Firebase cleared for ${vehicleId}`);
        }).catch(err => console.error("Background Error:", err));

    } catch (err) {
        console.error("Backend Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Transporter Backend running on Port ${PORT}`));