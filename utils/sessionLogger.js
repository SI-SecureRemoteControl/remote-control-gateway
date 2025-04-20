const { connectDB } = require('../database/db');

async function logSessionEvent(sessionId, deviceId, eventType, description) {
    const db = await connectDB();
    const sessionLogsCollection = db.collection('sessionLogs');

    const timestamp = new Date();

    const newEvent = {
        timestamp,
        type: eventType,
        description,
    };

    try {
        // Validate input types
        if (typeof sessionId !== 'string' || typeof deviceId !== 'string') {
            throw new Error('sessionId and deviceId must be strings.');
        }
        if (typeof eventType !== 'string' || typeof description !== 'string') {
            throw new Error('eventType and description must be strings.');
        }

        // Use upsert to ensure atomicity
        await sessionLogsCollection.updateOne(
            { sessionId, deviceId }, // Match criteria
            {
                $push: { events: newEvent }, // Push the new event
                $setOnInsert: { sessionId, deviceId }, // Set these fields if inserting
            },
            { upsert: true } // Create the document if it doesn't exist
        );

        console.log('Session event logged successfully.');
    } catch (error) {
        console.error('Error logging session event:', error);
    }
}

module.exports = { logSessionEvent };