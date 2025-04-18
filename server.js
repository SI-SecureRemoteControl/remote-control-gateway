// server.js
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const { connectDB } = require("./database/db");
const config = require('./config');
const {
    initialize: initializeWebSocketHandlers,
    handleDeviceRegistration,
    handleDeviceDeregistration,
    handleDeviceStatus,
    handleDeviceSignal,
    handleDeviceDisconnect,
    handleSessionRequest,
    handleSessionFinalConfirmation
} = require('/websocketHandlers');
const connectToWebAdmin = require('./webAdminConnection');

const app = express();
app.use(cors());
app.use(express.json());

const activeSessions = new Map();
const approvedSessions = new Map();
const clients = new Map();
const lastHeartbeat = new Map();

async function startServer() {
    const db = await connectDB();
    const devicesCollection = db.collection('devices');
    initializeWebSocketHandlers(devicesCollection);

    const server = http.createServer(app);
    const wss = new WebSocket.Server({ server });

    const webAdminWs = connectToWebAdmin(activeSessions, approvedSessions, clients);

    wss.on("connection", (ws) => {
        console.log("New client connected");

        ws.on("message", async (message) => {
            const data = JSON.parse(message);
            console.log('\nReceived from device:', data);

            switch (data.type) {
                case "register":
                    await handleDeviceRegistration(ws, data, clients, lastHeartbeat);
                    break;
                case "deregister":
                    await handleDeviceDeregistration(ws, data, clients);
                    break;
                case "status":
                    await handleDeviceStatus(ws, data, clients, lastHeartbeat);
                    break;
                case "signal":
                    await handleDeviceSignal(ws, data, clients, approvedSessions);
                    break;
                case "disconnect":
                    await handleDeviceDisconnect(ws, data, clients);
                    break;
                case "session_request":
                    await handleSessionRequest(ws, data, clients, activeSessions, webAdminWs);
                    break;
                case "session_final_confirmation":
                    await handleSessionFinalConfirmation(ws, data, webAdminWs);
                    break;
            }
        });

        ws.on("close", () => {
            console.log("Client disconnected");
            console.log('All connected clients:', Array.from(clients.keys()));
        });
    });

    setInterval(() => {
        const now = new Date();

        const checkInactiveDevices = async () => {
            for (const [deviceId, ws] of clients.entries()) {
                const lastSeen = lastHeartbeat.get(deviceId);

                if (lastSeen) {
                    console.log(`Device ${deviceId} last heartbeat received at ${lastSeen}`);
                } else {
                    console.log(`No heartbeat received for device ${deviceId}`);
                }

                if (!lastSeen || now - lastSeen > config.HEARTBEAT_TIMEOUT) {
                    console.log(`Device ${deviceId} marked as inactive due to missing heartbeat.`);

                    await devicesCollection.findOneAndUpdate(
                        { deviceId },
                        {
                            $set: {
                                status: "inactive",
                                lastActiveTime: now
                            }
                        }
                    );

                    lastHeartbeat.delete(deviceId);
                    try {
                        ws.close();
                    } catch (err) {
                        console.warn(`Error closing socket for ${deviceId}:`, err.message);
                    }
                }
            }
        };

        checkInactiveDevices();
    }, config.HEARTBEAT_CHECK_INTERVAL);

    app.get("/status", (req, res) => {
        res.json({ status: "Remote Control Gateway is running", connectedClients: clients.size });
    });

    app.get("/devices/active", async (req, res) => {
        try {
            const activeDevices = await devicesCollection.find({ status: "active" }).toArray();
            res.json(activeDevices);
        } catch (error) {
            console.error("Error fetching active devices:", error);
            res.status(500).json({ error: "Failed to fetch active devices" });
        }
    });

    app.post("/devices/deregister", async (req, res) => {
        const { deviceId, deregistrationKey } = req.body;

        if (!deviceId || !deregistrationKey) {
            return res.status(400).json({ error: "Missing required fields: deviceId, deregistrationKey" });
        }

        try {
            const device = await devicesCollection.findOne({ deviceId });
            if (!device) {
                return res.status(404).json({ error: `Device with ID ${deviceId} not found.` });
            }

            if (device.deregistrationKey !== deregistrationKey) {
                return res.status(400).json({ error: "Invalid deregistration key." });
            }

            await devicesCollection.deleteOne({ deviceId });

            if (clients.has(deviceId)) {
                const ws = clients.get(deviceId);
                ws.close();
                clients.delete(deviceId);
            }

            console.log(`Device ${deviceId} deregistered and removed from database.`);
            res.status(200).json({ message: `Device ${deviceId} deregistered successfully and removed from the database.` });

        } catch (error) {
            console.error("Error during device deregistration:", error);
            res.status(500).json({ error: "Internal server error. Please try again later." });
        }
    });

    app.post('/removeSessions', (req, res) => {
        const { token, deviceId } = req.body;
    
        if (!token) {
            return res.status(400).json({ success: false, message: 'Token is required.' });
        }
    
        const removedFromSessions = approvedSessions.delete(deviceId);
        const removedFromActiveSessions = activeSessions.delete(token);
    
        if (removedFromSessions || removedFromActiveSessions) {
            return res.status(200).json({ success: true, message: 'Session removed.' });
        } else {
            return res.status(404).json({ success: false, message: 'Session not found.' });
        }
    });

    server.listen(config.PORT, () => {
        console.log(`Server running on port ${config.PORT}`);
    });
}

startServer().catch((err) => {
    console.error("Error starting server:", err);
    process.exit(1);
});