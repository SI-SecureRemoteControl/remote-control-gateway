const WebSocket = require('ws');
const readline = require('readline');

let backendWs = null;

const wss = new WebSocket.Server({ port: 8082, path: '/ws/control/comm' });

wss.on('connection', ws => {
    console.log('Web Admin: Backend connected!');
    backendWs = ws;

    ws.on('message', msg => {
        console.log('Web Admin received:', msg.toString());

        try {
            const data = JSON.parse(msg);

            // Automatski odobri fileshare sesiju
            if (data.type === 'request_session_fileshare') {
                ws.send(JSON.stringify({
                    type: 'decision_fileshare',
                    sessionId: data.sessionId,
                    decision: true
                }));

                askDownloadRequest();
            }

            // Automatski odobri klasičnu kontrolnu sesiju
            if (data.type === 'session_request') {
                ws.send(JSON.stringify({
                    type: 'control_decision',
                    sessionId: data.token,
                    decision: 'accepted'
                }));
            }

            // Potvrdi primanje finalne potvrde sesije
            if (data.type === 'session_final_confirmation') {
                ws.send(JSON.stringify({
                    type: 'session_final_ack',
                    sessionId: data.token,
                    status: 'ok'
                }));
            }

            // Odgovori na info/test poruke
            if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
            }

            // Prikaži upload_status poruku od COMM layera
            if (data.type === 'upload_status') {
                console.log(
                    `\n[WEB ADMIN MOCK] Upload status received:\n` +
                    `  Device:     ${data.deviceId}\n` +
                    `  SessionId:  ${data.sessionId}\n` +
                    `  Status:     ${data.status}\n` +
                    `  Message:${data.message}\n`
                );
            }

        } catch (e) {
            console.error('Web Admin mock parse error:', e);
        }
    });
});
console.log('Web Admin mock server listening on ws://localhost:8081/ws/control/comm');

// CLI za slanje download_request poruke
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function askDownloadRequest() {
    rl.question('\nPošalji download_request (deviceId sessionId paths): ', (input) => {
        if (!backendWs || backendWs.readyState !== WebSocket.OPEN) {
            console.log('Backend nije povezan!');
            return askDownloadRequest();
        }
        // Očekuje: deviceId sessionId paths
        const [deviceId, sessionId, ...pathsArr] = input.trim().split(/\s+/);
        if (!deviceId || !sessionId || pathsArr.length === 0) {
            console.log('Format: deviceId sessionId paths (npr: c7d865a558032f35 <token> upload-c7d865a558032f35-1747444009912.zip)');
            return askDownloadRequest();
        }
        backendWs.send(JSON.stringify({
            type: "download_request",
            deviceId,
            sessionId,
            paths: pathsArr.length === 1 ? pathsArr[0] : pathsArr
        }));
        console.log('Poslata download_request poruka COMM layeru.');
        askDownloadRequest();
    });
}