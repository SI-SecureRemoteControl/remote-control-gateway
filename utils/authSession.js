require("dotenv").config();
const jwt = require("jsonwebtoken");

const SECRET_KEY = process.env.JWT_SECRET;

function verifySessionToken(token) {
    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        return decoded;
    } catch (err) {
        return null;
    }
}

module.exports = { verifySessionToken };