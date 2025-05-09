const { MongoClient, ServerApiVersion } = require('mongodb');
require('dotenv').config();

const isLocal = process.env.USE_LOCAL_DB === "true";
const dbUri = isLocal ? process.env.DB_URI_LOCAL : process.env.DB_URI;


const client = new MongoClient(dbUri, {
    maxPoolSize: 10,
    minPoolSize: 2,
    tlsAllowInvalidCertificates: true,
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
});

let dbInstance;

async function connectDB() {
    if (!dbInstance) {
        try {
            await client.connect();
            dbInstance = client.db(process.env.DB_NAME || "SecureRemoteControl"); 
            console.log("Connected to MongoDB:", dbInstance.databaseName);

        } catch (error) {
            console.error("MongoDB connection error:", error);
            throw error;
        }
    }
    return dbInstance;
}

module.exports = {
    connectDB,
    client,
};
