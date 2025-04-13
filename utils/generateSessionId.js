const crypto = require("crypto");

function generateSessionId() {
    return crypto.randomBytes(12).toString("hex"); // 24-char unique session ID
}

module.exports = { generateSessionId };