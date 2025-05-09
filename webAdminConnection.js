const WebSocket = require('ws');

const {
    handleRequestReceived,
    handleControlDecision,
    handleSessionTerminated,
    handleSignalingMessage,
    handleMouseClick,
    handleKeyboard
} = require('./webAdminMessageHandlers');

function connectToWebAdmin(activeSessions, approvedSessions, clients) {
    let webAdminWs = new WebSocket('wss://backend-wf7e.onrender.com/ws/control/comm');

    webAdminWs.on('open', () => {
        console.log('>>> COMM LAYER: Successfully connected to Web Admin WS (Backend)!');
    });

    webAdminWs.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('\nCOMM LAYER: Received message from Web Admin WS:', data);

            switch (data.type) {
                case "request_received":
                    handleRequestReceived(data, activeSessions);
                    break;
                case "control_decision":
                    handleControlDecision(data, activeSessions, approvedSessions, clients);
                    break;
                case "session_terminated":
                    handleSessionTerminated(data, activeSessions, approvedSessions, clients);
                    break;
                case "offer":
                case "answer":
                case "ice-candidate":
                    handleSignalingMessage(data, clients);
                    break;
                case "mouse_click":
                    handleMouseClick(data, clients);
                    break;
                case "keyboard":
                    handleKeyboard(data, clients);
                    break;
                default:
                    console.log(`COMM LAYER: Received unhandled message type from Web Admin WS: ${data.type}`);
                    logSessionEvent(data.sessionId || 'unknown', data.deviceId || 'unknown', data.type, "Unhandled message type from Web Admin WS.");
                    break;
            }

        } catch (error) {
            console.error('COMM LAYER: Error parsing message from Web Admin WS:', error);
            console.error('COMM LAYER: Raw message was:', message.toString());
        }
    });

    webAdminWs.on('close', () => {
        setTimeout(() => connectToWebAdmin(activeSessions, approvedSessions, clients), 5000);
    });

    webAdminWs.on('error', (err) => {
        console.error('Web Admin WS Error:', err.message);
    });

    return webAdminWs;
}

module.exports = connectToWebAdmin;
