// webAdminConnection.js
const WebSocket = require('ws');
const config = require('./config');
const { handleControlDecision } = require('/websocketHandlers');

function connectToWebAdmin(activeSessions, approvedSessions, clients) {
    console.log(`Connecting to Web Admin at ${config.WEB_ADMIN_WS_URL}`);

    let webAdminWs = new WebSocket(config.WEB_ADMIN_WS_URL);

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
                    break;
                case "control_decision": 
                    handleControlDecision(data, activeSessions, approvedSessions, clients);
                    break;
                default:
                    console.log(`COMM LAYER: Received unhandled message type from Web Admin WS: ${data.type}`);
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