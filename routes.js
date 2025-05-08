const express = require('express');
const router = express.Router();
const { connectDB } = require('./database/db');

module.exports = function(clients, approvedSessions, activeSessions) {
    // Status endpoint
    router.get("/status", (req, res) => {
        res.json({ 
            status: "Remote Control Gateway is running", 
            connectedClients: clients.size 
        });
    });

    // Get active devices
    router.get("/devices/active", async (req, res) => {
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

    // Get session logs for device
    router.get("/session/logs/:deviceId", async (req, res) => {
        const { deviceId } = req.params;
        try {
            const db = await connectDB();
            const sessionLogsCollection = db.collection('sessionLogs');
            const logs = await sessionLogsCollection.find({ deviceId }).toArray();
            res.json(logs);
        } catch (error) {
            console.error("Error fetching session logs:", error);
            res.status(500).json({ error: "Failed to fetch session logs" });
        }
    });

    // Deregister device
    router.post("/devices/deregister", async (req, res) => {
        const { deviceId, deregistrationKey } = req.body;
        
        if (!deviceId || !deregistrationKey) {
            return res.status(400).json({ error: "Missing required fields: deviceId, deregistrationKey" });
        }

        try {
            const db = await connectDB();
            const devicesCollection = db.collection('devices');
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

            res.status(200).json({ 
                message: `Device ${deviceId} deregistered successfully`,
                deviceRemoved: true,
                wsDisconnected: clients.has(deviceId)
            });
        } catch (error) {
            console.error("Error during device deregistration:", error);
            res.status(500).json({ error: "Internal server error" });
        }
    });

    // Remove test sessions
    router.post('/removeSessions', (req, res) => {
        const { token, deviceId } = req.body;

        if (!token) {
            return res.status(400).json({ 
                success: false, 
                message: 'Token is required.' 
            });
        }

        const removedFromApproved = approvedSessions.delete(deviceId);
        const removedFromActive = activeSessions.delete(token);

        res.json({
            success: true,
            message: 'Session cleanup completed',
            approvedSessionRemoved: removedFromApproved,
            activeSessionRemoved: removedFromActive
        });
    });

    return router;
};