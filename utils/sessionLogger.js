const fs = require('fs');
const path = require('path');

// Define the log file path
const logFilePath = path.join(__dirname, 'session_logs.json');

// Utility function to log session events
function logSessionEvent(sessionId, deviceId, eventType, description) {
    const timestamp = new Date().toISOString();
    const newEvent = {
        timestamp,
        type: eventType,
        description,
    };

    // Read existing logs
    fs.readFile(logFilePath, 'utf8', (err, data) => {
        let logs = [];
        if (!err && data) {
            try {
                logs = JSON.parse(data);
            } catch (parseError) {
                console.error('Error parsing existing logs:', parseError);
            }
        }

        // Find the session by sessionId
        let session = logs.find(log => log.sessionId === sessionId);

        if (session) {
            // Append the new event to the existing session
            session.events.push(newEvent);
        } else {
            // Create a new session object
            session = {
                sessionId,
                deviceId,
                events: [newEvent],
            };
            logs.push(session);
        }

        // Write the updated logs back to the file
        fs.writeFile(logFilePath, JSON.stringify(logs, null, 2), (writeErr) => {
            if (writeErr) {
                console.error('Error writing to log file:', writeErr);
            }
        });
    });
}

module.exports = { logSessionEvent };