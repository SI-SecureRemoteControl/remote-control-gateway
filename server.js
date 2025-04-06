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

const HEARTBEAT_TIMEOUT = 60 * 1000;
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
                
                    // Store device details in the database
                    await devicesCollection.insertOne({
                        deviceId,
                        registrationKey,
                        name,
                        status: "active",
                        lastActiveTime: new Date(),
                    });
                
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

                case "status": // Heartbeat (online/offline)
                    console.log(`Device ${data.deviceId} is ${data.status}`);
                    lastHeartbeat.set(data.deviceId, new Date()); // --2.task

                    /*
                    Ahmed komentar:
                        Zar ne bi ovdje trebalo azurirati bazu, tako da se unutar nje azurira status na active kako bi se
                        uredjaj prikazao zajedno sa ostalim active uredjajima na endpointu /devices/active?
                        To cu i dodati ovdje odmah ispod, ako mislite da ne treba ovako, javite.
                    */

                    await devicesCollection.findOneAndUpdate(
                        { 
                            deviceId: data.deviceId,
                        },
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
