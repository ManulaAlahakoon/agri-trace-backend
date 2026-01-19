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

        // A. Fetch Batch from Blockchain to get Pickup Time for Duration
        const batchData = await contract.batches(batchId);
        const pickupTimestamp = Number(batchData.transport.pickupTimestamp);
        const currentTimestamp = Math.floor(Date.now() / 1000);

        let duration = 0;
        if (pickupTimestamp > 0 && currentTimestamp > pickupTimestamp) {
            duration = currentTimestamp - pickupTimestamp;
        }

        // B. Fetch Trip Data from Firebase
        const firebaseURL = `${FIREBASE_DB}/vehicle_data/${vehicleId}.json`;
        const fbRes = await axios.get(firebaseURL);
        const rawData = fbRes.data;

        if (!rawData) return res.status(404).json({ error: "No sensor data found for this trip" });

        const temps = [], hums = [];
        Object.values(rawData).forEach(r => {
            if (r.temperature_C !== undefined) temps.push(Number(r.temperature_C));
            if (r.humidity_pct !== undefined) hums.push(Number(r.humidity_pct));
        });

        // C. Prepare the 'TransportSummary' Struct Object
        // We round to integers because Solidity uint256 doesn't handle decimals
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

        // D. Send Transaction to Blockchain
        // anchorTransportSummary(batchId, arrLat, arrLng, summaryStruct)
        console.log(`⚓ Anchoring Analytics for Batch ${batchId}...`);
        
        const tx = await contract.anchorTransportSummary(
            batchId,
            arrivalLat.toString(),
            arrivalLng.toString(),
            summaryStruct
        );
        
        const receipt = await tx.wait();
        console.log("✅ Verified on Chain. Hash:", receipt.hash);

        res.json({ 
            status: "ARRIVED", 
            tx: receipt.hash, 
            durationSeconds: duration,
            summary: summaryStruct 
        });

    } catch (err) {
        console.error("Anchoring Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Transporter Backend running on Port ${PORT}`));