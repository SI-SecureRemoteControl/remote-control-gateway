const { logSessionEvent } = require("./utils/sessionLogger");

function sendToDevice(deviceId, payload, clients) {
    console.log("Broj klijenata:", clients.size, "->", Array.from(clients.keys()));
    const ws = clients.get(deviceId);
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(payload));
    } else {
        console.warn(`Device ${deviceId} not connected.`);
    }
}

function handleRequestReceived(data, activeSessions) {
    console.log(`COMM LAYER: Backend acknowledged request for session ${data.sessionId}`);
    logSessionEvent(data.sessionId, activeSessions.get(data.sessionId), data.type, "Backend acknowledged request for session.");
}

function handleControlDecision(data, activeSessions, approvedSessions, clients) {
    const { sessionId: decisionSessionId, decision, reason } = data;
    const deviceId = activeSessions.get(decisionSessionId);

    if (!deviceId) {
        console.error(`COMM LAYER: Received control_decision for session ${decisionSessionId}, but couldn't find deviceId.`);
        logSessionEvent(decisionSessionId, 'unknown', data.type, `Failed: Could not find active device for session.`);
        return;
    }

    console.log(`COMM LAYER: Found deviceId ${deviceId} for session ${decisionSessionId}. Decision: ${decision}`);

    if (decision === "accepted") {
        sendToDevice(deviceId, {
            type: "approved",
            sessionId: decisionSessionId,
            message: "Admin approved the session request."
        }, clients);

        logSessionEvent(decisionSessionId, deviceId, data.type, "Session approved by backend.");
        if (!approvedSessions.has(deviceId)) {
            approvedSessions.set(deviceId, new Set());
        }
        approvedSessions.get(deviceId).add("web-admin");
    } else {
        sendToDevice(deviceId, {
            type: "rejected",
            sessionId: decisionSessionId,
            message: `Admin rejected the session request. Reason: ${reason || 'N/A'}`
        }, clients);

        logSessionEvent(decisionSessionId, deviceId, data.type, `Session rejected by backend. Reason: ${reason || 'N/A'}`);
        activeSessions.delete(decisionSessionId);

        const deviceApprovedPeers = approvedSessions.get(deviceId);
        if (deviceApprovedPeers) {
            deviceApprovedPeers.delete("web-admin");
            if (deviceApprovedPeers.size === 0) {
                approvedSessions.delete(deviceId);
            }
        }
    }
}

function handleSessionTerminated(data, activeSessions, approvedSessions, clients) {
    const { sessionId, reason } = data;
    const deviceId = activeSessions.get(sessionId);

    if (!deviceId) {
        console.warn(`COMM LAYER: Received termination for session ${sessionId}, but couldn't find deviceId.`);
        logSessionEvent(sessionId, 'unknown', data.type, `Termination received. Reason: ${reason || 'N/A'}`);
        activeSessions.delete(sessionId);
        return;
    }

    logSessionEvent(sessionId, deviceId, data.type, `Session terminated by backend. Reason: ${reason || 'N/A'}`);
    activeSessions.delete(sessionId);

    const peers = approvedSessions.get(deviceId);
    if (peers) {
        peers.delete("web-admin");
        if (peers.size === 0) approvedSessions.delete(deviceId);
    }

    sendToDevice(deviceId, {
        type: "session_ended",
        sessionId,
        reason: reason || 'terminated_by_admin'
    }, clients);
}

function handleSignalingMessage(data, clients) {
    const { fromId, toId, payload, type, sessionId } = data;

    if (!fromId || !toId || !payload) {
        console.warn(`COMM LAYER: Invalid signaling message (${type}).`, data);
        logSessionEvent(sessionId || 'unknown', fromId || 'unknown', type, "Invalid signaling message.");
        return;
    }

    const target = clients.get(toId);
    if (target && target.readyState === 1) {
        target.send(JSON.stringify({ type, fromId, toId, payload }));
        logSessionEvent(sessionId || 'unknown', toId, type, `Relayed from backend peer ${fromId}.`);
    } else {
        logSessionEvent(sessionId || 'unknown', toId, type, `Failed relay: device not connected.`);
    }
}

function handleMouseClick(data, clients) {
    const { fromId, toId, sessionId, payload } = data;

    if (!fromId || !toId || !payload) {
        console.warn(`COMM LAYER: Invalid mouse_click message.`, data);
        logSessionEvent(sessionId || 'unknown', fromId || 'unknown', "mouse_click", "Invalid message structure.");
        return;
    }

    const target = clients.get(toId);
    if (target && target.readyState === 1) {
        target.send(JSON.stringify({ type: "click", toId, fromId, payload }));
        logSessionEvent(sessionId, toId, "mouse_click", `Mouse click at (${payload.x}, ${payload.y}) sent.`);
    } else {
        logSessionEvent(sessionId, toId, "mouse_click", "Device not connected.");
    }
}

function handleKeyboard(data, clients) {
    const { fromId, toId, sessionId, payload, type } = data;

    if (!sessionId || !payload.key || !payload.code) {
        console.warn(`COMM LAYER: Invalid keyboard message.`, data);
        logSessionEvent(sessionId || 'unknown', fromId || 'unknown', type, "Invalid keyboard message structure.");
        return;
    }

    const target = clients.get(toId);
    if (target && target.readyState === 1) {
        target.send(JSON.stringify({ type: "keyboard", toId, fromId, payload }));
        logSessionEvent(sessionId, toId, "keyboard", `Keyboard input (${type}) relayed.`);
    } else {
        logSessionEvent(sessionId, toId, "keyboard", "Device not connected.");
    }
}

module.exports = {
    handleRequestReceived,
    handleControlDecision,
    handleSessionTerminated,
    handleSignalingMessage,
    handleMouseClick,
    handleKeyboard,
};
