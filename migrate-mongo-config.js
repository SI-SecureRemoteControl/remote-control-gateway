require('dotenv').config();

const isLocal = process.env.USE_LOCAL_DB === "true";
const dbUri = isLocal ? process.env.DB_URI_LOCAL : process.env.DB_URI;

const config = {
  mongodb: {
    url: dbUri,
    databaseName: "SecureRemoteControl",
    options: {
      useNewUrlParser: true, 
      useUnifiedTopology: true, 
    }
  },
  migrationsDir: "database/migrations",
  changelogCollectionName: "changelog",
  lockCollectionName: "changelog_lock",
  lockTtl: 0,
  migrationFileExtension: ".js",
  useFileHash: false,
  moduleSystem: 'commonjs',
};

module.exports = config;
