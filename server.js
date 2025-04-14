const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const { verifySessionToken } = require("./utils/authSession");
const cors = require("cors");
const dotenv = require('dotenv');
dotenv.config();

const activeSessions = new Map(); // Store sessionId with deviceId before admin approval
const approvedSessions = new Map(); // Store approved sessions

const { connectDB } = require("./database/db");
const app = express();
app.use(cors());
app.use(express.json());

let webAdminWs = new WebSocket('wss://backend-wf7e.onrender.com/ws/control/comm');

const HEARTBEAT_TIMEOUT = 600 * 1000;
const HEARTBEAT_CHECK_INTERVAL = 30 * 1000;
const SERVER_STATE_LOG_INTERVAL = 300 * 1000; // Log server state every 5 minutes

let clients = new Map(); // Store connected devices with their WebSocket connections
let lastHeartbeat = new Map(); // Track device heartbeats

/**
 * Log current server state for debugging
 */
function logServerState() {
    console.log("\n==== SERVER STATE ====");
    console.log(`Connected clients: ${clients.size}`);
    console.log(`Active sessions: ${activeSessions.size}`);
    console.log(`Approved sessions: ${approvedSessions.size}`);
    
    console.log("Client devices:", Array.from(clients.keys()));
    console.log("Active sessions:", Object.fromEntries(activeSessions));
    console.log("Approved sessions:", Array.from(approvedSessions.entries()).map(
        ([deviceId, peers]) => [deviceId, Array.from(peers)]
    ));
    console.log("====================\n");
}

/**
 * Send message to a specific device
 */
function sendToDevice(deviceId, payload) {
    console.log("Broj klijenata:", clients.size); // Fixed: using Map.size property instead of function
    const ws = clients.get(deviceId);
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify(payload));
            return true;
        } catch (error) {
            console.error(`Error sending message to device ${deviceId}:`, error);
            return false;
        }
    } else {
        console.warn(`Device ${deviceId} not connected.`);
        return false;
    }
}

/**
 * Clean up device connections and sessions
 */
function cleanupDevice(deviceId) {
    // Remove from clients and heartbeat tracking
    clients.delete(deviceId);
    lastHeartbeat.delete(deviceId);
    
    // Clean up this device from all peer sessions
    for (const [otherDeviceId, peers] of approvedSessions.entries()) {
        if (peers.has(deviceId)) {
            peers.delete(deviceId);
            if (peers.size === 0) {
                approvedSessions.delete(otherDeviceId);
            }
        }
    }
    
    // Remove device's own approved sessions
    approvedSessions.delete(deviceId);
    
    // Clean up active sessions
    for (const [sessionId, sesDeviceId] of activeSessions.entries()) {
        if (sesDeviceId === deviceId) {
            activeSessions.delete(sessionId);
        }
    }
    
    console.log(`Cleaned up session info for device: ${deviceId}`);
}

/**
 * Connect to web admin websocket
 */
async function connectToWebAdmin() {
    console.log(`Connecting to Web Admin at ${webAdminWs.url}`);

    webAdminWs.on('open', () => {
        console.log('Connected to Web Admin');
    });

    webAdminWs.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('\nReceived from Web Admin:', data);

            switch (data.type) {
                // Web admin accepts/rejects requests and communicates back to the device
                case "control_status_update":
                    const { sessionId, deviceId, status, decision, reason } = data;
                    
                    console.log("control_status_update: ", data);
                    
                    // Get correct deviceId - either from message or from active sessions
                    const to = deviceId || activeSessions.get(sessionId);
                    
                    if (!to) {
                        console.warn(`No device found for session ${sessionId}`);
                        return;
                    }
                    
                    console.log(`Web Admin ${decision} session request with deviceId: ${to}.`);
                    
                    if (decision === "accepted") {
                        if (!approvedSessions.has(to)) {
                            approvedSessions.set(to, new Set());
                        }
                        approvedSessions.get(to).add("web-admin");
                        
                        // Notify the device about the approval
                        sendToDevice(to, { 
                            type: "approved", 
                            message: "Web Admin approved session request.",
                            sessionId: sessionId,
                            status: status || "pending_device_confirmation"
                        });
                    } else {
                        sendToDevice(to, { 
                            type: "rejected", 
                            message: `Web Admin rejected session request. Reason: ${reason || "unknown"}`,
                            sessionId: sessionId
                        });
                    }
                    break;

                case "request_control":
                    // This case is for handling direct control requests from the web admin
                    // Just log it for now as this is typically initiated by the device
                    console.log(`Got direct control request from Web Admin for device: ${data.deviceId}`);
                    break;

                default:
                    console.log(`Unhandled message type from Web Admin: ${data.type}`);
                    break;
            }
        } catch (error) {
            console.error('Error processing Web Admin message:', error);
            console.error('Raw message:', message.toString());
        }
    });

    webAdminWs.on('close', () => {
        console.log('Web Admin disconnected. Retrying...');
        setTimeout(connectToWebAdmin, 5000);
    });

    webAdminWs.on('error', (err) => {
        console.error('Web Admin WS Error:', err.message);
    });
}

/**
 * Start the server
 */
async function startServer() {
    // Wait for DB connection before proceeding
    const db = await connectDB();
    const devicesCollection = db.collection('devices');

    const server = http.createServer(app);
    const wss = new WebSocket.Server({ server });

    wss.on("connection", (ws) => {
        console.log("New client connected");
        let deviceId = null; // Track which device this socket belongs to

        ws.on("message", async (message) => {
            try {
                const data = JSON.parse(message);
                console.log('\nReceived from device:', data);
                
                // Update device ID if present in message
                if (data.deviceId || data.from) {
                    deviceId = data.deviceId || data.from;
                }

                switch (data.type) {
                    // Device registration
                    case "register":
                        const { deviceId: regDeviceId, registrationKey } = data;

                        // Validate request payload
                        if (!regDeviceId || !registrationKey) {
                            ws.send(JSON.stringify({ type: "error", message: "Missing required fields: deviceId and/or registrationKey" }));
                            return;
                        }

                        // Find device using this registrationKey
                        const existingDevice = await devicesCollection.findOne({ registrationKey });
                        if (!existingDevice) {
                            // If that device doesn't exist in DB, given registrationKey is invalid
                            ws.send(JSON.stringify({ type: "error", message: `Device with registration key ${registrationKey} doesn't exist.` }));
                            return;
                        }

                        // If the registrationKey is used by another device, prevent hijack (switching devices)
                        if (existingDevice.deviceId && existingDevice.deviceId !== regDeviceId) {
                            ws.send(JSON.stringify({ type: "error", message: `Registration key ${registrationKey} is already assigned to another device.` }));
                            return;
                        }

                        // Create device data with mandatory fields
                        const deviceData = {
                            deviceId: regDeviceId,
                            status: "active",
                            lastActiveTime: new Date(),
                        };

                        // Add optional fields dynamically
                        ["model", "osVersion", "networkType", "ipAddress", "deregistrationKey"].forEach(field => {
                            if (data[field]) deviceData[field] = data[field];
                        });
                        
                        // If name is missing, add it based on model or deviceId
                        if (!deviceData.name && existingDevice.name) {
                            deviceData.name = existingDevice.name;
                        }

                        // Clean up any existing connection for this device
                        if (clients.has(regDeviceId)) {
                            const existingWs = clients.get(regDeviceId);
                            if (existingWs !== ws && existingWs.readyState === WebSocket.OPEN) {
                                existingWs.close();
                                console.log(`Closed existing connection for device ${regDeviceId}`);
                            }
                        }

                        // Update tracking variables
                        deviceId = regDeviceId;
                        clients.set(regDeviceId, ws);
                        lastHeartbeat.set(regDeviceId, new Date());

                        console.log(`Device ${regDeviceId} connected.`);

                        // Update the device status to "active" in the database
                        await devicesCollection.findOneAndUpdate(
                            { registrationKey },
                            {
                                $set: deviceData
                            },
                            {
                                returnDocument: 'after',
                            }
                        );

                        const token = jwt.sign({ deviceId: regDeviceId }, process.env.JWT_SECRET);

                        console.log(`Device ${regDeviceId} registered.`);
                        ws.send(JSON.stringify({ type: "success", message: `Device registered successfully.`, token }));
                        break;

                    // Device deregistration
                    case "deregister":
                        // Validate request payload
                        if (!data.deviceId || !data.deregistrationKey) {
                            ws.send(JSON.stringify({ type: "error", message: "Missing required fields: deviceId, deregistrationKey" }));
                            return;
                        }

                        // Check if the device exists
                        const device = await devicesCollection.findOne({ deviceId: data.deviceId });
                        if (!device) {
                            ws.send(JSON.stringify({ type: "error", message: `Device not found.` }));
                            return;
                        }

                        // Validate the deregistration key
                        if (device.deregistrationKey !== data.deregistrationKey) {
                            ws.send(JSON.stringify({ type: "error", message: "Invalid deregistration key." }));
                            return;
                        }

                        // Remove the device from the database
                        await devicesCollection.deleteOne({ deviceId: data.deviceId });

                        // Clean up device connections and sessions
                        cleanupDevice(data.deviceId);
                        
                        // Close the WebSocket connection for this device
                        ws.send(JSON.stringify({ type: "success", message: `Device deregistered successfully and removed from database.` }));
                        ws.close();
                        
                        console.log(`Device ${data.deviceId} deregistered and removed from database.`);
                        break;

                    // Status update/heartbeat
                    case "status":
                        console.log(`Device ${data.deviceId} is ${data.status}`);
                        lastHeartbeat.set(data.deviceId, new Date());

                        // Ensure device is in clients map
                        if (!clients.has(data.deviceId)) {
                            clients.set(data.deviceId, ws);
                            deviceId = data.deviceId;
                        }

                        await devicesCollection.findOneAndUpdate(
                            { deviceId: data.deviceId },
                            {
                                $set: {
                                    status: data.status,
                                    lastActiveTime: new Date()
                                }
                            },
                            { returnDocument: 'after' }
                        );
                        break;

                    // Signal between devices
                    case "signal":
                        const { from: senderId, to: receiverId, payload } = data;

                        const allowedPeers = approvedSessions.get(senderId);
                        if (!allowedPeers || !allowedPeers.has(receiverId)) {
                            ws.send(JSON.stringify({ type: "error", message: "Session not approved between devices." }));
                            return;
                        }

                        const target = clients.get(receiverId);
                        if (target && target.readyState === WebSocket.OPEN) {
                            target.send(JSON.stringify({ type: "signal", from: senderId, payload }));
                        } else {
                            ws.send(JSON.stringify({ type: "error", message: `Target device ${receiverId} not connected or unavailable.` }));
                        }
                        break;

                    // Disconnect
                    case "disconnect":
                        await devicesCollection.findOneAndUpdate(
                            { deviceId: data.deviceId },
                            {
                                $set: {
                                    status: "inactive",
                                    lastActiveTime: new Date()
                                }
                            },
                            { returnDocument: 'after' }
                        );
                        
                        cleanupDevice(data.deviceId);
                        console.log(`Device ${data.deviceId} disconnected.`);
                        break;

                    // Session request
                    case "session_request":
                        const { from, token: tokenn } = data;

                        // Update connection tracking
                        deviceId = from;
                        clients.set(from, ws);

                        console.log(`Session request from device ${from} with token ${tokenn}`);

                        const reqDevice = await devicesCollection.findOne({ deviceId: from });
                        if (!reqDevice) {
                            ws.send(JSON.stringify({ type: "error", message: "Device is not registered." }));
                            return;
                        }

                        const sessionUser = verifySessionToken(tokenn);
                        if (!sessionUser || sessionUser.deviceId !== from) {
                            ws.send(JSON.stringify({ type: "error", message: "Invalid session token." }));
                            return;
                        }

                        activeSessions.set(tokenn, from);

                        console.log(`\n\nSession request from device ${from} with token ${tokenn}'\n\n`);

                        if (webAdminWs && webAdminWs.readyState === WebSocket.OPEN) {
                            console.log("Forwarding request to web admin");

                            // Match web backend expected format
                            webAdminWs.send(JSON.stringify({
                                type: "request_control",
                                sessionId: tokenn,
                                deviceId: from,
                                deviceName: reqDevice.name || reqDevice.model || from, // Use device name or model
                                timestamp: Date.now() // Add timestamp expected by web backend
                            }));

                            // Notify the device we forwarded the request
                            ws.send(JSON.stringify({ 
                                type: "info", 
                                message: "Session request forwarded to Web Admin.", 
                                sessionId: tokenn 
                            }));
                        } else {
                            ws.send(JSON.stringify({ type: "error", message: "Web Admin not connected." }));
                        }

                        logServerState(); // Log server state for debugging
                        break;

                    // Final session confirmation
                    case "session_final_confirmation":
                        const { token: finalToken, from: finalFrom, decision } = data;

                        console.log(`Session final confirmation from device ${finalFrom} with token ${finalToken} and decision ${decision}`);

                        const reqDeviceFinal = await devicesCollection.findOne({ deviceId: finalFrom });
                        if (!reqDeviceFinal) {
                            ws.send(JSON.stringify({ type: "error", message: "Device is not registered." }));
                            return;
                        }

                        const sessionUserFinal = verifySessionToken(finalToken);
                        if (!sessionUserFinal || sessionUserFinal.deviceId !== finalFrom) {
                            ws.send(JSON.stringify({ type: "error", message: "Invalid session token." }));
                            return;
                        }

                        // Send control status to web admin - match expected format
                        webAdminWs.send(JSON.stringify({ 
                            type: "control_status", 
                            from: finalFrom, 
                            sessionId: finalToken, 
                            status: decision === "accepted" ? "connected" : "failed" 
                        }));

                        ws.send(JSON.stringify({ 
                            type: "session_confirmed", 
                            message: "Session status updated between device and Web Admin.",
                            status: decision
                        }));
                        
                        logServerState(); // Log server state for debugging
                        break;

                    default:
                        console.log(`Unhandled message type from device: ${data.type}`);
                        break;
                }
            } catch (error) {
                console.error("Error processing message:", error);
                ws.send(JSON.stringify({ 
                    type: "error", 
                    message: "Server error processing your request." 
                }));
            }
        });

        // Handle device disconnection
        ws.on("close", () => {
            console.log("Client disconnected");
            
            // If we know which device this connection belongs to
            if (deviceId && clients.get(deviceId) === ws) {
                console.log(`Cleaning up disconnected device: ${deviceId}`);
                
                // Mark device as inactive in database
                devicesCollection.findOneAndUpdate(
                    { deviceId },
                    {
                        $set: {
                            status: "inactive",
                            lastActiveTime: new Date()
                        }
                    }
                ).catch(err => {
                    console.error(`Error updating device status for ${deviceId}:`, err);
                });
                
                // Clean up all device session data
                cleanupDevice(deviceId);
            } else {
                // If we don't know which device, search through all clients
                for (const [id, socket] of clients.entries()) {
                    if (socket === ws) {
                        console.log(`Found disconnected device: ${id}`);
                        
                        // Mark device as inactive in database
                        devicesCollection.findOneAndUpdate(
                            { deviceId: id },
                            {
                                $set: {
                                    status: "inactive",
                                    lastActiveTime: new Date()
                                }
                            }
                        ).catch(err => {
                            console.error(`Error updating device status for ${id}:`, err);
                        });
                        
                        // Clean up all device session data
                        cleanupDevice(id);
                        break;
                    }
                }
            }
            
            // Log updated server state
            logServerState();
        });
    });

    // Periodically check for devices that are inactive for too long
    setInterval(() => {
        const now = new Date();

        const checkInactiveDevices = async () => {
            for (const [deviceId, lastSeen] of lastHeartbeat.entries()) {
                if (lastSeen) {
                    console.log(`Device ${deviceId} last heartbeat received at ${lastSeen}`);
                    
                    if (now - lastSeen > HEARTBEAT_TIMEOUT) {
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

                        // Get the WebSocket connection
                        const ws = clients.get(deviceId);
                        
                        // Clean up device connections and sessions
                        cleanupDevice(deviceId);
                        
                        // Close socket connection if still open
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            try {
                                ws.close();
                            } catch (err) {
                                console.warn(`Error closing socket for ${deviceId}:`, err.message);
                            }
                        }
                    }
                } else {
                    console.log(`No heartbeat data for device ${deviceId}, removing from tracking`);
                    lastHeartbeat.delete(deviceId);
                }
            }
        };

        checkInactiveDevices().catch(err => {
            console.error("Error checking inactive devices:", err);
        });
    }, HEARTBEAT_CHECK_INTERVAL);

    // Periodically log server state for debugging
    setInterval(logServerState, SERVER_STATE_LOG_INTERVAL);

    // Status endpoint to check server status
    app.get("/status", (req, res) => {
        res.json({ 
            status: "Remote Control Gateway is running", 
            connectedClients: clients.size,
            activeSessions: activeSessions.size,
            approvedSessions: approvedSessions.size
        });
    });

    // Get active devices endpoint
    app.get("/devices/active", async (req, res) => {
        try {
            const activeDevices = await devicesCollection.find({ status: "active" }).toArray();
            res.json(activeDevices);
        } catch (error) {
            console.error("Error fetching active devices:", error);
            res.status(500).json({ error: "Failed to fetch active devices" });
        }
    });

    // Deregister device endpoint
    app.post("/devices/deregister", async (req, res) => {
        const { deviceId, deregistrationKey } = req.body;

        // Validate request payload
        if (!deviceId || !deregistrationKey) {
            return res.status(400).json({ error: "Missing required fields: deviceId, deregistrationKey" });
        }

        try {
            // Check if the device exists
            const device = await devicesCollection.findOne({ deviceId });
            if (!device) {
                return res.status(404).json({ error: `Device with ID ${deviceId} not found.` });
            }

            // Validate the deregistration key
            if (device.deregistrationKey !== deregistrationKey) {
                return res.status(400).json({ error: "Invalid deregistration key." });
            }

            // Remove the device from the database
            await devicesCollection.deleteOne({ deviceId });

            // Clean up device connections and sessions
            if (clients.has(deviceId)) {
                const ws = clients.get(deviceId);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.close();
                }
            }
            cleanupDevice(deviceId);

            console.log(`Device ${deviceId} deregistered and removed from database.`);
            res.status(200).json({ 
                message: `Device ${deviceId} deregistered successfully and removed from the database.` 
            });

        } catch (error) {
            console.error("Error during device deregistration:", error);
            res.status(500).json({ error: "Internal server error. Please try again later." });
        }
    });

    const PORT = process.env.PORT || 8080;
    server.listen(PORT, () => {
        console.log(`==> Your service is live 🎉 on port ${PORT}`);
    });
}

// Start the server with DB connection
startServer().catch((err) => {
    console.error("Error starting server:", err);
    process.exit(1); // Exit the process if there is an error
});

connectToWebAdmin().catch((err) => {
    console.error("Error connecting to web admin:", err);
    process.exit(1); // Exit the process if there is an error
});