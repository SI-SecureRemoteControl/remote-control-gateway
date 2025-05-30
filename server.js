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

const CONFIG_PATH = path.join(__dirname, 'config.json');   //9.sprint

const defaultConfig = {  //9.sprint
  inactiveTimeout: 300,      // 5 minutes default    9.sprint
  maxSessionDuration: 3600   // 60 minutes default   9.sprint
}; //9.sprint

function ensureConfigFile() {//9.sprint
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
    console.log('config.json created with default values.');
  } else {
    console.log('config.json already exists.');
  }
}//9.sprint

function loadConfig() {//9.sprint
  try {
    const raw = fs.readFileSync(CONFIG_PATH);
    return JSON.parse(raw);
  } catch (error) {
    console.error('Failed to load config.json, using default config.', error);
    return defaultConfig;
  }
}//9.sprint

ensureConfigFile();//9.sprint
let sessionConfig = loadConfig();//9.sprint

const timeout = sessionConfig.inactiveTimeout;  //9.sprint
const maxDuration = sessionConfig.maxSessionDuration;  //9.sprint

const activeSessions = new Map(); // Store sessionId with deviceId before admin approval
const approvedSessions = new Map(); // Store approved sessions
const sessionActivity = new Map(); // Track last activity for each session

const { connectDB } = require("./database/db");
const { status } = require("migrate-mongo");
const app = express();
app.use(cors());
app.use(express.json());


//sprint 7
const UPLOAD_DIR = "/tmp/uploads";
const TEMP_DIR = "/tmp/temp_uploads";

// 🛠️ Kreiraj direktorije ako ne postoje (kod će ih kreirati automatski pri startu)
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

// 📥 Multer za obradu fajlova
const upload = multer({ dest: TEMP_DIR });

// Za produkciju
//let webAdminWs = new WebSocket('wss://backend-wf7e.onrender.com/ws/control/comm');   9.sprint
if (!process.env.WEBSOCKET_URL) {  //9.sprint
  console.error('Missing WEBSOCKET_URL in environment variables!'); //9.sprint
  process.exit(1);  //9.sprint
} //9.sprint
let webAdminWs = new WebSocket(process.env.WEBSOCKET_URL);  //9.sprint

//const HEARTBEAT_TIMEOUT = 600 * 1000;  sklonjeno 9.sprint
const HEARTBEAT_CHECK_INTERVAL = 30 * 1000; 

const heartbeat_timeout = (sessionConfig.inactiveTimeout || 600) * 1000;
const SESSION_INACTIVITY_TIMEOUT = 1.5 * 60 * 1000; // 1.5 minutes inactivity timeout
const INACTIVITY_CHECK_INTERVAL = 60 * 1000; // Check every minute

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

// sprint 8
function updateSessionActivity(sessionId) {
    if (sessionId) {
        sessionActivity.set(sessionId, Date.now());
    }
}

async function connectToWebAdmin() {
    console.log((`Connecting to Web Admin at ${webAdminWs.url}`));

    // webAdminWs = new WebSocket('wss://backend-wf7e.onrender.com/ws/control/comm');
    //webAdminWs = new WebSocket('wss://backend-wf7e.onrender.com/ws/control/comm');   9.sprint

    if (!process.env.WEBSOCKET_URL) {  //9.sprint
  console.error('Missing WEBSOCKET_URL in environment variables!'); //9.sprint
  process.exit(1);  //9.sprint
} //9.sprint

     webAdminWs = new WebSocket(process.env.WEBSOCKET_URL);   //9.sprint
    webAdminWs.on('open', () => {
        console.log('>>> COMM LAYER: Successfully connected to Web Admin WS (Backend)!');
    });

    webAdminWs.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('\nCOMM LAYER: Received message from Web Admin WS:', data);

            // Update session activity for any message     sprint 8
            if (data.sessionId) {
                updateSessionActivity(data.sessionId);
            }

            switch (data.type) {
                case "request_received":
                    console.log(`COMM LAYER: Backend acknowledged request for session ${data.sessionId}`);
                    logSessionEvent(data.sessionId, activeSessions.get(data.sessionId), data.type, "Backend acknowledged session request from device");
                    break;

                case "control_decision":
                    console.log("COMM LAYER: Processing control_decision from Backend.");
                    const { sessionId: decisionSessionId, decision, reason } = data;
                    const deviceId = activeSessions.get(decisionSessionId);

                    if (!deviceId) {
                        console.error(`COMM LAYER: Received control_decision for session ${decisionSessionId}, but couldn't find deviceId in activeSessions.`);
                        logSessionEvent(decisionSessionId, 'unknown', data.type, `Control decision failed: Could not find active device for session`);
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
                        logSessionEvent(decisionSessionId, deviceId, data.type, `Session approved by web admin. Device notified.`);

                        if (!approvedSessions.has(deviceId)) {
                            approvedSessions.set(deviceId, new Set());
                        }
                        approvedSessions.get(deviceId).add("web-admin");
                        updateSessionActivity(decisionSessionId);  //sprint 8

                    } else {
                        console.log(`COMM LAYER: Sending 'rejected' message to device ${deviceId}`);
                        sendToDevice(deviceId, {
                            type: "rejected",
                            sessionId: decisionSessionId,
                            message: `Admin rejected the session request. Reason: ${reason || 'N/A'}`
                        });
                        logSessionEvent(decisionSessionId, deviceId, data.type, `Session rejected by web admin. Reason: ${reason || 'No reason provided'}`);
                        activeSessions.delete(decisionSessionId);
                        sessionActivity.delete(decisionSessionId); //sprint 8
                        const deviceApprovedPeers = approvedSessions.get(deviceId);
                        if (deviceApprovedPeers) {
                            deviceApprovedPeers.delete("web-admin");
                            if (deviceApprovedPeers.size === 0) {
                                approvedSessions.delete(deviceId);
                            }
                        }
                    }
                    break;

                case "session_terminated": {
                    console.log(`COMM LAYER: Processing session_terminated for session ${data.sessionId}`);
                    const { sessionId: terminatedSessionId, reason } = data;

                    let deviceIdForTermination = activeSessions.get(terminatedSessionId);

                    if (!deviceIdForTermination) {
                        console.warn(`COMM LAYER: Received termination for session ${terminatedSessionId}, but couldn't map it back to a deviceId in activeSessions.`);
                        logSessionEvent(terminatedSessionId, 'unknown', "session_end", `Session termination received but device mapping lost. Reason: ${reason || 'No reason provided'}`);
                        activeSessions.delete(terminatedSessionId);
                        sessionActivity.delete(terminatedSessionId); //sprint 8
                        return;
                    }

                    console.log(`COMM LAYER: Found deviceId ${deviceIdForTermination} for terminated session ${terminatedSessionId}. Reason: ${reason}`);
                    logSessionEvent(terminatedSessionId, deviceIdForTermination, "session_end", `Session terminated by web admin. Reason: ${reason || 'No reason provided'}`);

                    // Cleanup Logic
                    activeSessions.delete(terminatedSessionId);
                    sessionActivity.delete(terminatedSessionId); //sprint 8
                    console.log(`COMM LAYER: Deleted session ${terminatedSessionId} from activeSessions due to termination.`);

                    const deviceApprovedPeers = approvedSessions.get(deviceIdForTermination);
                    if (deviceApprovedPeers) {
                        const deleted = deviceApprovedPeers.delete("web-admin");
                        if (deleted) console.log(`COMM LAYER: Removed 'web-admin' peer from approvedSessions for device ${deviceIdForTermination}.`);

                        if (deviceApprovedPeers.size === 0) {
                            approvedSessions.delete(deviceIdForTermination);
                            console.log(`COMM LAYER: Removed device ${deviceIdForTermination} from approvedSessions as no peers remain.`);
                        }
                    }

                    console.log(`COMM LAYER: Sending 'session_ended' message to device ${deviceIdForTermination}`);
                    sendToDevice(deviceIdForTermination, {
                        type: "session_ended",
                        sessionId: terminatedSessionId,
                        reason: reason || 'terminated_by_admin'
                    });
                    break;
                }

                case "offer":
                case "answer":
                case "ice-candidate": {
                    const { fromId, toId, payload, type } = data;

                    let sessionId = null;
                    for (const [token, deviceId] of activeSessions.entries()) {
                        if (deviceId === toId) {
                            sessionId = token;
                            break;
                        }
                    }

                    if (!fromId || !toId || !payload) {
                        console.warn(`COMM LAYER: Received invalid signaling message (${type}). Missing fields.`);
                        logSessionEvent(sessionId || 'unknown', fromId || 'unknown', type, `Invalid WebRTC signaling message received from web admin - missing required fields`);
                        break;
                    }

                    console.log(`COMM LAYER: Relaying WebRTC ${type} from web admin (${fromId}) to device ${toId}`);
                    const target = clients.get(toId);

                    if (target && target.readyState === WebSocket.OPEN) {
                        target.send(JSON.stringify({ type, fromId, toId, payload }));
                        //sprint 8
                        logSessionEvent(sessionId || 'ice_candidate', toId, type, `WebRTC ${type} relayed from web admin to device successfully`);
                        updateSessionActivity(sessionId);
                    } else {
                        console.warn(`COMM LAYER: Target device ${toId} for ${type} not found or not connected.`);
                        logSessionEvent(sessionId || 'unknown', toId, type, `Failed to relay WebRTC ${type} - device not connected. From: ${fromId}`);
                    }
                    break;
                }

                case "mouse_click": {
                    const { fromId, toId, sessionId, payload, type } = data;

                    if (!fromId || !toId || !payload || !payload.x || !payload.y) {
                        console.warn(`COMM LAYER: Received invalid click message. Missing coordinates or device info.`);
                        logSessionEvent(sessionId || 'unknown', fromId || 'unknown', type, `Invalid mouse click message - missing coordinates or device information`);
                        break;
                    }

                    console.log(`COMM LAYER: Relaying mouse click from web admin (${fromId}) to device ${toId} at coordinates (${payload.x}, ${payload.y})`);

                    const target = clients.get(toId);
                    if (target && target.readyState === WebSocket.OPEN) {
                        target.send(JSON.stringify({
                            type: "click",
                            toId,
                            fromId,
                            payload
                        }));
                        logSessionEvent(sessionId, toId, "mouse_click", `Mouse click at coordinates (${payload.x}, ${payload.y}) sent to device from web admin`);
                        updateSessionActivity(sessionId); //sprint 8
                    } else {
                        logSessionEvent(sessionId, toId, "mouse_click", "Failed to send mouse click - device not connected or unavailable");
                    }
                    break;
                }

                case "keyboard": {
                    const { fromId, toId, sessionId, payload, type } = data;

                    if (!sessionId || !payload.key || !payload.code) {
                        console.warn(`COMM LAYER: Received invalid keyboard message. Missing key information.`);
                        logSessionEvent(sessionId || 'unknown', fromId || 'unknown', type, `Invalid keyboard input - missing key or code information`);
                        break;
                    }

                    console.log(`COMM LAYER: Relaying keyboard input from web admin (${fromId}) to device ${toId}. Key: ${payload.key}`);

                    const target = clients.get(toId);
                    if (target && target.readyState === WebSocket.OPEN) {
                        target.send(JSON.stringify({
                            type: "keyboard",
                            toId,
                            fromId,
                            payload
                        }));
                        logSessionEvent(sessionId, toId, "keyboard", `Keyboard input sent to device - Key: ${payload.key}, Code: ${payload.code}`);
                        updateSessionActivity(sessionId);  //sprint 8
                    } else {
                        logSessionEvent(sessionId, toId, "keyboard", "Failed to send keyboard input - device not connected or unavailable");
                    }
                    break;
                }

                case "swipe": {
                    const { fromId, toId, sessionId, payload, type } = data;

                    if (!fromId || !toId || !payload || !payload.startX || !payload.startY || !payload.endX || !payload.endY) {
                        console.warn(`COMM LAYER: Received invalid swipe message. Missing coordinates.`);
                        logSessionEvent(sessionId || 'unknown', fromId || 'unknown', type, `Invalid swipe gesture - missing start or end coordinates`);
                        break;
                    }

                    console.log(`COMM LAYER: Relaying swipe gesture from web admin (${fromId}) to device ${toId}`);

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
                            `Swipe gesture sent to device - From (${payload.startX}, ${payload.startY}) to (${payload.endX}, ${payload.endY}), velocity: ${payload.velocity || 'N/A'}`
                        );
                        updateSessionActivity(sessionId); //sprint 8
                    } else {
                        logSessionEvent(sessionId, toId, "swipe", "Failed to send swipe gesture - device not connected or unavailable");
                    }
                    break;
                }

                // Sprint 8 - Video recording cases
                case "record_stream": {
                    const { deviceId, sessionId, recordStarted, message } = data;
                    
                    console.log(`COMM LAYER: Processing record_stream for device ${deviceId}, session ${sessionId}`);
                    
                    const target = clients.get(deviceId);
                    if (target && target.readyState === WebSocket.OPEN) {
                        target.send(JSON.stringify({
                            type: "record_stream",
                            deviceId,
                            sessionId,
                            recordStarted,
                            message: message || "Web admin started stream recording."
                        }));
                        logSessionEvent(sessionId, deviceId, "record_stream", `Stream recording started by web admin at ${recordStarted}`);
                        updateSessionActivity(sessionId);
                    } else {
                        logSessionEvent(sessionId, deviceId, "record_stream", "Failed to notify device about stream recording start - device not connected");
                    }
                    break;
                }

                case "record_stream_ended": {
                    const { deviceId, sessionId, recordEnded, message } = data;
                    
                    console.log(`COMM LAYER: Processing record_stream_ended for device ${deviceId}, session ${sessionId}`);
                    
                    const target = clients.get(deviceId);
                    if (target && target.readyState === WebSocket.OPEN) {
                        target.send(JSON.stringify({
                            type: "record_stream_ended",
                            deviceId,
                            sessionId,
                            recordEnded,
                            message: message || "Web admin stopped the recording."
                        }));
                        logSessionEvent(sessionId, deviceId, "record_stream_ended", `Stream recording ended by web admin at ${recordEnded}`);
                        updateSessionActivity(sessionId);
                    } else {
                        logSessionEvent(sessionId, deviceId, "record_stream_ended", "Failed to notify device about stream recording end - device not connected");
                    }
                    break;
                }

                case "decision_fileshare": {
                    console.log("COMM LAYER: Processing decision_fileshare from Backend.");
                    const { sessionId: decisionSessionId, decision } = data;
                    const deviceId = activeSessions.get(decisionSessionId);

                    if (!deviceId) {
                        console.error(`COMM LAYER: Received fileshare decision for session ${decisionSessionId}, but couldn't find deviceId in activeSessions.`);
                        logSessionEvent(decisionSessionId, 'unknown', data.type, `Fileshare decision failed: Could not find active device for session`);
                        return;
                    }

                    console.log(`COMM LAYER: Found deviceId ${deviceId} for session ${decisionSessionId}. Decision: ${decision}`);

                    if (decision) {
                        console.log(`COMM LAYER: Sending 'fileshare_approved' message to device ${deviceId}`);
                        sendToDevice(deviceId, {
                            type: "fileshare_approved",
                            deviceId: deviceId,
                            sessionId: decisionSessionId,
                            message: "Admin approved the session fileshare."
                        });
                        logSessionEvent(decisionSessionId, deviceId, data.type, "Fileshare session approved by web admin");
                        updateSessionActivity(decisionSessionId); //sprint 8

                        if (!approvedSessions.has(deviceId)) {
                            approvedSessions.set(deviceId, new Set());
                        }
                        approvedSessions.get(deviceId).add("web-admin");

                    } else {
                        console.log(`COMM LAYER: Sending 'fileshare_rejected' message to device ${deviceId}`);
                        sendToDevice(deviceId, {
                            type: "fileshare_rejected",
                            deviceId: deviceId,
                            sessionId: decisionSessionId,
                            message: `Admin rejected the session fileshare request.`
                        });
                        logSessionEvent(decisionSessionId, deviceId, data.type, `Fileshare session rejected by web admin`);
                        activeSessions.delete(decisionSessionId);
                        sessionActivity.delete(decisionSessionId);  //sprint 8
                        const deviceApprovedPeers = approvedSessions.get(deviceId);
                        if (deviceApprovedPeers) {
                            deviceApprovedPeers.delete("web-admin");
                            if (deviceApprovedPeers.size === 0) {
                                approvedSessions.delete(deviceId);
                            }
                        }
                    }
                    break;
                }

                case "browse_request": {
                    console.log("COMM LAYER: Processing browse_request from Backend.");
                    const { sessionId, path } = data
                    const deviceId = activeSessions.get(sessionId);

                    sendToDevice(deviceId, {
                        type: "browse_request",
                        deviceId: deviceId,
                        sessionId: sessionId,
                        path: path
                    });
                    console.log(`COMM_LAYER: browse_request to device ${deviceId}`);
                    //sprint 8
                    logSessionEvent(sessionId, deviceId, "browse_request", `File browse request sent to device for path: ${path || 'root directory'}`);
                    updateSessionActivity(sessionId);  

                    if (!approvedSessions.has(deviceId)) {
                        approvedSessions.set(deviceId, new Set());
                    }
                    approvedSessions.get(deviceId).add("web-admin");

                    break;
                }

                case "download_request": {
                    console.log("COMM LAYER: Processing download_request from Backend.");
                    const { deviceId, sessionId, paths } = data;
                    console.log("Download data received from web:", data);
                    sendToDevice(deviceId, {
                        type: "download_request",
                        deviceId,
                        sessionId,
                        paths: paths
                    });
                    console.log(`COMM_LAYER: download_request to device ${deviceId}`);
                    //sprint 8
                    logSessionEvent(sessionId, deviceId, "download_request", `Download request sent to device for ${paths ? paths.length : 0} file(s)`);
                    updateSessionActivity(sessionId);

                    if (!approvedSessions.has(deviceId)) {
                        approvedSessions.set(deviceId, new Set());
                    }
                    approvedSessions.get(deviceId).add("web-admin");

                    break;
                }

                case "download_status": {
                    const { deviceId, sessionId, status, message, fileName } = data;

                    console.log(
                    `COMM LAYER: download_status  device=${deviceId}  session=${sessionId}  status=${status}  file=${fileName}`
                    );

                    logSessionEvent(sessionId, deviceId, "download_status", `Download status: ${status} - ${message || 'No additional info'} - File: ${fileName || 'N/A'}`);

                    if (fileName) {
                        const target = path.join(UPLOAD_DIR, fileName);
                        try {
                            await fs.promises.rm(target, { recursive: true, force: true });
                            console.log(`Deleted ${fileName} from ${UPLOAD_DIR} after download_status.`);
                            //sprint 8
                            logSessionEvent(sessionId, deviceId, "file_cleanup", `Cleaned up downloaded file: ${fileName}`);
                        } catch (e) {
                            console.error(`Error deleting ${target}:`, e.message);
                            //sprint 8
                            logSessionEvent(sessionId, deviceId, "file_cleanup_error", `Failed to clean up file ${fileName}: ${e.message}`);
                        }
                    }
                    break;
                }

                default:
                    console.log(`COMM LAYER: Received unhandled message type from Web Admin WS: ${data.type}`);
                    break;
            }

        } catch (error) {
            console.error('COMM LAYER: Error parsing message from Web Admin WS:', error);
            console.error('COMM LAYER: Raw message was:', message.toString ? message.toString() : message);
            //logSessionEvent('unknown', 'comm_layer', 'parse_error', `Error parsing message from Web Admin WS: ${error.message}`); //sprint 8
        }

    });

    webAdminWs.on('close', () => {
        console.log(`!!! COMM LAYER: Web Admin WS Disconnected. Retrying in 5s...`);
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

    const wss = new WebSocket.Server({ server });

    wss.on("connection", (ws) => {
        console.log("New client connected");

        ws.on("message", async (message) => {
            const data = JSON.parse(message);

            console.log('\nReceived from device:', data);

            switch (data.type) {
                case "register":
                    const { deviceId, registrationKey } = data;

                    clients.set(deviceId, ws);

                    if (!deviceId || !registrationKey) {
                        ws.send(JSON.stringify({ type: "error", message: "Missing required fields: deviceId and/or registrationKey" }));
                        logSessionEvent('unknown', deviceId || 'unknown', 'registration_error', 'Device registration failed - missing required fields'); //sprint 8
                        // return;
                    }

                    const existingDevice = await devicesCollection.findOne({ registrationKey });
                    if (!existingDevice) {
                        ws.send(JSON.stringify({ type: "error", message: `Device with registration key ${registrationKey} doesn't exist.` }));
                        logSessionEvent('unknown', deviceId, 'registration_error', `Device registration failed - invalid registration key: ${registrationKey}`); //sprint 8
                        // return;
                    }

                    if (existingDevice.deviceId && existingDevice.deviceId !== deviceId) {
                        ws.send(JSON.stringify({ type: "error", message: `Registration key ${registrationKey} is already assigned to another device.` }));
                        logSessionEvent('unknown', deviceId, 'registration_error', `Device registration failed - registration key already assigned to another device`); //sprint 8
                        // return;
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

                    const token = jwt.sign({ deviceId }, process.env.JWT_SECRET);

                    console.log(`[REGISTRATION] Generated JWT for device ${deviceId}: ${token}`);

                    console.log(`Device ${deviceId} registered.`);
                    ws.send(JSON.stringify({ type: "success", message: `Device registered successfully.`, token }));
                    break;

                case "deregister":
                    if (!data.deviceId || !data.deregistrationKey) {
                        ws.send(JSON.stringify({ type: "error", message: "Missing required fields: deviceId, deregistrationKey" }));
                        //logSessionEvent('unknown', data.deviceId || 'unknown', 'deregistration_error', 'Device deregistration failed - missing required fields'); //sprint 8
                        return;
                    }

                    const device = await devicesCollection.findOne({ deviceId: data.deviceId });
                    if (!device) {
                        ws.send(JSON.stringify({ type: "error", message: `Device not found.` }));
                        //logSessionEvent('unknown', data.deviceId, 'deregistration_error', 'Device deregistration failed - device not found'); //sprint 8
                        return;
                    }

                    if (device.deregistrationKey !== data.deregistrationKey) {
                        ws.send(JSON.stringify({ type: "error", message: "Invalid deregistration key." }));
                        //logSessionEvent('unknown', data.deviceId, 'deregistration_error', 'Device deregistration failed - invalid deregistration key'); //sprint 8
                        return;
                    }

                    await devicesCollection.deleteOne({ deviceId: data.deviceId });

                    clients.delete(data.deviceId);
                    ws.close();

                    console.log(`Device ${data.deviceId} deregistered and removed from database.`);

                    ws.send(JSON.stringify({ type: "success", message: `Device deregistered successfully and removed from database.` }));
                    break;

                case "status":
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
                    break;

                case "signal":
                    const { from: senderId, to: receiverId, payload } = data;

                    const allowedPeers = approvedSessions.get(senderId);
                    if (!allowedPeers || !allowedPeers.has(receiverId)) {
                        ws.send(JSON.stringify({ type: "error", message: "Session not approved between devices." }));
                        //logSessionEvent('unknown', senderId, 'signal_error', `Unauthorized signal attempt to ${receiverId} - session not approved`); //sprint 8
                        return;
                    }

                    const target = clients.get(receiverId);
                    if (target) {
                        target.send(JSON.stringify({ type: "signal", from: senderId, payload }));
                        //logSessionEvent('unknown', senderId, 'signal_relay', `WebRTC signal relayed to ${receiverId} successfully`); //sprint 8
                    } else {
                        //logSessionEvent('unknown', senderId, 'signal_error', `Failed to relay signal to ${receiverId} - target device not connected`); //sprint 8
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

                case "session_request":
                    const { from, token: existingToken } = data;

                    clients.set(from, ws);

                    console.log(`Session request from device ${from} with token ${existingToken}`);

                    const reqDevice = await devicesCollection.findOne({ deviceId: from });
                    if (!reqDevice) {
                        ws.send(JSON.stringify({ type: "error", message: "Device is not registered." }));
                        logSessionEvent(existingToken, from, 'session_request_error', 'Session request failed - device not registered');
                        return;
                    }

                    const sessionUser = verifySessionToken(existingToken);
                    if (!sessionUser || sessionUser.deviceId !== from) {
                        ws.send(JSON.stringify({ type: "error", message: "Invalid session token." }));
                        logSessionEvent(existingToken, from, 'session_request_error', 'Session request failed - invalid session token');
                        return;
                    }

                    const sessionToken = jwt.sign(
                        { deviceId: from }, // Use a minimal payload
                        process.env.JWT_SECRET, // Ensure the secret matches the one used in verifySessionToken
                        { expiresIn: '1d' } // Set an appropriate expiration time
                    );

                    // Spremite novi token u activeSessions
                    activeSessions.set(sessionToken, from);
                    updateSessionActivity(sessionToken);

                    console.log(`\n\nSession request from device ${from} with new session token ${sessionToken}'\n\n`);

                    logSessionEvent(sessionToken, from, data.type, "Session request initiated by device");

                    if (webAdminWs && webAdminWs.readyState === WebSocket.OPEN) {
                        console.log("Sending session request to web admin");

                        webAdminWs.send(JSON.stringify({
                            type: "request_control",
                            sessionId: sessionToken, // Koristite novi token kao sessionId
                            deviceId: from,
                        }));

                        // Pošaljite novi token uređaju
                        ws.send(JSON.stringify({
                            type: "info",
                            message: "Session request forwarded to Web Admin.",
                            sessionToken: sessionToken // Novi token za sesiju
                        }));
                        //logSessionEvent(sessionToken, from, 'session_request_forwarded', 'Session request forwarded to web admin successfully');
                    } else {
                        ws.send(JSON.stringify({ type: "error", message: "Web Admin not connected." }));
                        logSessionEvent(sessionToken, from, 'session_request_error', "Session request failed - Web Admin not connected");
                    }

                    console.log("ActiveSessions: \n\n", activeSessions);
                    console.log("ApprovedSessions: \n\n", approvedSessions);

                    break;

                case "session_final_confirmation":
                    const { token: finalToken, from: finalFrom, decision } = data;

                    let sessionTokenn = null;
                    for (const [token, deviceId] of activeSessions.entries()) {
                        if (deviceId === finalFrom) {
                            sessionTokenn = token;
                            break;
                        }
                    }

                    console.log(`Session final confirmation from device ${finalFrom} with token ${sessionTokenn} and decision ${decision}`);

                    const reqDeviceFinal = await devicesCollection.findOne({ deviceId: finalFrom });
                    if (!reqDeviceFinal) {
                        ws.send(JSON.stringify({ type: "error", message: "Device is not registered." }));
                        logSessionEvent(sessionTokenn, finalFrom, 'session_confirmation_error', "Session confirmation failed - device not registered");
                        return;
                    }

                    const sessionUserFinal = verifySessionToken(sessionTokenn);
                    if (!sessionUserFinal || sessionUserFinal.deviceId !== finalFrom) {
                        ws.send(JSON.stringify({ type: "error", message: "Invalid session token." }));
                        logSessionEvent(sessionTokenn, finalFrom, 'session_confirmation_error', "Session confirmation failed - invalid session token");
                        return;
                    }

                    if (decision === "accepted") {
                        webAdminWs.send(JSON.stringify({ type: "control_status", from: finalFrom, sessionId: sessionTokenn, status: "connected" }));
                        logSessionEvent(sessionTokenn, finalFrom, data.type, "Session accepted by device - control session established");
                        updateSessionActivity(sessionTokenn); //sprint 8
                    }
                    else if (decision === "rejected") {
                        webAdminWs.send(JSON.stringify({ type: "control_status", from: finalFrom, sessionId: sessionTokenn, status: "failed" }));
                        logSessionEvent(sessionTokenn, finalFrom, data.type, "Session rejected by device - control session failed to establish");

                        //sprint 8
                        activeSessions.delete(sessionTokenn);
                        sessionActivity.delete(sessionTokenn);
                        break;
                    }

                    ws.send(JSON.stringify({ type: "session_confirmed", message: "Session successfully started between device and Web Admin." }));
                    logSessionEvent(sessionTokenn, finalFrom, "session_start", "Control session successfully established between device and web admin");

                    break;

                case "offer":
                case "answer":
                case "ice-candidate": {
                    const { fromId, toId, payload, type } = data;

                    if (webAdminWs && webAdminWs.readyState === WebSocket.OPEN) {
                        webAdminWs.send(JSON.stringify({ type, fromId, toId, payload }));
                        //logSessionEvent('unknown', fromId, type, `WebRTC ${type} sent from device to web admin`); //sprint 8
                    }

                    const target = clients.get(toId);
                    if (target && target.readyState === WebSocket.OPEN) {
                        target.send(JSON.stringify({ type, fromId, toId, payload }));
                        //logSessionEvent('unknown', fromId, type, `WebRTC ${type} relayed to device ${toId}`); //sprint 8
                    } else {
                        console.warn(`Target ${toId} not connected as device (maybe it's the frontend).`);
                        //logSessionEvent('unknown', fromId, type, `Failed to relay WebRTC ${type} to ${toId} - target not connected`); //sprint 8
                    }
                    break;
                }

                case "request_session_fileshare": {
                    const { deviceId: from1, sessionId: token1 } = data;

                    clients.set(from1, ws);

                    console.log(`Fileshare session request from device ${from1} with token ${token1}`);

                    const reqDevice = await devicesCollection.findOne({ deviceId: from1 });
                    if (!reqDevice) {
                        ws.send(JSON.stringify({ type: "error", message: "Device is not registered." }));
                        logSessionEvent(token1, from1, 'fileshare_request_error', 'Fileshare session request failed - device not registered'); //sprint 8
                        return;
                    }

                    const sessionUser = verifySessionToken(token1);
                    if (!sessionUser || sessionUser.deviceId !== from1) {
                        ws.send(JSON.stringify({ type: "error", message: "Invalid session token." }));
                        logSessionEvent(token1, from1, 'fileshare_request_error', 'Fileshare session request failed - invalid session token'); //sprint 8
                        return;
                    }

                    activeSessions.set(token1, from1);
                    updateSessionActivity(token1); //sprint 8

                    console.log(`\n\nFileshare session request from device ${from1} with token ${token1}'\n\n`);

                    logSessionEvent(token1, from1, data.type, "Fileshare session request initiated by device");

                    if (webAdminWs && webAdminWs.readyState === WebSocket.OPEN) {
                        console.log("Sending fileshare request to web admin");

                        webAdminWs.send(JSON.stringify({
                            type: "request_session_fileshare",
                            sessionId: token1,
                            deviceId: from1,
                        }));

                        ws.send(JSON.stringify({ type: "info", message: "Session fileshare request forwarded to Web Admin.", sessionId: token1 }));
                        logSessionEvent(token1, from1, 'fileshare_request_forwarded', 'Fileshare session request forwarded to web admin successfully'); //sprint 8
                    } else {
                        ws.send(JSON.stringify({ type: "error", message: "Web Admin not connected." }));
                        logSessionEvent(token1, from1, 'fileshare_request_error', "Fileshare session request failed - Web Admin not connected");
                    }

                    console.log("ActiveSessions: \n\n", activeSessions);
                    console.log("ApprovedSessions: \n\n", approvedSessions);

                    break;
                }

                case "browse_response": {
                    const { deviceId: from, sessionId: tokenn, path, entries } = data;

                    let sessionTokenn = null;
                    for (const [token, deviceId] of activeSessions.entries()) {
                        if (deviceId === from) {
                            sessionTokenn = token;
                            break;
                        }
                    }

                    console.log(`Browse response from device ${from} with token ${sessionTokenn}`);

                    const reqDevice = await devicesCollection.findOne({ deviceId: from });
                    if (!reqDevice) {
                        ws.send(JSON.stringify({ type: "error", message: "Device is not registered." }));
                        logSessionEvent(sessionTokenn, from, 'browse_response_error', 'Browse response failed - device not registered'); //sprint 8
                        return;
                    }

                    const sessionUser = verifySessionToken(sessionTokenn);
                    if (!sessionUser || sessionUser.deviceId !== from) {
                        ws.send(JSON.stringify({ type: "error", message: "Invalid session token." }));
                        logSessionEvent(sessionTokenn, from, 'browse_response_error', 'Browse response failed - invalid session token'); //sprint 8
                        return;
                    }

                    updateSessionActivity(sessionTokenn); //sprint 8

                    console.log(`\n\nBrowse response from device ${from} with token ${sessionTokenn}'\n\n`);

                    logSessionEvent(sessionTokenn, from, data.type, `Browse response from device - Path: ${path}, Entries: ${entries ? entries.length : 0} items`);

                    if (webAdminWs && webAdminWs.readyState === WebSocket.OPEN) {
                        console.log("Sending browse response to web admin");

                        webAdminWs.send(JSON.stringify({
                            type: "browse_response",
                            deviceId: from,
                            sessionId: sessionTokenn,
                            path: path,
                            entries: entries
                        }));

                        ws.send(JSON.stringify({ type: "info", message: "Browse response forwarded to Web Admin.", sessionId: tokenn }));
                        logSessionEvent(sessionTokenn, from, 'browse_response_forwarded', 'Browse response forwarded to web admin successfully'); //sprint 8
                    } else {
                        ws.send(JSON.stringify({ type: "error", message: "Web Admin not connected." }));
                        logSessionEvent(sessionTokenn, from, 'browse_response_error', "Browse response failed - Web Admin not connected");
                    }

                    break;
                }

                case "upload_status": {
                    const { deviceId: from, sessionId: tokenn, status, path:paths, fileName, message } = data;

                    console.log(`Upload status from device ${from} with token ${tokenn}`);

                    const reqDevice = await devicesCollection.findOne({ deviceId: from });
                    if (!reqDevice) {
                        ws.send(JSON.stringify({ type: "error", message: "Device is not registered." }));
                        logSessionEvent(tokenn, from, 'upload_status_error', 'Upload status failed - device not registered'); //sprint 8
                        return;
                    }

                    const sessionUser = verifySessionToken(tokenn);
                    if (!sessionUser || sessionUser.deviceId !== from) {
                        ws.send(JSON.stringify({ type: "error", message: "Invalid session token." }));
                        logSessionEvent(tokenn, from, 'upload_status_error', 'Upload status failed - invalid session token'); //sprint 8
                        return;
                    }
                    
                    //sprint 8
                    updateSessionActivity(tokenn);

                    logSessionEvent(tokenn, from, data.type, `Upload status from device - Status: ${status}, Message: ${message || 'No message'}, Path: ${paths || 'N/A'}`);

                    if (webAdminWs && webAdminWs.readyState === WebSocket.OPEN) {
                        console.log("Sending upload status to web admin");

                        webAdminWs.send(JSON.stringify({
                            type: "upload_status",
                            deviceId: from,
                            sessionId: tokenn,
                            status: status,
                            message: message,
                            path: paths
                        }));

                        if (fileName) {
                          const target = path.join(UPLOAD_DIR, fileName);
                           try {
                             await fs.promises.rm(target, { recursive: true, force: true });
                             console.log(`Obrisan fajl ${fileName} iz ${UPLOAD_DIR} nakon upload_status.`);
                             logSessionEvent(tokenn, from, 'file_cleanup', `Upload file cleaned up: ${fileName}`); //sprint 8
                          } catch (e) {
                             console.error(`Greška pri brisanju ${target}:`, e.message);
                             logSessionEvent(tokenn, from, 'file_cleanup_error', `Failed to clean up upload file ${fileName}: ${e.message}`); //sprint 8
                          }
                         }

                        ws.send(JSON.stringify({ type: "info", message: "Upload status forwarded to Web Admin.", sessionId: tokenn }));
                        logSessionEvent(tokenn, from, 'upload_status_forwarded', 'Upload status forwarded to web admin successfully'); //sprint 8
                    } else {
                        ws.send(JSON.stringify({ type: "error", message: "Web Admin not connected." }));
                        logSessionEvent(tokenn, from, 'upload_status_error', "Upload status failed - Web Admin not connected");
                    }

                    break;
                }

                //sprint 8
                default:
                    console.log(`Received unhandled message type from device: ${data.type}`);
                    //logSessionEvent('unknown', data.deviceId || 'unknown', 'unhandled_message', `Unhandled message type from device: ${data.type}`);
                    break;
            }

        });

        ws.on("close", () => {
            console.log("Client disconnected");
        });

    });

    // Sprint 8 - Session inactivity check
    setInterval(async () => {
        const now = Date.now();
        
        for (const [sessionId, lastActivity] of sessionActivity.entries()) {
            if (now - lastActivity > SESSION_INACTIVITY_TIMEOUT) {
                const deviceId = activeSessions.get(sessionId);
                
                if (deviceId) {
                    console.log(`Session ${sessionId} for device ${deviceId} inactive for too long. Terminating...`);
                    
                    // Send inactive disconnect message to device
                    sendToDevice(deviceId, {
                        type: "inactive_disconnect",
                        deviceId,
                        sessionId,
                        status: "The session has been terminated due to inactivity."
                    });
                    
                    // Notify web admin
                    if (webAdminWs && webAdminWs.readyState === WebSocket.OPEN) {
                        webAdminWs.send(JSON.stringify({
                            type: "inactive_disconnect",
                            sessionId,
                            deviceId,
                            reason: "inactivity_timeout"
                        }));
                    }
                    
                    // Log the event
                    logSessionEvent(sessionId, deviceId, 'inactive_disconnect', 'Session terminated due to inactivity (3+ minutes without activity)');
                    
                    // Clean up
                    activeSessions.delete(sessionId);
                    sessionActivity.delete(sessionId);
                    
                    const deviceApprovedPeers = approvedSessions.get(deviceId);
                    if (deviceApprovedPeers) {
                        deviceApprovedPeers.delete("web-admin");
                        if (deviceApprovedPeers.size === 0) {
                            approvedSessions.delete(deviceId);
                        }
                    }
                }
            }
        }
    }, INACTIVITY_CHECK_INTERVAL);

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

                if (!lastSeen || now - lastSeen > heartbeat_timeout) {
                    console.log(`Device ${deviceId} marked as inactive due to missing heartbeat.`);

                    await devicesCollection.findOneAndUpdate(
                        { deviceId },
                        {
                            $set: {
                                status: "inactive",
                                lastActiveTime: now
                            }
                        }
                    );

                    lastHeartbeat.delete(deviceId);
                    try {
                        ws.close();
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

    //Configuration related  9.sprint
    app.get('/config', (req, res) => { //9.sprint
        res.json(sessionConfig);//9.sprint
    });

    app.post('/update-config', (req, res) => {//9.sprint
  const { inactiveTimeout, maxSessionDuration } = req.body;

  // Allowed values in seconds
  const allowedInactiveTimeouts = [180, 300, 600, 900, 1200]; // 3, 5, 10, 15, 20 min
  const allowedMaxDurations = [300, 900, 1800, 3600, 7200]; // 5, 15, 30, 60, 120 min

  // Validation
  if (
    !allowedInactiveTimeouts.includes(inactiveTimeout) ||
    !allowedMaxDurations.includes(maxSessionDuration)
  ) {
    return res.status(400).json({
      error: "Invalid config values. Must be one of allowed options."
    });
  }

  // Update in-memory config
  sessionConfig.inactiveTimeout = inactiveTimeout;
  sessionConfig.maxSessionDuration = maxSessionDuration;

  // Write to file
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(sessionConfig, null, 2));
    res.status(200).json({ message: "Config updated successfully." });
  } catch (err) {
    console.error("Error writing to config.json:", err);
    res.status(500).json({ error: "Failed to update config file." });
  }
});//9.sprint


    // Deregister device
    app.post("/devices/deregister", async (req, res) => {
        const { deviceId, deregistrationKey } = req.body;

        if (!deviceId || !deregistrationKey) {
            return res.status(400).json({ error: "Missing required fields: deviceId, deregistrationKey" });
        }

        try {
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
            logSessionEvent(token, deviceId, 'session_end', 'Session manually removed via API'); //sprint 8
            return res.status(200).json({ success: true, message: 'Session removed.' });
        } else {
            return res.status(404).json({ success: false, message: 'Session not found.' });
        }
    });

    app.post("/api/upload", upload.array("files[]"), async (req, res) => {
        try {
            const { deviceId, sessionId, path: basePath, uploadType } = req.body;
            const files = req.files;

            if (!deviceId || !sessionId || !basePath || !files?.length || !uploadType) {
                //logSessionEvent(sessionId, deviceId, 'upload_error', 'Upload failed - missing required fields'); //sprint 8
                return res.status(400).json({ error: "Missing required fields." });
            }

            let zipName, zipPath, downloadUrl;
            const cleanBase = basePath.replace(/^\/+/g, "");

            if (uploadType === "folder") {
                const zipFile = files[0];
                zipName = zipFile.originalname.endsWith('.zip') ? zipFile.originalname : `${zipFile.originalname}.zip`;
                zipPath = path.join(UPLOAD_DIR, zipName);
                await fs.promises.rename(zipFile.path, zipPath);
                downloadUrl = `https://remote-control-gateway-production.up.railway.app/uploads/${zipName}`;
                logSessionEvent(sessionId, deviceId, 'upload_processing', `Folder upload processed - File: ${zipName}`); //sprint 8
            } else if (uploadType === "files") {
            
            const safeSessionId = sessionId.replace(/[^\w\-]/g, "_");
            const sessionFolder = path.join(UPLOAD_DIR, `session-${safeSessionId}`);
            await fs.promises.mkdir(sessionFolder, { recursive: true });
                
                for (const f of files) {
                    const relativePath = f.originalname;
                    const dest = path.join(sessionFolder, cleanBase, relativePath);
                    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
                    await fs.promises.rename(f.path, dest);
                }

                const timestamp = Date.now();
                const zipBase = `upload-${deviceId}-${timestamp}`;
                zipName = `${zipBase}.zip`;
                zipPath = path.join(UPLOAD_DIR, zipName);

                const output = fs.createWriteStream(zipPath);
                const archive = archiver("zip", { zlib: { level: 9 } });

                archive.on("error", err => { throw err });
                archive.pipe(output);

                const targetPath = path.join(sessionFolder, cleanBase);
                archive.directory(targetPath, zipBase);

                await archive.finalize();
                await new Promise(resolve => output.on("close", resolve));

                await fs.promises.rm(sessionFolder, { recursive: true, force: true });

                downloadUrl = `https://remote-control-gateway-production.up.railway.app/uploads/${zipName}`;
                logSessionEvent(sessionId, deviceId, 'upload_processing', `Multiple files upload processed - ${files.length} files zipped as ${zipName}`); //sprint 8
            } else {
                logSessionEvent(sessionId, deviceId, 'upload_error', `Upload failed - invalid upload type: ${uploadType}`); //sprint 8
                return res.status(400).json({ error: "Invalid uploadType. Must be 'folder' or 'files'." });
            }

            sendToDevice(deviceId, {
                type: "upload_files",
                deviceId,
                sessionId,
                downloadUrl,
                remotePath: cleanBase
            });

            //sprint 8
            logSessionEvent(sessionId, deviceId, 'upload_complete', `Upload completed successfully - Download URL sent to device: ${downloadUrl}`); 
            updateSessionActivity(sessionId);

            return res.json({ message: "Upload complete. Android notified.", downloadUrl });

        } catch (err) {
            console.error("Upload error:", err);
            logSessionEvent(req.body.sessionId, req.body.deviceId, 'upload_error', `Upload failed with error: ${err.message}`); //sprint 8
            return res.status(500).json({ error: "Internal server error." });
        }
    });

    app.use(
        "/uploads",
        express.static(UPLOAD_DIR, {
            setHeaders: (res, filePath) => {
                const fileName = path.basename(filePath);
                res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
            }
        })
    );

    app.post("/api/download", upload.single("file"), async (req, res) => {
        try {
            const { deviceId, sessionId } = req.body;
            const file = req.file;

            if (!deviceId || !sessionId || !file) {
                logSessionEvent(sessionId, deviceId, 'download_error', 'Download failed - missing required fields'); //sprint 8
                return res.status(400).json({ error: "Missing required fields." });
            }

            const finalPath = path.join(UPLOAD_DIR, file.originalname);

            await fs.promises.rename(file.path, finalPath);
            const downloadUrl = `/uploads/${file.originalname}`;

            console.log("Preparing to send download_response to Web Admin:", {
                type: "download_response",
                deviceId,
                sessionId,
                downloadUrl: `https://remote-control-gateway-production.up.railway.app${downloadUrl}`
            });

            if (webAdminWs && webAdminWs.readyState === WebSocket.OPEN) {
                webAdminWs.send(JSON.stringify({
                    type: "download_response",
                    deviceId,
                    sessionId,
                    downloadUrl: `https://remote-control-gateway-production.up.railway.app${downloadUrl}`
                }));
                console.log("Message sent to Web Admin successfully.");
                logSessionEvent(sessionId, deviceId, 'download_response', `Download response sent to web admin - File: ${file.originalname}`); //sprint 8
            } else {
                console.warn("Web Admin WebSocket is not open. Message not sent.");
                logSessionEvent(sessionId, deviceId, 'download_error', 'Download response failed - Web Admin not connected'); //sprint 8
            }

            //sprint 8
            updateSessionActivity(sessionId);

            return res.json({ message: "File stored, Web notified.", downloadUrl });

        } catch (err) {
            console.error("Download upload error:", err);
            logSessionEvent(req.body.sessionId, req.body.deviceId, 'download_error', `Download failed with error: ${err.message}`); //sprint 8
            return res.status(500).json({ error: "Internal server error." });
        }
    });

    const PORT = process.env.PORT || 8080;
    server.listen(PORT, () => {
        console.log("Server listening on port", PORT);
    });
}

// Start the server with DB connection
startServer().catch((err) => {
    console.error("Error starting server:", err);
    process.exit(1);
});

connectToWebAdmin().catch((err) => {
    console.error("Error connecting to web admin:", err);
    process.exit(1);
});