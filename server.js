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

    wss.on("connection", (ws) => {
        console.log("New client connected");

        ws.on("message", async (message) => {
            const data = JSON.parse(message);

            switch (data.type) {
                case "register": // Device registration
                    clients.set(data.deviceId, ws);

                    // Update the device status to "active" in the database
                    await devicesCollection.findOneAndUpdate(  
                        { deviceId: data.deviceId },
                        {
                            $set: {
                                status: "active",
                                lastActiveTime: new Date()
                            }
                        },
                        {
                            returnDocument: 'after' 
                        }
                    );

                    console.log(`Device ${data.deviceId} registered.`);
                    break;

                case "status": // Heartbeat (online/offline)
                    console.log(`Device ${data.deviceId} is ${data.status}`);
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

    // Status endpoint to check server status
    app.get("/status", (req, res) => {
        res.json({ status: "Remote Control Gateway is running", connectedClients: clients.size });
    });

    app.get("/devices/active", async (req, res) => {
        try {
            const db = await connectDB();
            const devicesCollection = db.collection('devices');
            
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
