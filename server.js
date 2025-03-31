const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map(); // Store connected devices/admins

wss.on("connection", (ws) => {
    console.log("New client connected");

    ws.on("message", (message) => {
        const data = JSON.parse(message);

        switch (data.type) {
            case "register": // Device registration
                clients.set(data.deviceId, ws);
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
                clients.delete(data.deviceId);
                console.log(`Device ${data.deviceId} disconnected.`);
                break;
        }
    });

    ws.on("close", () => {
        console.log("Client disconnected");
    });
});

app.get("/status", (req, res) => {
    res.json({ status: "Remote Control Gateway is running", connectedClients: clients.size });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});