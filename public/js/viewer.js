// DOM Elements
const videoElement = document.getElementById('remoteVideo');
const statusElement = document.getElementById('status');
const reconnectButton = document.getElementById('reconnectButton');

// Global variables
let socket;
let peerConnection;
let broadcasterId;
let reconnectInterval = null;
let isConnected = false;
let config = {
  iceServers: [], // Will be populated from server
  iceCandidatePoolSize: 10
};

// Get the broadcaster ID from URL query parameters
function getBroadcasterId() {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('id') || 'default';
}

// Fetch TURN configuration
async function getIceConfig() {
  try {
    const response = await fetch('/turn-config');
    const data = await response.json();
    config.iceServers = [data.turnServer];
    console.log('Fetched TURN config:', config);
  } catch (error) {
    console.error('Error fetching TURN config:', error);
    // Fallback configuration
    config.iceServers = [
      {
        urls: `turn:${window.location.hostname}:3478`,
        username: 'webcamuser',
        credential: 'webcamsecret'
      }
    ];
  }
}

// Initialize WebSocket connection
async function initialize() {
  // First fetch the ICE servers configuration
  await getIceConfig();
  
  // Then initialize the WebSocket
  initWebSocket();
}

function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  
  console.log(`Connecting to WebSocket at ${wsUrl}`);
  
  socket = new WebSocket(wsUrl);
  
  socket.onopen = () => {
    console.log('WebSocket connection established');
    updateConnectionStatus('connecting');
    
    // Clear any reconnect interval
    if (reconnectInterval) {
      clearInterval(reconnectInterval);
      reconnectInterval = null;
    }
    
    // Register as viewer
    socket.send(JSON.stringify({
      type: 'register-viewer'
    }));
  };
  
  socket.onclose = () => {
    console.log('WebSocket connection closed');
    updateConnectionStatus('disconnected');
    
    // Try to reconnect every 5 seconds
    if (!reconnectInterval) {
      reconnectInterval = setInterval(() => {
        if (!isConnected) {
          console.log('Attempting to reconnect...');
          initWebSocket();
        }
      }, 5000);
    }
  };
  
  socket.onerror = (error) => {
    console.error('WebSocket error:', error);
    updateConnectionStatus('error');
  };
  
  socket.onmessage = handleWebSocketMessage;
}

// Update connection status display
function updateConnectionStatus(status) {
  isConnected = (status === 'streaming');
  
  if (statusElement) {
    let statusText = 'Unknown';
    
    switch(status) {
      case 'disconnected':
        statusText = 'Disconnected';
        statusElement.className = 'status status-disconnected';
        break;
      case 'connecting':
        statusText = 'Connecting to server...';
        statusElement.className = 'status status-connecting';
        break;
      case 'waiting':
        statusText = 'Waiting for broadcaster...';
        statusElement.className = 'status status-connecting';
        break;
      case 'streaming':
        statusText = 'Connected to stream';
        statusElement.className = 'status status-broadcasting';
        break;
      case 'error':
        statusText = 'Connection error';
        statusElement.className = 'status status-error';
        break;
    }
    
    statusElement.textContent = statusText;
  }
  
  // Update button state
  if (reconnectButton) {
    reconnectButton.disabled = (status === 'connecting' || status === 'streaming');
  }
}

// Handle incoming WebSocket messages
function handleWebSocketMessage(event) {
  const data = JSON.parse(event.data);
  
  switch (data.type) {
    case 'viewer-registered':
      console.log(`Registered as viewer with ID: ${data.viewerId}`);
      
      // Request offer from broadcaster
      broadcasterId = getBroadcasterId();
      requestOffer();
      break;
    
    case 'offer':
      handleOffer(data.offer);
      break;
    
    case 'ice-candidate':
      handleRemoteICECandidate(data.candidate);
      break;
    
    case 'error':
      console.error('Error from server:', data.message);
      updateConnectionStatus('error');
      
      if (data.message.includes('Broadcaster not found')) {
        updateConnectionStatus('waiting');
        
        // Try to request offer again after a delay
        setTimeout(() => {
          if (socket && socket.readyState === WebSocket.OPEN) {
            requestOffer();
          }
        }, 5000);
      } else {
        alert(`Error: ${data.message}`);
      }
      break;
    
    default:
      console.log(`Unknown message type: ${data.type}`);
  }
}

// Request offer from broadcaster
function requestOffer() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    console.log(`Requesting offer from broadcaster: ${broadcasterId}`);
    console.log(`Connecting via ${window.location.hostname} to broadcaster: ${broadcasterId}`);
    updateConnectionStatus('waiting');
    
    socket.send(JSON.stringify({
      type: 'request-offer',
      broadcasterId: broadcasterId
    }));
  }
}

// Handle incoming offer
function handleOffer(offer) {
  console.log('Received offer from broadcaster');
  
  // Create peer connection if it doesn't exist
  if (!peerConnection) {
    createPeerConnection();
  }
  
  // Set remote description
  peerConnection.setRemoteDescription(new RTCSessionDescription(offer))
    .then(() => {
      console.log('Creating answer');
      return peerConnection.createAnswer();
    })
    .then(answer => {
      console.log('Setting local description');
      return peerConnection.setLocalDescription(answer);
    })
    .then(() => {
      console.log('Sending answer to broadcaster');
      socket.send(JSON.stringify({
        type: 'answer',
        answer: peerConnection.localDescription,
        broadcasterId: broadcasterId
      }));
    })
    .catch(error => {
      console.error('Error handling offer:', error);
      updateConnectionStatus('error');
    });
}

// Create RTCPeerConnection
function createPeerConnection() {
  console.log('Creating RTCPeerConnection');
  
  // Force TURN usage by setting iceTransportPolicy to 'relay'
  const peerConfig = {
    ...config,
    iceTransportPolicy: 'all' // Try 'relay' to force TURN usage if needed
  };
  
  peerConnection = new RTCPeerConnection(peerConfig);
  
  peerConnection.ontrack = handleRemoteTrack;
  
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      console.log('Generated local ICE candidate:', event.candidate);
      console.log('Sending ICE candidate to broadcaster');
      socket.send(JSON.stringify({
        type: 'ice-candidate',
        candidate: event.candidate,
        broadcasterId: broadcasterId,
        target: 'broadcaster'
      }));
    }
  };
  
  peerConnection.oniceconnectionstatechange = () => {
    console.log('ICE connection state:', peerConnection.iceConnectionState);
    
    if (peerConnection.iceConnectionState === 'connected' || 
        peerConnection.iceConnectionState === 'completed') {
      updateConnectionStatus('streaming');
    } else if (peerConnection.iceConnectionState === 'failed' || 
              peerConnection.iceConnectionState === 'disconnected') {
      updateConnectionStatus('disconnected');
      console.log('ICE connection failed or disconnected');
    }
  };
  
  return peerConnection;
}

// Handle remote media tracks
function handleRemoteTrack(event) {
  console.log('Received remote track of type:', event.track.kind);
  
  if (!videoElement) {
    console.error('Video element not found!');
    return;
  }

  // Set video to muted to allow autoplay
   videoElement.muted = true;
  
  // Ensure we have a valid video element
  if (event.streams && event.streams[0]) {
    console.log('Using stream from event');
    videoElement.srcObject = event.streams[0];
  } else {
    console.log('Creating new MediaStream');
    // Fallback if no streams array
    if (!videoElement.srcObject) {
      videoElement.srcObject = new MediaStream();
    }
    videoElement.srcObject.addTrack(event.track);
  }
  
  // Ensure autoplay works
  videoElement.onloadedmetadata = () => {
    console.log(`Video metadata loaded, dimensions: ${videoElement.videoWidth}x${videoElement.videoHeight}`);
    videoElement.play().catch(e => console.error('Autoplay failed:', e));
  };

  
  updateConnectionStatus('streaming');
}

// Handle ICE candidate from remote peer
function handleRemoteICECandidate(candidate) {
  console.log('Received remote ICE candidate:', candidate);
  
  if (peerConnection) {
    peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
      .then(() => {
        console.log('Successfully added ICE candidate');
      })
      .catch(error => {
        console.error('Error adding ICE candidate:', error);
        const host = window.location.hostname;
        config.iceServers = [
          {
            urls: `turn:${host}:3478`,
            username: 'webcamuser',
            credential: 'webcamsecret'
          }
        ];
      });
  }
}

// Manual reconnect
function reconnect() {
  // Close existing connections
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  
  if (socket) {
    socket.close();
  }
  
  // Initialize connection again
  initialize();
}

// Clean up resources
function cleanup() {
  if (peerConnection) {
    peerConnection.close();
  }
  
  if (socket) {
    socket.close();
  }
  
  if (reconnectInterval) {
    clearInterval(reconnectInterval);
  }
}

// Event listeners
if (reconnectButton) {
  reconnectButton.addEventListener('click', reconnect);
}

// Initialize on page load
window.addEventListener('load', initialize);

// Clean up on page unload
window.addEventListener('beforeunload', cleanup);