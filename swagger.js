const swaggerJSDoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Support Session API',
      version: '1.0.0',
      description: 'API for managing secure remote support sessions',
    },
    servers: [
      {
        url: process.env.SERVICE_URL,
      },
    ],
  },
  apis: ["./server.js"], // or wherever your route files are
};

const swaggerSpec = swaggerJSDoc(options);
module.exports = swaggerSpec;
