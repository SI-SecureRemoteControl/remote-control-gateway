module.exports = {
  async up(db, client) {
    await db.createCollection("users", {
      validator: {
        $jsonSchema: {
          bsonType: "object",
          required: ["name", "email"],
          properties: {
            name: { bsonType: "string", description: "User's name" },
            email: { bsonType: "string", description: "User's email" },
          },
        },
      },
    });

    await db.createCollection("products", {
      validator: {
        $jsonSchema: {
          bsonType: "object",
          required: ["name", "price"],
          properties: {
            name: { bsonType: "string", description: "Product name" },
            price: { bsonType: "double", description: "Product price" },
          },
        },
      },
    });

    await db.createCollection("orders", {
      validator: {
        $jsonSchema: {
          bsonType: "object",
          required: ["user_id", "product_id", "quantity"],
          properties: {
            user_id: { bsonType: "objectId", description: "User ID" },
            product_id: { bsonType: "objectId", description: "Product ID" },
            quantity: { bsonType: "int", description: "Quantity ordered" },
          },
        },
      },
    });

    console.log("Collections created successfully!");
  },

  async down(db, client) {
    await db.collection("orders").drop();
    await db.collection("products").drop();
    await db.collection("users").drop();
    console.log("Collections dropped!");
  },
};