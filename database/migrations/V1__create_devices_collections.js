module.exports = {
    async up(db, client) {
      await db.createCollection("devices", {
        validator: {
          $jsonSchema: {
            bsonType: "object",
            required: [
              "name",
              "registrationKey",
            ],
            properties: {
              deviceId: {
                bsonType: "string",
                description: "Unique device ID"
              },
              name: {
                bsonType: "string",
                description: "Device name"
              },
              model: {
                bsonType: "string",
                description: "Device model"
              },
              osVersion: {
                bsonType: "string",
                description: "Operating system version"
              },
              registrationKey: {
                bsonType: "string",
                description: "Key used for registering the device"
              },
              status: {
                bsonType: "string",
                enum: ["active", "inactive", "pending"],
                description: "Device status"
              },
              networkType: {
                bsonType: "string",
                enum: ["wifi", "mobileData"],
                description: "Type of network connection"
              },
              ipAddress: {
                bsonType: "string",
                pattern: "^([0-9]{1,3}\\.){3}[0-9]{1,3}$",
                description: "IP address of the device"
              },
              lastActiveTime: {
                bsonType: "date",
                description: "Last active timestamp"
              }
            }
          }
        }
      });
  
      console.log("Collections created successfully!");
    }
  };