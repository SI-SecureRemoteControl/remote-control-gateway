const bcrypt = require('bcrypt');

module.exports = {
    async up(db, client) {
        const collections = await db.listCollections({ name: "web_admin_user" }).toArray();

        if (collections.length === 0) {
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
                                description: "Password (bcrypt hash)"
                            },
                        }
                    }
                }
            });
        }

        // Add default admin user if it doesn't exist already
        const adminUser = await db.collection("web_admin_user").findOne({ username: "administrator" });
        if (!adminUser) {
            const plainPassword = "12345678";
            const hash = await bcrypt.hash(plainPassword, 10);
            await db.collection("web_admin_user").insertOne({
                username: "administrator",
                password: hash
            });
            console.log('Default admin user "administrator" created.');
        } else {
            console.log('Default admin user "administrator" already exists. Skipping insert.');
        }

        console.log("Web Admin Users created successfully!");
    }
};