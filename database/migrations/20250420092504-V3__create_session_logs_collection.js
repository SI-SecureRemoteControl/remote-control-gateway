module.exports = {
  async up(db, client) {
      const collections = await db.listCollections({ name: "sessionLogs" }).toArray();

      if(collections.length === 0){
        await db.createCollection("sessionLogs", {
          validator:{
            $jsonSchema: {
              bsonType: "object",
              required: ["sessionId", "deviceId"],
              properties: {
                sessionId: {
                    bsonType: "string",
                    description: "Unique session ID"
                },
                deviceId: {
                    bsonType: "string",
                    description: "Device ID associated with the session"
                },
                events:{
                  bsonType: "array",
                  items: {
                    bsonType: "object",
                    required: ["timestamp","type","description"],
                    properties: {
                      timestamp: {
                        bsonType :"date",
                        description: "Event timestamp"
                      },
                      type: {
                        bsonType: "string",
                        description: "Event type"
                      },
                      description: {
                        bsonType: "string",
                        description: "Event description"
                      }
                    }
                  },
                  description: "List of events associated with the session"
                }
              }
            }
          },
          validationLevel: "strict",
            validationAction: "error"
        })
        console.log("'session_logs' collection created successfully.");
      }
      else{
        console.log("'session_logs' collection already exists. Skipping creation.");
      }
  },

  async down(db, client) {
    const collections = await db.listCollections({ name: "session_logs" }).toArray();

    if (collections.length > 0) {
      await db.collection("session_logs").drop();
      console.log("'session_logs' collection dropped successfully.");
    } else {
      console.log("'session_logs' collection does not exist. Skipping drop.");
    }
  }
};
