module.exports = {
    async up(db, client) {
      const collections = await db.listCollections({ name: "web_admin_user" }).toArray();
      
      if(collections.length === 0) {
        await db.createCollection("web_admin_user", {
          validator: {
            $jsonSchema: {
              bsonType: "object",
              required: [
                "username",
                "password",
              ],
              properties: {
                userId: {
                  bsonType: "string",
                  description: "Unique user ID"
                },
                username: {
                  bsonType: "string",
                  description: "Username"
                },
                password: {
                  bsonType: "string",
                  description: "Password"
                },
              }
            }
          }
        });
      }
  
      console.log("Web Admin Users created successfully!");
    }
  };