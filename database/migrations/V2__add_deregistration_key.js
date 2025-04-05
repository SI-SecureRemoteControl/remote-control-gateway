module.exports = {
  async up(db, client) {
    const collectionInfo = await db.command({
      listCollections: 1,
      filter: { name: "devices" }
    });

    const currentValidator = collectionInfo.cursor.firstBatch[0]?.options?.validator;

    if (!currentValidator || !currentValidator.$jsonSchema) {
      throw new Error("Validator with $jsonSchema not found for 'devices' collection.");
    }

    const newSchema = JSON.parse(JSON.stringify(currentValidator.$jsonSchema));

    newSchema.properties["deregistration_key"] = {
      bsonType: "string",
      description: "Key used for deregistering the device"
    };

    await db.command({
      collMod: "devices",
      validator: { $jsonSchema: newSchema }
    });

    console.log("✅ Successfully added 'deregistration_key' to schema.");
  },
};
