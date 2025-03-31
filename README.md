# Secure Remote Control Gateway

## Overview
The **Secure Remote Control Gateway** is a Node.js-based server that acts as a communication layer between IT admins and Android devices. It facilitates secure WebSocket-based real-time interactions, including device registration, WebRTC signaling, and remote control commands.

## Features
- **Device Registration**: Securely register Android devices with unique IDs.
- **WebSocket Communication**: Maintain persistent bidirectional communication.
- **WebRTC Signaling**: Enable real-time screen sharing and remote control.
- **Status Updates**: Track devices as online/offline via heartbeat signals.
- **Session Management**: Auto-terminate inactive sessions.
- **End-to-End Encryption (TLS 1.2+)**: Ensure secure data transmission.

## Technologies Used
- **Node.js** (Express, WebSocket)
- **WebSockets** for real-time communication
- **WebRTC** for screen sharing and remote control
- **JWT Authentication (Future Enhancement)**
- **Docker (Optional for Deployment)**

## Installation & Setup
### Prerequisites
Ensure you have Node.js installed:
```sh
node -v  # Check Node.js version
npm -v   # Check npm version
```
### Clone the Repository
```sh
git clone https://github.com/your-username/secure-remote-control-gateway.git
cd secure-remote-control-gateway
```

### Install Dependencies
```sh
npm install
```
### Start the Server
```sh
node server.js
```
By default, the server runs on http://localhost:8080.