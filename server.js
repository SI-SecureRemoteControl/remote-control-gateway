const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
//const https = require("https");
const http = require('http');
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const { verifySessionToken } = require("./utils/authSession");
const cors = require("cors");
const dotenv = require('dotenv');
const { logSessionEvent } = require("./utils/sessionLogger");
const archiver = require("archiver");
dotenv.config();

const activeSessions = new Map(); // Store sessionId with deviceId before admin approval
const approvedSessions = new Map(); // Store approved sessions

const { connectDB } = require("./database/db");
const { status } = require("migrate-mongo");
const app = express();
app.use(cors());
app.use(express.json());


//sprint 7
const UPLOAD_DIR = "/tmp/uploads";
const TEMP_DIR   = "/tmp/temp_uploads";

// 🛠️ Kreiraj direktorije ako ne postoje (kod će ih kreirati automatski pri startu)
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

// 📥 Multer za obradu fajlova
const upload = multer({ dest: TEMP_DIR });

let webAdminWs = new WebSocket('wss://backend-wf7e.onrender.com/ws/control/comm');

const HEARTBEAT_TIMEOUT = 600 * 1000;
const HEARTBEAT_CHECK_INTERVAL = 30 * 1000;

let clients = new Map(); // Store connected devices with their WebSocket connections
let lastHeartbeat = new Map(); //---2.task

function sendToDevice(deviceId, payload) {
    console.log("Broj klijenata:", clients.size, "->", Array.from(clients.keys()));
    const ws = clients.get(deviceId);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    } else {
        console.warn(`Device ${deviceId} not connected.`);
    }
}


async function connectToWebAdmin() {
    console.log((`Connecting to Web Admin at ${webAdminWs.url}`));

    webAdminWs = new WebSocket('wss://backend-wf7e.onrender.com/ws/control/comm');

    webAdminWs.on('open', () => {
        console.log('>>> COMM LAYER: Successfully connected to Web Admin WS (Backend)!');
    });

    webAdminWs.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('\nCOMM LAYER: Received message from Web Admin WS:', data);

            switch (data.type) {
                case "request_received":
                    console.log(`COMM LAYER: Backend acknowledged request for session ${data.sessionId}`);
                    logSessionEvent(data.sessionId, activeSessions.get(data.sessionId), data.type, "Backend acknowledged request for session.");
                    break;

                case "control_decision":
                    console.log("COMM LAYER: Processing control_decision from Backend.");
                    const { sessionId: decisionSessionId, decision, reason } = data;
                    const deviceId = activeSessions.get(decisionSessionId);

                    if (!deviceId) {
                        console.error(`COMM LAYER: Received control_decision for session ${decisionSessionId}, but couldn't find deviceId in activeSessions.`);
                        logSessionEvent(decisionSessionId, 'unknown', data.type, `Failed: Could not find active device for session.`);
                        return;
                    }

                    console.log(`COMM LAYER: Found deviceId ${deviceId} for session ${decisionSessionId}. Decision: ${decision}`);

                    if (decision === "accepted") {
                        console.log(`COMM LAYER: Sending 'approved' message to device ${deviceId}`);
                        sendToDevice(deviceId, {
                            type: "approved",
                            sessionId: decisionSessionId,
                            message: "Admin approved the session request."
                        });
                        logSessionEvent(decisionSessionId, deviceId, data.type, "Session approved by backend.");

                        if (!approvedSessions.has(deviceId)) {
                            approvedSessions.set(deviceId, new Set());
                        }
                        approvedSessions.get(deviceId).add("web-admin"); // Assuming "web-admin" is the peer identifier

                    } else {
                        console.log(`COMM LAYER: Sending 'rejected' message to device ${deviceId}`);
                        sendToDevice(deviceId, {
                            type: "rejected",
                            sessionId: decisionSessionId,
                            message: `Admin rejected the session request. Reason: ${reason || 'N/A'}`
                        });
                        logSessionEvent(decisionSessionId, deviceId, data.type, `Session rejected by backend. Reason: ${reason || 'N/A'}`);
                        activeSessions.delete(decisionSessionId);
                        const deviceApprovedPeers = approvedSessions.get(deviceId);
                        if (deviceApprovedPeers) {
                            deviceApprovedPeers.delete("web-admin"); // Remove potential peer added optimistically
                            if (deviceApprovedPeers.size === 0) {
                                approvedSessions.delete(deviceId);
                            }
                        }
                    }
                    break;

                // --- NEW CASE FOR SESSION TERMINATION ---
                case "session_terminated": {
                    console.log(`COMM LAYER: Processing session_terminated for session ${data.sessionId}`);
                    const { sessionId: terminatedSessionId, reason } = data;


                    let deviceIdForTermination = activeSessions.get(terminatedSessionId);

                    if (!deviceIdForTermination) {
                        console.warn(`COMM LAYER: Received termination for session ${terminatedSessionId}, but couldn't map it back to a deviceId in activeSessions. Ignoring notification to device, but cleaning up.`);
                        logSessionEvent(terminatedSessionId, 'unknown', data.type, `Termination received, but device mapping lost. Reason: ${reason || 'N/A'}`);
                        activeSessions.delete(terminatedSessionId); // Attempt cleanup anyway
                        return;
                    }

                    console.log(`COMM LAYER: Found deviceId ${deviceIdForTermination} for terminated session ${terminatedSessionId}. Reason: ${reason}`);
                    logSessionEvent(terminatedSessionId, deviceIdForTermination, data.type, `Session terminated by backend. Reason: ${reason || 'N/A'}`);

                    // --- Cleanup Logic ---
                    activeSessions.delete(terminatedSessionId);
                    console.log(`COMM LAYER: Deleted session ${terminatedSessionId} from activeSessions due to termination.`);

                    const deviceApprovedPeers = approvedSessions.get(deviceIdForTermination);
                    if (deviceApprovedPeers) {
                        const deleted = deviceApprovedPeers.delete("web-admin"); // Peer identifier
                        if (deleted) console.log(`COMM LAYER: Removed 'web-admin' peer from approvedSessions for device ${deviceIdForTermination}.`);

                        if (deviceApprovedPeers.size === 0) {
                            approvedSessions.delete(deviceIdForTermination);
                            console.log(`COMM LAYER: Removed device ${deviceIdForTermination} from approvedSessions as no peers remain.`);
                        }
                    } else {
                        console.log(`COMM LAYER: Device ${deviceIdForTermination} not found in approvedSessions during termination cleanup (might be normal).`);
                    }

                    // --- Notify Device ---
                    console.log(`COMM LAYER: Sending 'session_ended' message to device ${deviceIdForTermination}`);
                    sendToDevice(deviceIdForTermination, {
                        type: "session_ended",
                        sessionId: terminatedSessionId,
                        reason: reason || 'terminated_by_admin'
                    });
                    break;
                }

                // --- WebRTC Signaling Cases ---
                case "offer":
                case "answer":
                case "ice-candidate": {
                    const { fromId, toId, payload, type } = data;

                    if (!fromId || !toId || !payload) {
                        console.warn(`COMM LAYER: Received invalid signaling message (${type}). Missing fields. Data:`, data);
                        logSessionEvent(data.sessionId || 'unknown', fromId || 'unknown', type, `Invalid signaling message received from backend.`);
                        break;
                    }

                    console.log(`COMM LAYER: Relaying ${type} from backend peer (${fromId}) to device ${toId}`);
                    const target = clients.get(toId);

                    if (target && target.readyState === WebSocket.OPEN) {
                        target.send(JSON.stringify({ type, fromId, toId, payload }));
                    } else {
                        console.warn(`COMM LAYER: Target device ${toId} for ${type} not found or not connected.`);
                        logSessionEvent(data.sessionId || 'unknown', toId, type, `Failed relay to device (not found/connected). From: ${fromId}`);
                    }
                    break;
                }

                case "mouse_click": {
                    const { fromId, toId, sessionId, payload, type } = data;

                    if (!fromId || !toId || !payload) {
                        console.warn(`COMM LAYER: Received invalid click message (${type}). Missing fields. Data:`, data);
                        logSessionEvent(data.sessionId || 'unknown', fromId || 'unknown', type, `Invalid signaling message received from backend.`);
                        break;
                    }
                    
                    console.log(`COMM LAYER: Relaying ${type} from backend peer (${fromId}) to device ${toId}`);

                    const target = clients.get(toId);
                    if (target && target.readyState === WebSocket.OPEN) {
                        target.send(JSON.stringify({
                            type: "click",
                            toId,
                            fromId,
                            payload
                        }));
                        logSessionEvent(sessionId, toId, "mouse_click", `Mouse clicks on cordinates (${payload.x}, ${payload.y}) sent to device.`);
                    } else {
                        //ws.send(JSON.stringify({ type: "error", message: "Target device not connected." }));
                        logSessionEvent(sessionId, toId, "mouse_click", "Failed to send mouse input: device not connected.");
                    }

                    break;
                }


                case "keyboard": {
                    const { fromId, toId, sessionId, payload, type } = data;

                   //const { sessionId, key, code, type } = data;

                    if (!sessionId || !payload.key || !payload.code || !type) {
                        //ws.send(JSON.stringify({ type: "error", message: "Missing required fields for keyboard input." }));
                        console.warn(`COMM LAYER: Received invalid keyboard message (${type}). Missing fields. Data:`, data);
                        logSessionEvent(data.sessionId || 'unknown', fromId || 'unknown', type, `Invalid signaling message received from backend.`);
                        break;
                    }

                   /* const allowedPeers = approvedSessions.get(sessionId);
                    if (!allowedPeers || !allowedPeers.has(sessionId)) {
                        //ws.send(JSON.stringify({ type: "error", message: "Session not approved between devices." }));
                        logSessionEvent(sessionId, toId, "keyboard", "Unauthorized attempt to send keyboard input.");
                        break;
                    }
*/
                    console.log(`COMM LAYER: Relaying ${type} from backend peer (${fromId}) to device ${toId}`);

                    const target = clients.get(toId);
                    if (target && target.readyState === WebSocket.OPEN) {
                        target.send(JSON.stringify({
                            type: "keyboard",
                            toId,
                            fromId,
                            payload
                        }));
                        logSessionEvent(sessionId, toId, "keyboard", `Keyboard input (${type}) relayed.`);
                    } else {
                        //ws.send(JSON.stringify({ type: "error", message: "Target device not connected." }));
                        logSessionEvent(sessionId, toId, "keyboard", "Failed to send keyboard input: device not connected.");
                    }

                    break;
                }

                case "swipe": {
                    const { fromId, toId, sessionId, payload, type } = data;
                
                    if (!fromId || !toId || !payload) {
                        console.warn(`COMM LAYER: Received invalid swipe message (${type}). Missing fields. Data:`, data);
                        logSessionEvent(data.sessionId || 'unknown', fromId || 'unknown', type, `Invalid swipe message received from backend.`);
                        break;
                    }
                
                    console.log(`COMM LAYER: Relaying ${type} from backend peer (${fromId}) to device ${toId}`);
                
                    const target = clients.get(toId);
                    if (target && target.readyState === WebSocket.OPEN) {
                        target.send(JSON.stringify({
                            type: "swipe",
                            toId,
                            fromId,
                            payload
                        }));
                        logSessionEvent(
                            sessionId, 
                            toId, 
                            "swipe", 
                            `Swipe from (${payload.startX}, ${payload.startY}) to (${payload.endX}, ${payload.endY}) with velocity ${payload.velocity} sent to device.`
                        );
                    } else {
                        //ws.send(JSON.stringify({ type: "error", message: "Target device not connected." }));
                        logSessionEvent(sessionId, toId, "swipe", "Failed to send swipe input: device not connected.");
                    }
                
                    break;
                }





                //sprint 7
                case "decision_fileshare":{
                    console.log("COMM LAYER: Processing decision_fileshare from Backend.");
                    const { sessionId: decisionSessionId, decision } = data;
                    const deviceId = activeSessions.get(decisionSessionId);
                    

                    if (!deviceId) {
                        console.error(`COMM LAYER: Received control_decision for session ${decisionSessionId}, but couldn't find deviceId in activeSessions.`);
                        logSessionEvent(decisionSessionId, 'unknown', data.type, `Failed: Could not find active device for session.`);
                        return;
                    }

                    console.log(`COMM LAYER: Found deviceId ${deviceId} for session ${decisionSessionId}. Decision: ${decision}`);

                    if (decision) {
                        console.log(`COMM LAYER: Sending 'approved' message to device ${deviceId}`);
                        sendToDevice(deviceId, {
                            type: "fileshare_approved",
                            deviceId: deviceId,
                            sessionId: decisionSessionId,
                            message: "Admin approved the session fileshare."
                        });
                        logSessionEvent(decisionSessionId, deviceId, data.type, "Fileshare session approved by backend.");

                        if (!approvedSessions.has(deviceId)) {
                            approvedSessions.set(deviceId, new Set());
                        }
                        approvedSessions.get(deviceId).add("web-admin"); // Assuming "web-admin" is the peer identifier

                    } else {
                        console.log(`COMM LAYER: Sending 'rejected' message to device ${deviceId}`);
                        sendToDevice(deviceId, {
                            type: "fileshare_rejected",
                            deviceId: deviceId,
                            sessionId: decisionSessionId,
                            message: `Admin rejected the session fileshare request.`
                        });
                        logSessionEvent(decisionSessionId, deviceId, data.type, `Session rejected by backend.`);
                        activeSessions.delete(decisionSessionId);
                        const deviceApprovedPeers = approvedSessions.get(deviceId);
                        if (deviceApprovedPeers) {
                            deviceApprovedPeers.delete("web-admin"); // Remove potential peer added optimistically
                            if (deviceApprovedPeers.size === 0) {
                                approvedSessions.delete(deviceId);
                            }
                        }
                    }
                    break;
                }

                case "browse_request": {
                    console.log("COMM LAYER: Processing browse_request from Backend.");
                    const {sessionId, path} = data
                    const deviceId = activeSessions.get(sessionId);

                    sendToDevice(deviceId, {
                        type: "browse_request",
                        deviceId: deviceId,
                        sessionId: sessionId,
                        path: path
                    });
                    console.log(`COM_LAYER: browse_request to device ${deviceId}`);

                    if (!approvedSessions.has(deviceId)) {
                        approvedSessions.set(deviceId, new Set());
                    }
                    approvedSessions.get(deviceId).add("web-admin"); 

                    break;
                }




                
                default:
                    console.log(`COMM LAYER: Received unhandled message type from Web Admin WS: ${data.type}`);
                    logSessionEvent(data.sessionId || 'unknown', data.deviceId || 'unknown', data.type, "Unhandled message type from Web Admin WS.");
                    break;
            }

        } catch (error) {
            console.error('COMM LAYER: Error parsing message from Web Admin WS:', error);
            console.error('COMM LAYER: Raw message was:', message.toString ? message.toString() : message);
        }

    });

    webAdminWs.on('close', () => {
        // const reasonString = reason ? reason.toString() : 'N/A';
        //console.log(`!!! COMM LAYER: Web Admin WS Disconnected. Code: ${code}, Reason: ${reasonString}. Retrying in 5s...`); // Enhanced log
        // Clear listeners to avoid duplicates on retry if needed, although creating a new object handles this.
        setTimeout(connectToWebAdmin, 5000);
    });

    webAdminWs.on('error', (err) => {
        console.error('Web Admin WS Error:', err.message);
    });
}

async function startServer() {
    // Wait for DB connection before proceeding
    const db = await connectDB();
    const devicesCollection = db.collection('devices');

    const server = http.createServer(app);

    //const server = https.createServer(app);

    /*const server = https.createServer({
        key: fs.readFileSync("./certs/private.key"),
        cert: fs.readFileSync("./certs/certificate.crt")
    }, app);*/



    const wss = new WebSocket.Server({ server });

    wss.on("connection", (ws) => {
        console.log("New client connected");

        ws.on("message", async (message) => {
            const data = JSON.parse(message);

            console.log('\nReceived from device:', data);

            switch (data.type) {
                //prilikom registracije, generise se token koji se vraca uređaju za dalje interakcije
                case "register": // Device registration
                    const { deviceId, registrationKey } = data;

                    // Add device to the clients map
                    clients.set(deviceId, ws);

                    // Validate request payload
                    if (!deviceId || !registrationKey) {
                        ws.send(JSON.stringify({ type: "error", message: "Missing required fields: deviceId and/or registrationKey" }));
                        // return;
                    }

                    // Find device using this registrationKey
                    const existingDevice = await devicesCollection.findOne({ registrationKey });
                    if (!existingDevice) {
                        // If that device doesn't exist in DB, given registrationKey is invalid
                        ws.send(JSON.stringify({ type: "error", message: `Device with registration key ${registrationKey} doesn't exist.` }));
                        // return;
                    }

                    // If the registrationKey is used by another device, prevent hijack (switching devices)
                    if (existingDevice.deviceId && existingDevice.deviceId !== deviceId) {
                        ws.send(JSON.stringify({ type: "error", message: `Registration key ${registrationKey} is already assigned to another device.` }));
                        //  return;
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

                    lastHeartbeat.set(deviceId, new Date());

                    console.log(`Device ${deviceId} connected.`);

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

                    console.log(`[REGISTRATION] Generated JWT for device ${deviceId}: ${token}`);

                    console.log(`Device ${deviceId} registered.`);
                    ws.send(JSON.stringify({ type: "success", message: `Device registered successfully.`, token }));
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

                    break;


                
                //Device finalno salje potvrdu da prihvata sesiju i comm layer opet obavjestava web i tad pocinje
                case "session_final_confirmation":
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
                        break;
                    }

                    ws.send(JSON.stringify({ type: "session_confirmed", message: "Session successfully started between device and Web Admin." }));
                    logSessionEvent(finalToken, finalFrom, "session_start", "Session successfully started between device and Web Admin.");

                    break;

                case "offer":
                case "answer":
                case "ice-candidate": {
                    const { fromId, toId, payload, type } = data;

                    // Ako je cilj Web Admin, šaljemo Web Adminu
                    if (webAdminWs && webAdminWs.readyState === WebSocket.OPEN) {
                        webAdminWs.send(JSON.stringify({ type, fromId, toId, payload }));
                    }

                    // Ako je cilj drugi uređaj, šaljemo preko clients WS
                    const target = clients.get(toId);
                    if (target && target.readyState === WebSocket.OPEN) {
                        target.send(JSON.stringify({ type, fromId, toId, payload }));
                    } else {
                        console.warn(`Target ${toId} not connected as device (maybe it's the frontend).`);
                    }
                    break;
                }




                case "offer":
                case "answer":
                case "ice-candidate": {
                    const { fromId, toId, payload, type } = data;

                    const isFromAndroid = clients.get(fromId);

                    if (isFromAndroid && webAdminWs && webAdminWs.readyState === WebSocket.OPEN) {
                        webAdminWs.send(JSON.stringify({ type, fromId, toId, payload }));
                        break;
                    }

                    const target = clients.get(toId);

                    if (target && target.readyState === WebSocket.OPEN) {
                        target.send(JSON.stringify({ type, fromId, toId, payload }));
                    } else {
                        console.warn(`Target ${toId} not connected as device (maybe it's the frontend).`);
                    }
                    break;
                }





                //sprint 7
                case "request_session_fileshare":{
                    const { deviceId: from1, sessionId: token1 } = data;

                    clients.set(from1, ws);

                    console.log(`Session request from device ${from1} with token ${token1}`);

                    const reqDevice = await devicesCollection.findOne({ deviceId: from1});
                    if (!reqDevice) {
                        ws.send(JSON.stringify({ type: "error", message: "Device is not registered." }));
                        return;
                    }

                    const sessionUser = verifySessionToken(token1);
                    if (!sessionUser || sessionUser.deviceId !== from1) {
                        ws.send(JSON.stringify({ type: "error", message: "Invalid session token." }));
                        return;
                    }

                    activeSessions.set(token1, from1);

                    console.log(`\n\nSession request from device ${from1} with token ${token1}'\n\n`);

                    logSessionEvent(token1, from1, data.type, "Session request from android device.");

                    if (webAdminWs && webAdminWs.readyState === WebSocket.OPEN) {
                        console.log("Ja posaljem webu request od androida");

                        webAdminWs.send(JSON.stringify({
                            type: "request_session_fileshare",
                            sessionId: token1,
                            deviceId: from1,
                        }));

                        // Notify the device we forwarded the request
                        ws.send(JSON.stringify({ type: "info", message: "Session fileshare request forwarded to Web Admin.", sessionId: token1 }));
                    } else {
                        ws.send(JSON.stringify({ type: "error", message: "Web Admin not connected." }));
                        logSessionEvent(token1, from1, data.type, "Web Admin not connected.");
                    }

                    console.log("ActiveSessions: \n\n", activeSessions);
                    console.log("ApprovedSessions: \n\n", approvedSessions);

                    break;
                }


                case "browse_response":{
                    const { deviceId: from, sessionId: tokenn, path, entries } = data;

                    //clients.set(from, ws);

                    console.log(`Browse_response from device ${from} with token ${tokenn}`);

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

                    //activeSessions.set(tokenn, from);

                    console.log(`\n\nBrowse_responsefrom device ${from} with token ${tokenn}'\n\n`);

                    logSessionEvent(tokenn, from, data.type, "Browse_response from android device.");

                    if (webAdminWs && webAdminWs.readyState === WebSocket.OPEN) {
                        console.log("Ja posaljem webu browse_response od androida");

                        webAdminWs.send(JSON.stringify({
                            type: "browse_response",
                            deviceId: from,
                            sessionId: tokenn,
                            path: path,
                            entries: entries
                        }));

                        // Notify the device we forwarded the request
                        ws.send(JSON.stringify({ type: "info", message: "Browse_response forwarded to Web Admin.", sessionId: tokenn }));
                    } else {
                        ws.send(JSON.stringify({ type: "error", message: "Web Admin not connected." }));
                        logSessionEvent(tokenn, from, data.type, "Web Admin not connected.");
                    }

                    console.log("ActiveSessions: \n\n", activeSessions);
                    console.log("ApprovedSessions: \n\n", approvedSessions);

                    break;

                }




                /*case "remote_command": {
                    const { fromId, toId, command } = data;

                    const allowedPeers = approvedSessions.get(fromId);
                    if (!allowedPeers || !allowedPeers.has(toId)) {
                        ws.send(JSON.stringify({ type: "error", message: "Session not approved between devices." }));
                        logSessionEvent("unknown", fromId, "remote_command", "Unauthorized attempt to send remote command.");
                        return;
                    }

                    const target = clients.get(toId);
                    if (target && target.readyState === WebSocket.OPEN) {
                        target.send(JSON.stringify({
                            type: "remote_command",
                            fromId,
                            command
                        }));
                        logSessionEvent("unknown", toId, "remote_command", `Remote command relayed from ${fromId}.`);
                    } else {
                        ws.send(JSON.stringify({ type: "error", message: "Target Android device not connected." }));
                        logSessionEvent("unknown", toId, "remote_command", "Failed to send remote command: device not connected.");
                    }

                    break;
                }*/
            }

        });

        // Prethodni kod nije radio jer se koristio deviceId koji nije definisan u ovom scope-u
        ws.on("close", () => {
            console.log("Client disconnected");
            console.log("Klijenti: ", clients);
        });

        /*server.listen(443, () => {
            console.log("HTTPS server running on port 443");
        });*/

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

    // Endpoint to get session logs for a specific device
    app.get("/session/logs/:deviceId", async (req, res) => {
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
    })

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

    //temporary for removing test sessions
    app.post('/removeSessions', (req, res) => {
        const { token, deviceId } = req.body;

        if (!token) {
            return res.status(400).json({ success: false, message: 'Token is required.' });
        }

        const removedFromSessions = approvedSessions.delete(deviceId);
        const removedFromActiveSessions = activeSessions.delete(token);

        if (removedFromSessions || removedFromActiveSessions) {
            return res.status(200).json({ success: true, message: 'Session removed.' });
        } else {
            return res.status(404).json({ success: false, message: 'Session not found.' });
        }
    });

    //sprint 7

    // ─── POST /api/upload ───────────────────────────
    app.post("/api/upload", upload.array("files[]"), async (req, res) => {
        try {
        const { deviceId, sessionId, path: basePath } = req.body;
        const files = req.files;
        if (!deviceId || !sessionId || !basePath || !files?.length) {
            return res.status(400).json({ error: "Missing required fields." });
        }

        const cleanBase = basePath.replace(/^\/+/, "");
        const safeSessionId = sessionId.replace(/[^\w\-]/g, "_");
        const sessionFolder = path.join(UPLOAD_DIR, `session-${safeSessionId}`);
        await fs.promises.mkdir(sessionFolder, { recursive: true });

        for (const f of files) {
            const dest = path.join(sessionFolder, cleanBase, f.originalname);
            await fs.promises.mkdir(path.dirname(dest), { recursive: true });
            await fs.promises.rename(f.path, dest);
        }

        const zipName = `upload-${safeSessionId}.zip`;
        const zipPath = path.join(UPLOAD_DIR, zipName);

        await new Promise((resolve, reject) => {
            const output  = fs.createWriteStream(zipPath);
            const archive = archiver("zip", { zlib: { level: 9 } });

            output.on("close", resolve);
            archive.on("error", reject);

            archive.pipe(output);
            archive.directory(sessionFolder, false);
            archive.finalize();
        });

        await fs.promises.rm(sessionFolder, { recursive: true, force: true });

        const downloadUrl = `https://remote-control-gateway-production.up.railway.app/uploads/${zipName}`;

        sendToDevice(deviceId, {
            type:       "upload_files",
            deviceId,
            sessionId,
            downloadUrl,
            remotePath: cleanBase           // <── Android zna gdje raspakirati
        });

        return res.json({ message: "Upload complete. Android notified.", downloadUrl });

        } catch (err) {
        console.error("Upload error:", err);
        return res.status(500).json({ error: "Internal server error." });
        }

    }
    );

    
    // 📂 Omogući serviranje ZIP fajlova iz /uploads
    app.use("/uploads", express.static(UPLOAD_DIR));

    app.get("/download", async (req, res) => {





    });

    app.get("/debug/uploads", (req, res) => {
  fs.readdir(UPLOAD_DIR, (err, files) => {
    if (err) return res.status(500).json({ err: err.message });
    res.json(files);
  });
});



    const PORT = process.env.PORT || 8080;
    server.listen(PORT, () => {
        console.log("Server listening on port", PORT);
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




