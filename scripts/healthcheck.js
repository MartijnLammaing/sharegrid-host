'use strict';
// Tiny healthcheck script for the distroless runtime image.
// Executed by Docker's HEALTHCHECK instruction via Node.js.
// Probes llama.cpp's GET /health endpoint over the internal Unix socket.
// Exit 0 = healthy, exit 1 = unhealthy or unreachable.
const http = require('http');

const req = http.request(
  { socketPath: '/tmp/llama.sock', path: '/health', method: 'GET' },
  (res) => {
    process.exitCode = res.statusCode === 200 ? 0 : 1;
    res.resume(); // drain the response body so the socket closes cleanly
  },
);

req.setTimeout(5000, () => {
  req.destroy();
  process.exitCode = 1;
});

req.on('error', () => {
  process.exitCode = 1;
});

req.end();
