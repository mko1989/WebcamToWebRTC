// DOM Elements
const videoElement = document.getElementById('localVideo');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const statusElement = document.getElementById('status');
const broadcasterIdElement = document.getElementById('broadcasterId');
const viewerCountElement = document.getElementById('viewerCount');
const cameraSelectElement = document.getElementById('cameraSelect');
const copyLinkButton = document.getElementById('copyLinkButton');

// Global variables
let socket;
let localStream;
let peerConnections = {};
let broadcasterId = 'default';
let isStreaming = false;
let activeViewers = new Set();
let config = {
  iceServers: [], // Will be populated from server
  iceCandidatePoolSize: 10
};

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
  
  // And list available cameras
  listCameras();
}

function initWebSocket() {
  // Get WebSocket URL
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  
  console.log(`Connecting to WebSocket at ${wsUrl}`);
  
  socket = new WebSocket(wsUrl);
  
  socket.onopen = () => {
    console.log('WebSocket connection established');
    updateStatus('Connected to server');
    
    // Register as broadcaster
    registerAsBroadcaster();
  };
  
  socket.onclose = () => {
    console.log('WebSocket connection closed');
    updateStatus('Disconnected from server');
  };
  
  socket.onerror = (error) => {
    console.error('WebSocket error:', error);
    updateStatus('Connection error');
  };
  
  socket.onmessage = handleWebSocketMessage;
}

// Register as broadcaster with the server
function registerAsBroadcaster() {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'register-broadcaster',
      broadcasterId: broadcasterId
    }));
  }
}

// Update status display
function updateStatus(status) {
  if (statusElement) {
    statusElement.textContent = `Status: ${status}`;
    
    // Update status class - use simple status values without spaces
    statusElement.className = 'status';
    
    // Convert status to a valid class name (remove spaces, use hyphens instead)
    const statusClass = status.toLowerCase().replace(/\s+/g, '-');
    statusElement.classList.add(`status-${statusClass}`);
  }
  
  // Update button states
  if (startButton && stopButton) {
    if (isStreaming) {
      startButton.disabled = true;
      stopButton.disabled = false;
      if (copyLinkButton) {
        copyLinkButton.disabled = false;
      }
    } else {
      startButton.disabled = false;
      stopButton.disabled = true;
      if (copyLinkButton) {
        copyLinkButton.disabled = true;
      }
    }
  }
  
  // Update broadcaster ID display
  if (broadcasterIdElement) {
    broadcasterIdElement.value = broadcasterId;
  }
}

// Update viewer count display
function updateViewerCount() {
  const broadcastInfo = document.getElementById('broadcastInfo');
  if (broadcastInfo) {
    if (activeViewers.size > 0) {
      broadcastInfo.innerHTML = `<p>Active viewers: ${activeViewers.size}</p>`;
    } else {
      broadcastInfo.innerHTML = '<p>No active viewers</p>';
    }
  }
}

// List available cameras
async function listCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(device => device.kind === 'videoinput');
    
    // Clear existing options
    cameraSelectElement.innerHTML = '';
    
    // Add option for each camera
    videoDevices.forEach(device => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.text = device.label || `Camera ${cameraSelectElement.length + 1}`;
      cameraSelectElement.appendChild(option);
    });
    
    // If no labels are available, we need to request permission first
    if (videoDevices.length > 0 && !videoDevices[0].label) {
      console.log('Requesting temporary camera access to get labels');
      const tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
      tempStream.getTracks().forEach(track => track.stop()); // Stop the tracks immediately
      
      // Try again after getting permission
      listCameras();
    }
  } catch (error) {
    console.error('Error listing cameras:', error);
  }
}

// Apply high quality settings to prevent resolution downscaling
function applyHighQualitySettings(peerConnection) {
  // Get all RTCRtpSenders
  const senders = peerConnection.getSenders();
  
  senders.forEach(sender => {
    if (sender.track && sender.track.kind === 'video') {
      const parameters = sender.getParameters();
      
      if (!parameters.encodings) {
        parameters.encodings = [{}];
      }
      
      // Set high bitrate for local network
      parameters.encodings[0].maxBitrate = 10000000; // 20 Mbps
      
      // Force resolution maintenance
      parameters.degradationPreference = 'maintain-resolution';
      
      // Prevent downscaling
      parameters.encodings[0].scaleResolutionDownBy = 1.0;
      
      sender.setParameters(parameters).catch(e => {
        console.error('Failed to set sender parameters:', e);
      });
    }
  });
}

// Modify SDP to ensure high quality
function modifySdpForHighQuality(sdp) {
  // Increase bandwidth limits in SDP
  sdp = sdp.replace(/b=AS:([0-9]+)/g, 'b=AS:10000');
  
  // Force high resolution
  const lines = sdp.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('a=rtpmap:96 VP8') !== -1 || 
        lines[i].indexOf('a=rtpmap:98 H264') !== -1) {
      lines.splice(i + 1, 0, 'a=fmtp:96 x-google-max-bitrate=10000;x-google-min-bitrate=5000;x-google-start-bitrate=7500');
    }
  }
  sdp = lines.join('\n');
  
  return sdp;
}

// Handle incoming WebSocket messages
function handleWebSocketMessage(event) {
  const data = JSON.parse(event.data);
  
  switch (data.type) {
    case 'broadcaster-registered':
      console.log(`Registered as broadcaster with ID: ${data.broadcasterId}`);
      broadcasterId = data.broadcasterId;
      updateStatus('Registered as broadcaster');
      break;
    
    case 'create-offer':
      if (isStreaming) {
        createOffer(data.viewerId);
        activeViewers.add(data.viewerId);
        updateViewerCount();
      }
      break;
    
    case 'answer':
      handleAnswer(data.answer, data.viewerId);
      break;
    
    case 'ice-candidate':
      handleRemoteICECandidate(data.candidate, data.viewerId);
      break;
    
    case 'error':
      console.error('Error from server:', data.message);
      alert(`Error: ${data.message}`);
      break;
    
    default:
      console.log(`Unknown message type: ${data.type}`);
  }
}

// Start streaming
async function startStreaming() {
  try {
    console.log('Requesting access to local camera and microphone');
    
    const enableAudio = document.getElementById('enableAudio')?.checked ?? true;
    const videoQuality = document.getElementById('videoQuality')?.value || 'medium';
    
    // Configure video constraints based on quality setting
    let videoConstraints = { deviceId: undefined };
    
    // Add camera selection if available
    if (cameraSelectElement && cameraSelectElement.value) {
      videoConstraints.deviceId = { exact: cameraSelectElement.value };
    }
    
    // Add quality settings
    if (videoQuality === 'medium') {
      videoConstraints = { ...videoConstraints, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 50 } };
    } else { // Default to high
      videoConstraints = { ...videoConstraints, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 50 } };
    }
    
    const constraints = {
      audio: enableAudio,
      video: videoConstraints
    };
    
    // Log the constraints we're using
    console.log('Using media constraints:', constraints);
    
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    
    // Display local video stream
    if (videoElement) {
      videoElement.srcObject = localStream;
    }
    
    isStreaming = true;
    updateStatus('broadcasting');
    
    console.log('Local camera and microphone access granted');
  } catch (error) {
    console.error('Error accessing media devices:', error);
    alert(`Could not access camera or microphone: ${error.message}`);
    updateStatus('error');
  }
}

// Stop streaming
function stopStreaming() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  
  // Close all peer connections
  Object.keys(peerConnections).forEach(viewerId => {
    if (peerConnections[viewerId]) {
      peerConnections[viewerId].close();
      delete peerConnections[viewerId];
    }
  });
  
  // Clear viewer list
  activeViewers.clear();
  updateViewerCount();
  
  isStreaming = false;
  updateStatus('disconnected');
  
  if (videoElement) {
    videoElement.srcObject = null;
  }
}

// Create offer for a specific viewer
function createOffer(viewerId) {
  console.log(`Creating offer for viewer: ${viewerId}`);
  
  // Create a new RTCPeerConnection for this viewer
  const peerConnection = new RTCPeerConnection(config);
  peerConnections[viewerId] = peerConnection;
  
  // Add local stream tracks to peer connection
  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
  }
  
  // Apply high quality settings to prevent resolution downscaling
  applyHighQualitySettings(peerConnection);
  
  // Handle ICE candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      console.log('Generated local ICE candidate:', event.candidate);
      socket.send(JSON.stringify({
        type: 'ice-candidate',
        candidate: event.candidate,
        viewerId: viewerId,
        target: 'viewer'
      }));
    }
  };
  
  // Handle ICE connection state changes
  peerConnection.oniceconnectionstatechange = () => {
    const state = peerConnection.iceConnectionState;
    console.log(`ICE connection state change: ${state}`);
    
    if (state === 'connected' || state === 'completed') {
      console.log(`Stable connection established with viewer: ${viewerId}`);
      // Connection is good
    } else if (state === 'disconnected') {
      console.log(`Connection to viewer ${viewerId} temporarily disconnected. Attempting to preserve connection...`);
      
      // Try to restart ICE after a short delay instead of immediately closing
      setTimeout(() => {
        if (peerConnections[viewerId] && 
            (peerConnections[viewerId].iceConnectionState === 'disconnected')) {
          console.log(`Attempting to reconnect to viewer: ${viewerId}`);
          // Try to restart ICE with a new offer that has iceRestart set to true
          try {
            peerConnections[viewerId].createOffer({ iceRestart: true })
              .then(offer => peerConnections[viewerId].setLocalDescription(offer))
              .then(() => {
                socket.send(JSON.stringify({
                  type: 'offer',
                  offer: peerConnections[viewerId].localDescription,
                  viewerId: viewerId
                }));
                console.log("ICE restart offer sent to viewer");
              })
              .catch(e => console.error('Failed to create reconnection offer:', e));
          } catch (e) {
            console.error('Failed to restart connection:', e);
          }
        }
      }, 2000);
    } else if (state === 'failed' || state === 'closed') {
      // Only remove viewer when connection has definitively failed or been closed
      if (activeViewers.has(viewerId)) {
        activeViewers.delete(viewerId);
        updateViewerCount();
        
        if (peerConnections[viewerId]) {
          peerConnections[viewerId].close();
          delete peerConnections[viewerId];
        }
      }
    }
  };
  
  // Create and send offer
  peerConnection.createOffer()
    .then(offer => {
      // Modify SDP to ensure high quality
      offer.sdp = modifySdpForHighQuality(offer.sdp);
      return peerConnection.setLocalDescription(offer);
    })
    .then(() => {
      socket.send(JSON.stringify({
        type: 'offer',
        offer: peerConnection.localDescription,
        viewerId: viewerId
      }));
    })
    .catch(error => {
      console.error(`Error creating offer:`, error);
    });
}

// Handle answer from viewer
function handleAnswer(answer, viewerId) {
  console.log(`Received answer from viewer: ${viewerId}`);
  
  const peerConnection = peerConnections[viewerId];
  if (peerConnection) {
    peerConnection.setRemoteDescription(new RTCSessionDescription(answer))
      .catch(error => {
        console.error(`Error setting remote description:`, error);
      });
  }
}

// Handle ICE candidate from remote peer
function handleRemoteICECandidate(candidate, viewerId) {
  console.log(`Received ICE candidate for viewer: ${viewerId}`);
  
  const peerConnection = peerConnections[viewerId];
  if (peerConnection) {
    peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
      .catch(error => {
        console.error(`Error adding ICE candidate:`, error);
      });
  }
}

// Copy viewer link to clipboard
function copyViewerLink() {
  // First, try to get the IP from the server if available
  fetch('/network-info')
    .then(response => response.json())
    .then(data => {
      // Use the network IP address provided by the server
      const protocol = window.location.protocol;
      const port = window.location.port ? `:${window.location.port}` : '';
      
      // Prioritize LAN, then WiFi
      const ip = data.lanIp || data.wifiIp || window.location.hostname;
      
      const viewerUrl = `${protocol}//${ip}${port}/viewer.html?id=${broadcasterId}`;
      
      navigator.clipboard.writeText(viewerUrl).then(() => {
        alert('Viewer link copied to clipboard');
      }).catch(err => {
        console.error('Could not copy text: ', err);
      });
    })
    .catch(error => {
      // Fallback to using the current host if network info API fails
      console.error('Error fetching network info:', error);
      
      const protocol = window.location.protocol;
      const host = window.location.host;
      const viewerUrl = `${protocol}//${host}/viewer.html?id=${broadcasterId}`;
      
      navigator.clipboard.writeText(viewerUrl).then(() => {
        alert('Viewer link copied to clipboard (using current address)');
      }).catch(err => {
        console.error('Could not copy text: ', err);
      });
    });
}

// Clean up all resources
function cleanup() {
  // Stop all tracks
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
  }
  
  // Close all peer connections
  Object.keys(peerConnections).forEach(viewerId => {
    if (peerConnections[viewerId]) {
      peerConnections[viewerId].close();
    }
  });
  
  // Close WebSocket
  if (socket) {
    socket.close();
  }
}

// Event listeners
if (startButton) {
  startButton.addEventListener('click', startStreaming);
}

if (stopButton) {
  stopButton.addEventListener('click', stopStreaming);
}

if (copyLinkButton) {
  copyLinkButton.addEventListener('click', copyViewerLink);
}

// Initialize on page load
window.addEventListener('load', initialize);

// Clean up on page unload
window.addEventListener('beforeunload', cleanup);