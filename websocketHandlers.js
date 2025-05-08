// websocketHandlers.js
const jwt = require('jsonwebtoken');
const { verifySessionToken } = require("./utils/authSession");
const config = require('./config');

let devicesCollection;

function initialize(dbCollection) {
    devicesCollection = dbCollection;
}

function sendToDevice(deviceId, payload, clients) {
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
        return ws.send(JSON.stringify({ type: "error", message: "Missing required fields: deviceId and/or registrationKey" }));
    }

    const existingDevice = await devicesCollection.findOne({ registrationKey });
    if (!existingDevice) {
        return ws.send(JSON.stringify({ type: "error", message: `Device with registration key ${registrationKey} doesn't exist.` }));
    }

    if (existingDevice.deviceId && existingDevice.deviceId !== deviceId) {
        return ws.send(JSON.stringify({ type: "error", message: `Registration key ${registrationKey} is already assigned to another device.` }));
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

    await devicesCollection.findOneAndUpdate(
        { registrationKey },
        { $set: deviceData },
        { returnDocument: 'after' }
    );

    const token = jwt.sign({ deviceId }, config.JWT_SECRET);
    console.log(`[REGISTRATION] Generated JWT for device ${deviceId}: ${token}`);
    ws.send(JSON.stringify({ type: "success", message: `Device registered successfully.`, token }));
}

async function handleDeviceDeregistration(ws, data, clients) {
    const { deviceId, deregistrationKey } = data;

    if (!deviceId || !deregistrationKey) {
        return ws.send(JSON.stringify({ type: "error", message: "Missing required fields: deviceId, deregistrationKey" }));
    }

    const device = await devicesCollection.findOne({ deviceId });
    if (!device) {
        return ws.send(JSON.stringify({ type: "error", message: `Device not found.` }));
    }

    if (device.deregistrationKey !== deregistrationKey) {
        return ws.send(JSON.stringify({ type: "error", message: "Invalid deregistration key." }));
    }

    await devicesCollection.deleteOne({ deviceId });
    clients.delete(deviceId);
    ws.close();

    console.log(`Device ${deviceId} deregistered.`);
    ws.send(JSON.stringify({ type: "success", message: "Device deregistered successfully and removed from database." }));
}

async function handleDeviceStatus(ws, data, clients, lastHeartbeat) {
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
        return ws.send(JSON.stringify({ type: "error", message: "Session not approved between devices." }));
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

async function handleSessionRequest(ws, data, clients, activeSessions, webAdminWs, logSessionEvent) {
    const { from, token: tokenn } = data;

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

    logSessionEvent(tokenn, from, data.type, "Session request from android device.");

    if (webAdminWs && webAdminWs.readyState === WebSocket.OPEN) {
        console.log("Ja posaljem webu request od androida");
        webAdminWs.send(JSON.stringify({
            type: "request_control",
            sessionId: tokenn,
            deviceId: from,
            ovosesalje: "glupost"
        }));

        // Notify the device we forwarded the request
        ws.send(JSON.stringify({ type: "info", message: "Session request forwarded to Web Admin.", sessionId: tokenn }));
    } else {
        ws.send(JSON.stringify({ type: "error", message: "Web Admin not connected." }));
        logSessionEvent(tokenn, from, data.type, "Web Admin not connected.");
    }

    console.log("ActiveSessions: \n\n", activeSessions);
    console.log("ApprovedSessions: \n\n", approvedSessions);
}

async function handleSessionFinalConfirmation(ws, data, webAdminWs) {
    const { token: finalToken, from: finalFrom, decision } = data;

    console.log(`Session final confirmation from device ${finalFrom} with token ${finalToken} and decision ${decision}`);

    const reqDeviceFinal = await devicesCollection.findOne({ deviceId: finalFrom });
    if (!reqDeviceFinal) {
        ws.send(JSON.stringify({ type: "error", message: "Device is not registered." }));
        logSessionEvent(finalToken, finalFrom, data.type, "Device is not registered.");
        return;
    }

    const sessionUserFinal = verifySessionToken(finalToken);
    if (!sessionUserFinal || sessionUserFinal.deviceId !== finalFrom) {
        ws.send(JSON.stringify({ type: "error", message: "Invalid session token." }));
        logSessionEvent(finalToken, finalFrom, data.type, "Invalid session token.");
        return;
    }

    if (decision === "accepted") {
        webAdminWs.send(JSON.stringify({ type: "control_status", from: finalFrom, sessionId: finalToken, status: "connected" }));
        logSessionEvent(finalToken, finalFrom, data.type, "Session accepted by android device");
    }
    else if (decision === "rejected") {
        webAdminWs.send(JSON.stringify({ type: "control_status", from: finalFrom, sessionId: finalToken, status: "failed" }));
        logSessionEvent(finalToken, finalFrom, data.type, "Session rejected by android device");
    }

    ws.send(JSON.stringify({ type: "session_confirmed", message: "Session successfully started between device and Web Admin." }));
    logSessionEvent(finalToken, finalFrom, "session_start", "Session successfully started between device and Web Admin.");

}

function handleControlDecision(data, activeSessions, approvedSessions, clients) {
    const { sessionId, decision, reason } = data;
    const deviceId = activeSessions.get(sessionId);

    if (!deviceId) {
        return console.error(`No active session found for session ID ${sessionId}.`);
    }

    if (decision === "accepted") {
        sendToDevice(deviceId, {
            type: "approved",
            sessionId,
            message: "Admin approved the session request."
        }, clients);

        if (!approvedSessions.has(deviceId)) {
            approvedSessions.set(deviceId, new Set());
        }
        approvedSessions.get(deviceId).add("web-admin");
    } else {
        sendToDevice(deviceId, {
            type: "rejected",
            sessionId,
            message: `Admin rejected the session request. Reason: ${reason || 'N/A'}`
        }, clients);
        activeSessions.delete(sessionId);
    }
}


function handleWebRTCSignaling(ws, data, webAdminWs, clients) {
    const { fromId, toId, payload, type } = data;

    // Ako je cilj Web Admin, šaljemo Web Adminu
    if (toId === "web-admin" && webAdminWs && webAdminWs.readyState === WebSocket.OPEN) {
        webAdminWs.send(JSON.stringify({ type, fromId, toId, payload }));
    }

    // Ako je cilj drugi uređaj, šaljemo preko clients WS
    const target = clients.get(toId);
    if (target && target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify({ type, fromId, toId, payload }));
    } else {
        console.warn(`Target device ${toId} not connected or unavailable.`);
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
    handleControlDecision,
    handleWebRTCSignaling
};
