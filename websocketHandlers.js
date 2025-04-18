// websocketHandlers.js
const jwt = require('jsonwebtoken');
const { verifySessionToken } = require("./utils/authSession");
const config = require('./config');

let devicesCollection; // Will be set during initialization

function initialize(dbCollection) {
    devicesCollection = dbCollection;
}

function sendToDevice(deviceId, payload, clients) {
    console.log("Broj klijenata:", clients);
    const ws = clients.get(deviceId);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    } else {
        console.warn(`Device ${deviceId} not connected.`);
    }
}

async function handleDeviceRegistration(ws, data, clients, lastHeartbeat) {
    const { deviceId, registrationKey } = data;

    clients.set(deviceId, ws);

    if (!deviceId || !registrationKey) {
        ws.send(JSON.stringify({ type: "error", message: "Missing required fields: deviceId and/or registrationKey" }));
    }

    const existingDevice = await devicesCollection.findOne({ registrationKey });
    if (!existingDevice) {
        ws.send(JSON.stringify({ type: "error", message: `Device with registration key ${registrationKey} doesn't exist.` }));
    }

    if (existingDevice.deviceId && existingDevice.deviceId !== deviceId) {
        ws.send(JSON.stringify({ type: "error", message: `Registration key ${registrationKey} is already assigned to another device.` }));
    }

    const deviceData = {
        deviceId,
        status: "active",
        lastActiveTime: new Date(),
    };

    ["model", "osVersion", "networkType", "ipAddress", "deregistrationKey"].forEach(field => {
        if (data[field]) deviceData[field] = data[field];
    });

    lastHeartbeat.set(deviceId, new Date());

    console.log(`Device ${deviceId} connected.`);

    await devicesCollection.findOneAndUpdate(
        { registrationKey },
        {
            $set: deviceData
        },
        {
            returnDocument: 'after',
        }
    );

    const token = jwt.sign({ deviceId }, config.JWT_SECRET);
    console.log(`[REGISTRATION] Generated JWT for device ${deviceId}: ${token}`);
    console.log(`Device ${deviceId} registered.`);
    ws.send(JSON.stringify({ type: "success", message: `Device registered successfully.`, token }));
}

async function handleDeviceDeregistration(ws, data, clients) {
    if (!data.deviceId || !data.deregistrationKey) {
        ws.send(JSON.stringify({ type: "error", message: "Missing required fields: deviceId, deregistrationKey" }));
        return;
    }

    const device = await devicesCollection.findOne({ deviceId: data.deviceId });
    if (!device) {
        ws.send(JSON.stringify({ type: "error", message: `Device not found.` }));
        return;
    }

    if (device.deregistrationKey !== data.deregistrationKey) {
        ws.send(JSON.stringify({ type: "error", message: "Invalid deregistration key." }));
        return;
    }

    await devicesCollection.deleteOne({ deviceId: data.deviceId });
    clients.delete(data.deviceId);
    ws.close();

    console.log(`Device ${data.deviceId} deregistered and removed from database.`);
    ws.send(JSON.stringify({ type: "success", message: `Device deregistered successfully and removed from database.` }));
}

async function handleDeviceStatus(ws, data, clients, lastHeartbeat) {
    console.log(`Device ${data.deviceId} is ${data.status}`);
    lastHeartbeat.set(data.deviceId, new Date());

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
}

async function handleDeviceSignal(ws, data, clients, approvedSessions) {
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
}

async function handleDeviceDisconnect(ws, data, clients) {
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
}

async function handleSessionRequest(ws, data, clients, activeSessions, webAdminWs) {
    const { from, token: tokenn } = data;

    clients.set(from, ws);

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
        console.log("Sending request to web admin from mobile device");

        webAdminWs.send(JSON.stringify({
            type: "request_control",
            sessionId: tokenn,
            deviceId: from,
            ovosesalje: "glupost"
        }));

        ws.send(JSON.stringify({ type: "info", message: "Session request forwarded to Web Admin.", sessionId: tokenn }));
    } else {
        ws.send(JSON.stringify({ type: "error", message: "Web Admin not connected." }));
    }
}

async function handleSessionFinalConfirmation(ws, data, webAdminWs) {
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

    if (decision === "accepted") {
        webAdminWs.send(JSON.stringify({ type: "control_status", from: finalFrom, sessionId: finalToken, status: "connected" }));
    }
    else if (decision === "rejected") {
        webAdminWs.send(JSON.stringify({ type: "control_status", from: finalFrom, sessionId: finalToken, status: "failed" }));
    }

    ws.send(JSON.stringify({ type: "session_confirmed", message: "Session successfully started between device and Web Admin." }));
}

function handleControlDecision(data, activeSessions, approvedSessions, clients) {
    console.log("COMM LAYER: Processing control_decision from Backend.");
    const { sessionId, decision } = data; 

    const deviceId = activeSessions.get(sessionId);

    if (!deviceId) {
        console.error(`COMM LAYER: Received control_decision for session ${sessionId}, but couldn't find deviceId in activeSessions.`);
        return;
    }

    console.log(`COMM LAYER: Found deviceId ${deviceId} for session ${sessionId}. Decision: ${decision}`);

    if (decision === "accepted") {
        console.log(`COMM LAYER: Sending 'approved' message to device ${deviceId}`);
        sendToDevice(deviceId, {
            type: "approved", 
            sessionId: sessionId,
            message: "Admin approved the session request."
        }, clients);

        if (!approvedSessions.has(deviceId)) {
            approvedSessions.set(deviceId, new Set());
        }
        approvedSessions.get(deviceId).add("web-admin"); 
    } else {
        console.log(`COMM LAYER: Sending 'rejected' message to device ${deviceId}`);
        sendToDevice(deviceId, {
            type: "rejected",
            sessionId: sessionId,
            message: `Admin rejected the session request. Reason: ${data.reason || 'N/A'}`
        }, clients);
        activeSessions.delete(sessionId);
    }
}

module.exports = {
    initialize,
    sendToDevice,
    handleDeviceRegistration,
    handleDeviceDeregistration,
    handleDeviceStatus,
    handleDeviceSignal,
    handleDeviceDisconnect,
    handleSessionRequest,
    handleSessionFinalConfirmation,
    handleControlDecision
};