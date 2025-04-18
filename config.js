// config.js
require('dotenv').config();

module.exports = {
    HEARTBEAT_TIMEOUT: 600 * 1000,
    HEARTBEAT_CHECK_INTERVAL: 30 * 1000,
    WEB_ADMIN_WS_URL: 'wss://backend-wf7e.onrender.com/ws/control/comm',
    PORT: process.env.PORT || 8080,
    JWT_SECRET: process.env.JWT_SECRET
};