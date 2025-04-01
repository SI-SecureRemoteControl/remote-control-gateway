const { MongoClient, ServerApiVersion } = require('mongodb');
const { up, database } = require("migrate-mongo");

require('dotenv').config(); // Dodaj ovo na početak

const isLocal = process.env.USE_LOCAL_DB === "true";
const dbUri = isLocal ? process.env.DB_URI_LOCAL : process.env.DB_URI;

console.log(dbUri);

const client = new MongoClient(dbUri, {
    tlsAllowInvalidCertificates: true,
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
});

async function run() {
  try {
    // Connect the client to the server (optional starting in v4.7)
    await client.connect();
    // Send a ping to confirm a successful connection
    //await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } catch (error) {
    console.error("Failed to connect:", error);
  }
}

async function connectAndMigrate() {
    try {
        console.log("Connecting to MongoDB...");
        
        // Konekcija na bazu pomoću migrate-mongo
        const { db } = await database.connect();

        console.log("Running migrations...");
        await up(db, client);
        
        console.log("Migrations applied!");
    } catch (error) {
        console.error("Error during migration:", error);
    }
}

// Pokreni migracije
run().then(() => {
    connectAndMigrate();
});