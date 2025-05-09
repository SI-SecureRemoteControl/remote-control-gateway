const express = require("express");
const http = require('http');
const WebSocket = require("ws");
const cors = require("cors");
const dotenv = require('dotenv');
const { logSessionEvent } = require("./utils/sessionLogger");
dotenv.config();

const {
    initialize: initializeWebSocketHandlers,
    handleDeviceRegistration,
    handleDeviceDeregistration,
    handleDeviceStatus,
    handleDeviceSignal,
    handleDeviceDisconnect,
    handleSessionRequest,
    handleSessionFinalConfirmation
} = require('./websocketHandlers');

const activeSessions = new Map();
const approvedSessions = new Map();
let clients = new Map();
let lastHeartbeat = new Map();

const { connectDB } = require("./database/db");
const { status } = require("migrate-mongo");
const app = express();
app.use(cors());
app.use(express.json());

const setupRoutes = require('./routes');

const HEARTBEAT_TIMEOUT = 600 * 1000;
const HEARTBEAT_CHECK_INTERVAL = 30 * 1000;


const connectToWebAdmin = require('./webAdminConnection');

async function startServer() {
    // Wait for DB connection before proceeding
    const db = await connectDB();
    let devicesCollection = db.collection('devices');
    initializeWebSocketHandlers(devicesCollection);

    const webAdminWs = connectToWebAdmin(activeSessions, approvedSessions, clients);

    const server = http.createServer(app);
    const wss = new WebSocket.Server({ server });

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
                case "offer":
                case "answer":
                case "ice-candidate":
                        handleWebRTCSignaling(ws, data, webAdminWs, clients);
                    break;
            }
        });

        ws.on("close", () => {
            console.log("Client disconnected");
            console.log("Klijenti: ", clients);
        });

    });

    // Periodically check for devices that are inactive for too long
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

                if (!lastSeen || now - lastSeen > HEARTBEAT_TIMEOUT) {
                    console.log(`Device ${deviceId} marked as inactive due to missing heartbeat.`);

                    // Mark the device as inactive in the database
                    await devicesCollection.findOneAndUpdate(
                        { deviceId },
                        {
                            $set: {
                                status: "inactive",
                                lastActiveTime: now
                            }
                        }
                    );

                    //    clients.delete(deviceId); // Remove from connected clients
                    lastHeartbeat.delete(deviceId); // Remove from heartbeat map
                    try {
                        ws.close(); // Close socket connection if still open
                    } catch (err) {
                        console.warn(`Error closing socket for ${deviceId}:`, err.message);
                    }
                }
            }
        };

        checkInactiveDevices();
    }, HEARTBEAT_CHECK_INTERVAL);

    app.use('/', setupRoutes(clients, approvedSessions, activeSessions));

    const PORT = process.env.PORT || 8081;
    server.listen(PORT, () => {
        console.log("Server listening on port", PORT);
    });
}

// Start the server with DB connection
startServer().catch((err) => {
    console.error("Error starting server:", err);
    process.exit(1); // Exit the process if there is an error
});






