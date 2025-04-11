const { MongoClient, ServerApiVersion } = require('mongodb');
const { up } = require('migrate-mongo');
require('dotenv').config();

const isLocal = process.env.USE_LOCAL_DB === "true";
const dbUri = isLocal ? process.env.DB_URI_LOCAL : process.env.DB_URI;

const client = new MongoClient(dbUri, {
    tlsAllowInvalidCertificates: true,
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
  },
});

async function migrate() {
    try {
        console.log("Connecting to MongoDB...");
        await client.connect();
        const db = client.db(process.env.DB_NAME || "SecureRemoteControl");

        console.log("Running migrations...");
        await up(db, client); 

        console.log("Migrations applied successfully!");
        process.exit(0);
    } catch (error) {
        console.error("Error during migration:", error);
        process.exit(1);
    }
}

migrate();
