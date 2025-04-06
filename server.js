const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const dotenv = require('dotenv');
dotenv.config();

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
    const collections = await db.listCollections().toArray(); //IZBRISATI POSLIJE
    console.log("Collections in the database:");
    collections.forEach(collection => console.log(collection.name));

    const server = http.createServer(app);
    const wss = new WebSocket.Server({ server });

    const clients = new Map(); // Store connected devices/admins
    const lastHeartbeat = new Map(); //---2.task

    wss.on("connection", (ws) => {
        console.log("New client connected");

        ws.on("message", async (message) => {
            const data = JSON.parse(message);

            switch (data.type) {
                case "register": // Device registration
                    const { deviceId, registrationKey, name} = data;
                
                    // Validate request payload
                    if (!deviceId || !registrationKey || !name) {
                        ws.send(JSON.stringify({ type: "error", message: "Missing required fields: deviceId, registrationKey, name" }));
                        return;
                    }
                
                    // Check if the device is already registered
                    const existingDevice = await devicesCollection.findOne({ deviceId });
                    if (existingDevice) {
                        ws.send(JSON.stringify({ type: "error", message: `Device with ID ${deviceId} is already registered.` }));
                        return;
                    }

                    // Create device data with mandatory fields
                    const deviceData = {
                        deviceId,
                        registrationKey,
                        name,
                        status: "active",
                        lastActiveTime: new Date(),
                    };
                    
                    // Add optional fields dynamically
                    ["model", "osVersion", "networkType", "ipAddress", "deregistrationKey"].forEach(field => {
                        if (data[field]) deviceData[field] = data[field];
                    });

                    // Store device data in the database
                    await devicesCollection.insertOne(deviceData);

                    // Add device to the clients map
                    clients.set(deviceId, ws);
                    lastHeartbeat.set(deviceId, new Date());
                
                    // Update the device status to "active" in the database
                    await devicesCollection.findOneAndUpdate(
                        { deviceId },
                        {
                            $set: {
                                status: "active",
                                lastActiveTime: new Date(),
                            },
                        },
                        {
                            returnDocument: 'after',
                        }
                    );
                
                    console.log(`Device ${deviceId} registered.`);
                    ws.send(JSON.stringify({ type: "success", message: `Device ${deviceId} registered successfully.` }));
                    break;

                    case "deregister": // Device deregistration
                    // Validate request payload
                    if (!data.deviceId || !data.deregistrationKey) {
                        ws.send(JSON.stringify({ type: "error", message: "Missing required fields: deviceId, deregistrationKey" }));
                        return;
                    }
                
                    // Check if the device exists
                    const device = await devicesCollection.findOne({ deviceId: data.deviceId });
                    if (!device) {
                        ws.send(JSON.stringify({ type: "error", message: `Device with ID ${data.deviceId} not found.` }));
                        return;
                    }

                    console.log(`\n\ndevice.deregistrationKey: ${device.deregistrationKey} \n\n\ndata.deregistrationKey: ${data.deregistrationKey}`);
                
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
                    ws.send(JSON.stringify({ type: "success", message: `Device ${data.deviceId} deregistered successfully and removed from database.` }));
                    break; 

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
                    

                case "signal": // WebRTC signaling (offer, answer, ICE)
                    const target = clients.get(data.to);
                    if (target) {
                        target.send(JSON.stringify({ type: "signal", from: data.from, payload: data.payload }));
                    }
                    break;

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
            }
        });

        ws.on("close", () => {
            console.log("Client disconnected");
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
        console.log(`Server is running on port ${PORT}`);
    });
}

// Start the server with DB connection
startServer().catch((err) => {
    console.error("Error starting server:", err);
    process.exit(1); // Exit the process if there is an error
});
