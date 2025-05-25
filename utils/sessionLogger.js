const { connectDB } = require('../database/db');

// Sprint 8 - Log retention policy (30 days)
const LOG_RETENTION_DAYS = 30;
const LOG_RETENTION_MS = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

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
        // Introduce a tiny wait
        await new Promise(resolve => setTimeout(resolve, 50));

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
                $setOnInsert: {
                    sessionId,
                    deviceId,
                    createdAt: timestamp // Track when the log document was first created
                },
            },
            { upsert: true } // Create the document if it doesn't exist
        );

        console.log(`Session event logged: ${eventType} for device ${deviceId}`);
    } catch (error) {
        console.error('Error logging session event:', error);
    }
}

// Sprint 8 - Log retention cleanup function
async function cleanupOldLogs() {
    const db = await connectDB();
    const sessionLogsCollection = db.collection('sessionLogs');
    
    const cutoffDate = new Date(Date.now() - LOG_RETENTION_MS);
    
    try {
        const result = await sessionLogsCollection.deleteMany({
            createdAt: { $lt: cutoffDate }
        });
        
        if (result.deletedCount > 0) {
            console.log(`Cleanup: Deleted ${result.deletedCount} old log documents older than ${LOG_RETENTION_DAYS} days`);
            // Log the cleanup operation itself
            await logSessionEvent('system', 'log_retention', 'cleanup_executed', `Deleted ${result.deletedCount} log documents older than ${LOG_RETENTION_DAYS} days`);
        }
    } catch (error) {
        console.error('Error during log cleanup:', error);
        await logSessionEvent('system', 'log_retention', 'cleanup_error', `Log cleanup failed: ${error.message}`);
    }
}

// Sprint 8 - Get logs with filtering and pagination for export
async function getSessionLogs(filters = {}, options = {}) {
    const db = await connectDB();
    const sessionLogsCollection = db.collection('sessionLogs');
    
    try {
        let query = {};
        
        // Apply filters
        if (filters.deviceId) {
            query.deviceId = filters.deviceId;
        }
        
        if (filters.sessionId) {
            query.sessionId = filters.sessionId;
        }
        
        if (filters.dateFrom || filters.dateTo) {
            query['events.timestamp'] = {};
            if (filters.dateFrom) {
                query['events.timestamp'].$gte = new Date(filters.dateFrom);
            }
            if (filters.dateTo) {
                query['events.timestamp'].$lte = new Date(filters.dateTo);
            }
        }
        
        if (filters.eventType) {
            query['events.type'] = filters.eventType;
        }
        
        // Set up pagination
        const limit = options.limit || 1000; // Default limit
        const skip = options.skip || 0;
        
        // Sort by creation date (newest first)
        const sort = options.sort || { createdAt: -1 };
        
        const logs = await sessionLogsCollection
            .find(query)
            .sort(sort)
            .skip(skip)
            .limit(limit)
            .toArray();
            
        return logs;
    } catch (error) {
        console.error('Error fetching session logs:', error);
        throw error;
    }
}

// Sprint 8 - Get logs in flattened format for export (CSV/Excel)
async function getSessionLogsFlattened(filters = {}, options = {}) {
    const logs = await getSessionLogs(filters, options);
    const flattenedLogs = [];
    
    logs.forEach(logDoc => {
        if (logDoc.events && Array.isArray(logDoc.events)) {
            logDoc.events.forEach(event => {
                // Apply event-level filters if specified
                if (filters.eventType && event.type !== filters.eventType) {
                    return;
                }
                
                if (filters.dateFrom && event.timestamp < new Date(filters.dateFrom)) {
                    return;
                }
                
                if (filters.dateTo && event.timestamp > new Date(filters.dateTo)) {
                    return;
                }
                
                flattenedLogs.push({
                    sessionId: logDoc.sessionId,
                    deviceId: logDoc.deviceId,
                    timestamp: event.timestamp,
                    eventType: event.type,
                    description: event.description,
                    logCreatedAt: logDoc.createdAt
                });
            });
        }
    });
    
    // Sort by timestamp (newest first)
    flattenedLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    return flattenedLogs;
}

// Sprint 8 - Get summary statistics for logs
async function getLogsSummary(filters = {}) {
    const db = await connectDB();
    const sessionLogsCollection = db.collection('sessionLogs');
    
    try {
        let matchQuery = {};
        
        // Apply filters
        if (filters.deviceId) {
            matchQuery.deviceId = filters.deviceId;
        }
        
        if (filters.sessionId) {
            matchQuery.sessionId = filters.sessionId;
        }
        
        if (filters.dateFrom || filters.dateTo) {
            matchQuery['events.timestamp'] = {};
            if (filters.dateFrom) {
                matchQuery['events.timestamp'].$gte = new Date(filters.dateFrom);
            }
            if (filters.dateTo) {
                matchQuery['events.timestamp'].$lte = new Date(filters.dateTo);
            }
        }
        
        const pipeline = [
            { $match: matchQuery },
            { $unwind: '$events' },
            {
                $group: {
                    _id: '$events.type',
                    count: { $sum: 1 },
                    firstOccurrence: { $min: '$events.timestamp' },
                    lastOccurrence: { $max: '$events.timestamp' }
                }
            },
            { $sort: { count: -1 } }
        ];
        
        const summary = await sessionLogsCollection.aggregate(pipeline).toArray();
        
        // Get total counts
        const totalSessions = await sessionLogsCollection.countDocuments(matchQuery);
        const totalEvents = summary.reduce((acc, item) => acc + item.count, 0);
        
        return {
            totalSessions,
            totalEvents,
            eventTypes: summary,
            retentionPolicy: `${LOG_RETENTION_DAYS} days`
        };
    } catch (error) {
        console.error('Error getting logs summary:', error);
        throw error;
    }
}

// Sprint 8 - Initialize log retention cleanup scheduler
function initializeLogRetention() {
    // Run cleanup every day at 2 AM
    const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
    
    // Run initial cleanup after 1 minute
    setTimeout(cleanupOldLogs, 60 * 1000);
    
    // Schedule regular cleanup
    setInterval(cleanupOldLogs, CLEANUP_INTERVAL);
    
    console.log(`Log retention policy initialized: ${LOG_RETENTION_DAYS} days retention, cleanup runs every 24 hours`);
}

module.exports = { 
    logSessionEvent,
    cleanupOldLogs,
    getSessionLogs,
    getSessionLogsFlattened,
    getLogsSummary,
    initializeLogRetention
};