const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Turn = require('node-turn');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const os = require('os');

// Configure Express
const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);


// Find a suitable local network IP
const interfaces = os.networkInterfaces();
let localIp = '127.0.0.1';

Object.keys(interfaces).forEach((ifname) => {
  interfaces[ifname].forEach((iface) => {
    if (iface.family === 'IPv4' && !iface.internal) {
      localIp = iface.address;
    }
  });
});

// Add network info endpoint for copy link function
app.get('/network-info', (req, res) => {
  const networkInterfaces = os.networkInterfaces();
  const addresses = {
    lanIp: null,
    wifiIp: null
  };
  
  // Look for LAN (Ethernet) interfaces first, then WiFi
  Object.keys(networkInterfaces).forEach(interfaceName => {
    const interfaces = networkInterfaces[interfaceName];
    
    // Look for IPv4 addresses only
    interfaces.forEach(interface => {
      if (interface.family === 'IPv4' && !interface.internal) {
        // Check if this is Ethernet or LAN
        if (interfaceName.toLowerCase().includes('eth') || 
            interfaceName.toLowerCase().includes('en')) {
          // Prioritize Ethernet/LAN
          addresses.lanIp = addresses.lanIp || interface.address;
        } else if (interfaceName.toLowerCase().includes('wl') || 
                  interfaceName.toLowerCase().includes('wi')) {
          // Secondary priority for WiFi
          addresses.wifiIp = addresses.wifiIp || interface.address;
        }
      }
    });
  });
  
  res.json(addresses);
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Create TURN server instance
const turnServer = new Turn({
  authMech: 'long-term',
  credentials: {
    username: "webcamuser",
    password: "webcamsecret"
  },
  listeningIps: [localIp], // Use local network IP
  listeningPort: 3478,
  realm: 'webcam.local',
  debugLevel: 'INFO'
});

// Start TURN server
turnServer.start();
console.log(`TURN server started on ${localIp}:3478`);

// Expose TURN configuration to clients
app.get('/turn-config', (req, res) => {
  const serverIp = req.headers['x-forwarded-for'] || 
  req.connection.remoteAddress || 
  req.socket.remoteAddress ||
  (req.connection.socket ? req.connection.socket.remoteAddress : null);

const ipToUse = serverIp === '::1' || serverIp === '127.0.0.1' ? 
 req.headers.host.split(':')[0] : 
 serverIp.includes('::ffff:') ? 
 serverIp.split('::ffff:')[1] : 
 serverIp;
  res.json({
    turnServer: {
      urls: `turn:${ipToUse}:3478`,
      username: 'webcamuser',
      credential: 'webcamsecret'
    }
  });
});

// Store clients
const broadcasters = new Map(); // Maps broadcasterId -> broadcaster socket
const viewers = new Map(); // Maps viewerId -> viewer socket

// Handle WebSocket connections
wss.on('connection', (socket) => {
  console.log('Client connected');
  
  // Assign a unique ID to this socket
  socket.id = uuidv4();
  
  // Handle socket closing
  socket.on('close', () => {
    // Check if this was a broadcaster
    if (socket.broadcasterId) {
      console.log(`Broadcaster ${socket.broadcasterId} removed`);
      broadcasters.delete(socket.broadcasterId);
    }
    
    // Check if this was a viewer
    if (socket.viewerId) {
      console.log(`Viewer ${socket.viewerId} removed`);
      viewers.delete(socket.viewerId);
    }
    
    console.log('Client disconnected');
  });
  
  // Handle messages
  socket.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'register-broadcaster':
          const broadcasterId = data.broadcasterId || 'default';
          
          // Remove existing broadcaster with same ID
          const existingBroadcaster = broadcasters.get(broadcasterId);
          if (existingBroadcaster) {
            existingBroadcaster.close();
          }
          
          // Register new broadcaster
          socket.broadcasterId = broadcasterId;
          broadcasters.set(broadcasterId, socket);
          console.log(`Broadcaster registered with ID: ${broadcasterId}`);
          
          // Send confirmation
          socket.send(JSON.stringify({
            type: 'broadcaster-registered',
            broadcasterId
          }));
          break;
        
        case 'register-viewer':
          // Generate unique viewer ID
          const viewerId = uuidv4();
          
          // Register viewer
          socket.viewerId = viewerId;
          viewers.set(viewerId, socket);
          console.log('Viewer registered');
          
          // Send confirmation
          socket.send(JSON.stringify({
            type: 'viewer-registered',
            viewerId
          }));
          break;
        
        case 'request-offer':
          const requestedBroadcasterId = data.broadcasterId || 'default';
          console.log(`Viewer requesting offer from broadcaster: ${requestedBroadcasterId}`);
          
          // Find broadcaster
          const requestedBroadcaster = broadcasters.get(requestedBroadcasterId);
          
          if (requestedBroadcaster) {
            // Ask broadcaster to create offer for this viewer
            requestedBroadcaster.send(JSON.stringify({
              type: 'create-offer',
              viewerId: socket.viewerId
            }));
          } else {
            console.log(`Broadcaster ${requestedBroadcasterId} not found`);
            socket.send(JSON.stringify({
              type: 'error',
              message: `Broadcaster ${requestedBroadcasterId} not found`
            }));
          }
          break;
        
        case 'offer':
          const offerViewerId = data.viewerId;
          const offerViewer = viewers.get(offerViewerId);
          
          if (offerViewer) {
            console.log('Forwarding offer to viewer');
            offerViewer.send(JSON.stringify({
              type: 'offer',
              offer: data.offer,
              broadcasterId: socket.broadcasterId
            }));
          }
          break;
        
        case 'answer':
          const answerBroadcasterId = data.broadcasterId;
          const answerBroadcaster = broadcasters.get(answerBroadcasterId);
          
          if (answerBroadcaster) {
            console.log('Forwarding answer to broadcaster');
            answerBroadcaster.send(JSON.stringify({
              type: 'answer',
              answer: data.answer,
              viewerId: socket.viewerId
            }));
          }
          break;
        
        case 'ice-candidate':
          // Forward ICE candidate to the appropriate target
          if (data.target === 'broadcaster') {
            const candidateBroadcaster = broadcasters.get(data.broadcasterId);
            if (candidateBroadcaster) {
              candidateBroadcaster.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: data.candidate,
                viewerId: socket.viewerId
              }));
            }
          } else if (data.target === 'viewer') {
            const candidateViewer = viewers.get(data.viewerId);
            if (candidateViewer) {
              candidateViewer.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: data.candidate,
                broadcasterId: data.broadcasterId
              }));
            }
          }
          break;
        
        case 'heartbeat':
          // Just a keep-alive message, no response needed
          break;
        
        default:
          console.log(`Unknown message type: ${data.type}`);
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  const networkInterfaces = Object.values(os.networkInterfaces())
    .flat()
    .filter(details => details.family === 'IPv4' && !details.internal)
    .map(details => details.address);

  console.log(`Server listening on port ${PORT}`);
  console.log(`Local access: http://localhost:${PORT}`);
  console.log(`Network access: http://${networkInterfaces[0] || 'unknown'}:${PORT}`);
  console.log(`Share this link with viewers: http://${networkInterfaces[0] || 'localhost'}:${PORT}/viewer.html?id=default`);
  console.log(`TURN server running at ${localIp}:3478`);
});