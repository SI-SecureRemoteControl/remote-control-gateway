const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const dotenv = require('dotenv');
dotenv.config();
const jwt = require("jsonwebtoken");
const { verifySessionToken } = require("./utils/authSession");

const approvedSessions = new Map(); 

const { connectDB } = require("./database/db");
const app = express();
app.use(cors());
app.use(express.json());

const HEARTBEAT_TIMEOUT =  60 * 1000;
const HEARTBEAT_CHECK_INTERVAL = 30 * 1000;


async function startServer() {
    // Wait for DB connection before proceeding
    const db = await connectDB();
    const devicesCollection = db.collection('devices');

    const server = http.createServer(app);
    const wss = new WebSocket.Server({ server });

    const clients = new Map(); // Store connected devices/admins
    const lastHeartbeat = new Map(); //---2.task

    wss.on("connection", (ws) => {
        console.log("New client connected");

        ws.on("message", async (message) => {
            const data = JSON.parse(message);

                switch (data.type) {
                    //prilikom registracije, generise se token koji se vraca uređaju za dalje interakcije
                    case "register": // Device registration
                        const { deviceId, registrationKey } = data;
                    
                        // Validate request payload
                        if (!deviceId || !registrationKey) {
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
                        if (existingDevice.deviceId && existingDevice.deviceId !== deviceId) {
                            ws.send(JSON.stringify({ type: "error", message: `Registration key ${registrationKey} is already assigned to another device.` }));
                            return;
                        }

                        // Create device data with mandatory fields
                        const deviceData = {
                            deviceId,
                            status: "active",
                            lastActiveTime: new Date(),
                        };
                        
                        // Add optional fields dynamically
                        ["model", "osVersion", "networkType", "ipAddress", "deregistrationKey"].forEach(field => {
                            if (data[field]) deviceData[field] = data[field];
                        });

                        // Add device to the clients map
                        clients.set(deviceId, ws);
                        lastHeartbeat.set(deviceId, new Date());
                    
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

                        const token = jwt.sign({ deviceId }, process.env.JWT_SECRET);

                    
                        console.log(`Device ${deviceId} registered.`);
                        ws.send(JSON.stringify({ type: "success", message: `Device registered successfully.` , token}));
                        break;
                    //kod ostaje isti
                    case "deregister": // Device deregistration
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

                        // Disconnect the device by closing the WebSocket connection
                        clients.delete(data.deviceId); // Remove from connected clients
                        ws.close(); // Close the WebSocket connection for this device

                        console.log(`Device ${data.deviceId} deregistered and removed from database.`);

                        // Send success message
                        ws.send(JSON.stringify({ type: "success", message: `Device deregistered successfully and removed from database.` }));
                        break; 
                    //kod ostaje isti
                    case "status":
                        console.log(`Device ${data.deviceId} is ${data.status}`);
                        lastHeartbeat.set(data.deviceId, new Date());
                    
                        // Ensure device is in clients map
                        if (!clients.has(data.deviceId)) {
                            clients.set(data.deviceId, ws);
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
                    //provjerava se sesija prije slanja signala
                    case "signal":
                        const { from: senderId, to: receiverId, payload } = data;
                    
                        const allowedPeers = approvedSessions.get(senderId);
                        if (!allowedPeers || !allowedPeers.has(receiverId)) {
                            ws.send(JSON.stringify({ type: "error", message: "Session not approved between devices." }));
                            return;
                        }
                    
                        const target = clients.get(receiverId);
                        if (target) {
                            target.send(JSON.stringify({ type: "signal", from: senderId, payload }));
                        }
                        break;
                    //zasad nista
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
                        clients.delete(data.deviceId);
                        console.log(`Device ${data.deviceId} disconnected.`);
                        break;
                    //device salje request prema comm layeru koji to salje webu
                    case "session_request":
                        const { from, to, tokenn } = data;

                        const sessionUser = verifySessionToken(tokenn);
                        if (!sessionUser || sessionUser.deviceId !== from) {
                            ws.send(JSON.stringify({ type: "error", message: "Invalid session token." }));
                            return;
                        }

                        const targetWs = clients.get(to);
                        if (!targetWs) {
                            ws.send(JSON.stringify({ type: "error", message: "Target device not available." }));
                            return;
                        }

                        targetWs.send(JSON.stringify({ type: "session_confirm", from }));
                        break;
                    //web prihvata/odbija i to salje com layeru koji obavjestava device koji je trazio sesiju
                    case "session_confirm_response":
                        const { accepted, from1, to1} = data;
                    
                        if (accepted) {
                            if (!approvedSessions.has(to1)) {
                                approvedSessions.set(to1, new Set());
                            }
                            approvedSessions.get(to1).add(from);
                    
                            ws.send(JSON.stringify({ type: "success", message: `Session approved between ${to1} and ${from1}` }));
                    
                            const toWs = clients.get(to1);
                            if (toWs) {
                                toWs.send(JSON.stringify({ type: "session_approved", from: from1, to: to1 }));
                            }
                        } else {
                            ws.send(JSON.stringify({ type: "info", message: "Session denied." }));
                        }
                        break;
                    //Device finalno salje potvrdu da prihvata sesiju i comm layer opet obavjestava web i tad pocinje
                    case "session_final_confirmation":
                        const { finalToken, requester: finalFrom, responder: finalTo } = data;
                    
                        const sessionUserFinal = verifySessionToken(finalToken);
                        if (!sessionUserFinal || sessionUserFinal.deviceId !== finalFrom) {
                            ws.send(JSON.stringify({ type: "error", message: "Invalid session token." }));
                            return;
                        }
                    
                        const targetWsFinal = clients.get(finalTo);
                        if (!targetWsFinal) {
                            ws.send(JSON.stringify({ type: "error", message: "Target device not available." }));
                            return;
                        }

                        ws.send(JSON.stringify({ type: "session_confirmed", message: "Session successfully started between devices." }));
                    
                        targetWsFinal.send(JSON.stringify({ type: "session_started", from: finalFrom, to: finalTo }));
                    
                        break;
                            
                    
            }
        });

        ws.on("close", () => {
            for (const [key, set] of approvedSessions.entries()) {
                set.delete(deviceId);
            }
            approvedSessions.delete(deviceId);
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

                    clients.delete(deviceId); // Remove from connected clients
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

    // Status endpoint to check server status
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

    // Deregister device
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

            // Optionally remove the device from the WebSocket clients map and disconnect if needed
            if (clients.has(deviceId)) {
                const ws = clients.get(deviceId);
                ws.close();
                clients.delete(deviceId); // Remove from connected clients
            }

            console.log(`Device ${deviceId} deregistered and removed from database.`);
            res.status(200).json({ message: `Device ${deviceId} deregistered successfully and removed from the database.` });

        } catch (error) {
            console.error("Error during device deregistration:", error);
            res.status(500).json({ error: "Internal server error. Please try again later." });
        }
    });

    const PORT = process.env.PORT || 8080;
    server.listen(PORT, () => {
    });
}

// Start the server with DB connection
startServer().catch((err) => {
    console.error("Error starting server:", err);
    process.exit(1); // Exit the process if there is an error
});
