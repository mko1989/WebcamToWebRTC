// DOM Elements
const videoElement = document.getElementById('localVideo');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const statusElement = document.getElementById('status');
const broadcasterIdDisplay = document.getElementById('broadcasterIdDisplay'); // Updated ID
const viewerCountDisplay = document.getElementById('viewerCountDisplay'); // Updated ID
const cameraSelectElement = document.getElementById('cameraSelect');
const copyLinkButton = document.getElementById('copyLinkButton');
const enableAudioCheckbox = document.getElementById('enableAudio'); // Get audio checkbox
const bitrateInput = document.getElementById('bitrate'); // Get bitrate input
const bitrateValueSpan = document.getElementById('bitrateValue'); // Get bitrate display span


// Global variables
let socket;
let localStream;
let peerConnections = {}; // Maps viewerId -> RTCPeerConnection
let broadcasterId = 'default'; // Default or fetched from server/config
let isStreaming = false;
let activeViewers = new Set(); // Stores viewerIds
let config = {
  iceServers: [], // Will be populated from server
  iceCandidatePoolSize: 10
};
let targetBitrate = 10 * 1000000; // Default 10 Mbps in bits per second

// Fetch TURN configuration
async function getIceConfig() {
  try {
    const response = await fetch('/turn-config');
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    if (data.turnServer && data.turnServer.urls) {
        config.iceServers = [data.turnServer];
        console.log('Fetched TURN config:', config);
    } else {
        console.warn('Received invalid TURN config from server, using fallback.');
        useFallbackIceConfig();
    }
  } catch (error) {
    console.error('Error fetching TURN config:', error);
    useFallbackIceConfig();
  }
}

function useFallbackIceConfig() {
  // Basic STUN server (public)
  config.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  // Attempt to use local TURN server if fetch failed but server might be running
  try {
      config.iceServers.push({
        urls: `turn:${window.location.hostname}:3478`,
        username: 'webcamuser',
        credential: 'webcamsecret'
      });
      console.log('Using fallback ICE config (STUN + local TURN attempt)');
  } catch (e) {
      console.log('Using fallback ICE config (STUN only)');
  }
}

// Initialize WebSocket connection
async function initialize() {
  // First fetch the ICE servers configuration
  await getIceConfig();
  
  // Then initialize the WebSocket
  initWebSocket();
  
  // And list available cameras
  await listCameras(); // Ensure cameras are listed before potentially starting

  // Setup bitrate listener
  if (bitrateInput && bitrateValueSpan) {
      bitrateInput.addEventListener('input', () => {
        const mbps = parseInt(bitrateInput.value, 10);
        if (!isNaN(mbps) && mbps >= 1) {
          targetBitrate = mbps * 1000000; // Convert Mbps to bps
          bitrateValueSpan.textContent = `${mbps} Mbps`;
          console.log(`Target bitrate set to: ${targetBitrate} bps`);
          // Note: Applying this to existing connections requires renegotiation (advanced)
        }
      });
      // Initial display update
      bitrateValueSpan.textContent = `${bitrateInput.value} Mbps`;
  } else {
      console.error("Bitrate input elements not found!");
  }
}

function initWebSocket() {
  // Get WebSocket URL
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  
  console.log(`Connecting to WebSocket at ${wsUrl}`);
  updateStatus('Connecting to server');
  
  socket = new WebSocket(wsUrl);
  
  socket.onopen = () => {
    console.log('WebSocket connection established');
    updateStatus('Connected to server');
    // Register as broadcaster
    registerAsBroadcaster();
  };
  
  socket.onclose = (event) => {
    console.log(`WebSocket connection closed: ${event.code} ${event.reason}`);
    updateStatus('Disconnected from server');
    stopStreaming(); // Ensure cleanup if server disconnects
  };
  
  socket.onerror = (error) => {
    console.error('WebSocket error:', error);
    updateStatus('Connection error');
  };
  
  socket.onmessage = handleWebSocketMessage;
}

// Register as broadcaster with the server
function registerAsBroadcaster() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    console.log(`Registering broadcaster with ID: ${broadcasterId}`);
    socket.send(JSON.stringify({
      type: 'register-broadcaster',
      broadcasterId: broadcasterId
    }));
  } else {
    console.warn("WebSocket not open, cannot register broadcaster yet.");
  }
}

// Update status display
function updateStatus(status) {
  if (statusElement) {
    statusElement.textContent = `Status: ${status}`;
    
    // Convert status to a valid class name (remove spaces, use hyphens instead)
    const statusClass = status.toLowerCase().replace(/\s+/g, '-');
    
    // Remove previous status classes before adding the new one
    statusElement.className = 'status'; // Reset classes
    statusElement.classList.add(`status-${statusClass}`);
  }
  
  // Update button states
  if (startButton && stopButton && copyLinkButton) {
    startButton.disabled = isStreaming;
    stopButton.disabled = !isStreaming;
    copyLinkButton.disabled = !isStreaming;
  }

  // Update broadcaster ID display
  if (broadcasterIdDisplay) {
      broadcasterIdDisplay.textContent = broadcasterId;
  }
}

// Update viewer count display
function updateViewerCount() {
  if (viewerCountDisplay) {
    if (activeViewers.size > 0) {
      viewerCountDisplay.textContent = `Active viewers: ${activeViewers.size}`;
    } else {
      viewerCountDisplay.textContent = 'No active viewers';
    }
  }
}

// List available cameras
async function listCameras() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      console.warn("enumerateDevices() not supported.");
      return;
  }

  try {
    // Temporarily request access if needed to get labels
    let shouldRequestAccess = false;
    const initialDevices = await navigator.mediaDevices.enumerateDevices();
    if (initialDevices.some(d => d.kind === 'videoinput' && !d.label)) {
        shouldRequestAccess = true;
    }

    if (shouldRequestAccess) {
        console.log('Requesting temporary camera access to get labels');
        try {
            const tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            tempStream.getTracks().forEach(track => track.stop());
        } catch (permError) {
            console.warn("Could not get temporary camera access for labels:", permError);
        }
    }

    // Now list devices properly
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(device => device.kind === 'videoinput');
    
    // Clear existing options
    cameraSelectElement.innerHTML = '';
    
    if (videoDevices.length === 0) {
        cameraSelectElement.innerHTML = '<option value="">No cameras found</option>';
        return;
    }

    // Add option for each camera
    videoDevices.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.text = device.label || `Camera ${index + 1}`;
      cameraSelectElement.appendChild(option);
    });
    
  } catch (error) {
    console.error('Error listing cameras:', error);
    cameraSelectElement.innerHTML = '<option value="">Error listing cameras</option>';
  }
}

// Apply quality settings (bitrate, resolution preference)
async function applyQualitySettings(peerConnection) {
  const senders = peerConnection.getSenders();
  const videoSender = senders.find(s => s.track && s.track.kind === 'video');

  if (videoSender && videoSender.getParameters) {
    const parameters = videoSender.getParameters();
    
    if (!parameters.encodings || parameters.encodings.length === 0) {
      parameters.encodings = [{}]; // Ensure encodings array exists
    }
    
    // Set max bitrate based on user input (already in bps)
    parameters.encodings[0].maxBitrate = targetBitrate;
    
    // Encourage maintaining resolution over frame rate if bandwidth drops
    parameters.degradationPreference = 'maintain-resolution'; 
    
    // parameters.encodings[0].scaleResolutionDownBy = 1.0; // Explicitly prevent downscaling (optional)
    
    try {
      await videoSender.setParameters(parameters);
      console.log(`Video sender parameters updated for viewer ${getViewerIdForPC(peerConnection)}:`, parameters);
    } catch (error) {
      console.error(`Error setting video sender parameters for viewer ${getViewerIdForPC(peerConnection)}:`, error);
    }
  } else {
    console.log("Video sender or getParameters not available for quality settings.");
  }
}

// Helper to find viewer ID from PC object
function getViewerIdForPC(pc) {
    for (const [id, connection] of Object.entries(peerConnections)) {
        if (connection === pc) {
            return id;
        }
    }
    return 'unknown';
}


// Modify SDP for quality hints (optional, less reliable than setParameters)
function modifySdpForQualityHints(sdp) {
  const targetBitrateKbps = Math.round(targetBitrate / 1000); // Convert bps to kbps for SDP
  const minBitrateKbps = Math.round(targetBitrateKbps / 4); // Lower min
  const startBitrateKbps = Math.round(targetBitrateKbps / 2); // Lower start

  // Increase general bandwidth hint (less effective)
  sdp = sdp.replace(/b=AS:[0-9]+/g, `b=AS:${targetBitrateKbps}`);
  sdp = sdp.replace(/b=TIAS:[0-9]+/g, `b=TIAS:${targetBitrate * 1}`); // TIAS is in bps

  // Add codec-specific bitrate hints (x-google-* might not work everywhere)
  const lines = sdp.split('\r\n'); // Use standard CRLF line endings for SDP
  let fmtpLineAdded = {}; // Track which payload types we've added fmtp for

  for (let i = lines.length - 1; i >= 0; i--) { // Iterate backwards for safe splicing
      const rtpmapMatch = lines[i].match(/a=rtpmap:(\d+) (VP8|VP9|H264)/i);
      if (rtpmapMatch) {
          const payloadType = rtpmapMatch[1];
          if (!fmtpLineAdded[payloadType]) {
              // Remove existing bitrate hints for this payload type first
              for (let j = 0; j < lines.length; j++) {
                  if (lines[j].startsWith(`a=fmtp:${payloadType}`)) {
                      lines[j] = lines[j].replace(/;?x-google-(max|min|start)-bitrate=\d+/g, '');
                  }
              }

              // Construct new fmtp line or append to existing
              let foundFmtp = false;
              const bitrateFmtp = `x-google-max-bitrate=${targetBitrateKbps};x-google-min-bitrate=${minBitrateKbps};x-google-start-bitrate=${startBitrateKbps}`;
              for (let j = 0; j < lines.length; j++) {
                  if (lines[j].startsWith(`a=fmtp:${payloadType}`)) {
                      lines[j] += `;${bitrateFmtp}`;
                      foundFmtp = true;
                      break;
                  }
              }
              if (!foundFmtp) {
                  // Insert a new fmtp line after the rtpmap line
                  lines.splice(i + 1, 0, `a=fmtp:${payloadType} ${bitrateFmtp}`);
              }
              fmtpLineAdded[payloadType] = true;
          }
      }
  }
  sdp = lines.join('\r\n');
  // console.log("Modified SDP with bitrate hints (kbps):", targetBitrateKbps);
  // console.log("Modified SDP:\n", sdp); // Uncomment for debugging
  return sdp;
}


// Handle incoming WebSocket messages
function handleWebSocketMessage(event) {
  let data;
  try {
      data = JSON.parse(event.data);
  } catch (e) {
      console.error("Failed to parse WebSocket message:", event.data, e);
      return;
  }
  
  // console.log("Received WebSocket message:", data); // Debugging

  switch (data.type) {
    case 'broadcaster-registered':
      console.log(`Registered as broadcaster with ID: ${data.broadcasterId}`);
      broadcasterId = data.broadcasterId;
      updateStatus('Registered as broadcaster');
      break;
    
    case 'create-offer':
      if (isStreaming) {
        console.log(`Server requested offer for new viewer: ${data.viewerId}`);
        createPeerConnectionAndOffer(data.viewerId); // Create PC and then offer
        activeViewers.add(data.viewerId);
        updateViewerCount();
      } else {
        console.warn(`Received create-offer request for ${data.viewerId} but not streaming.`);
      }
      break;
    
    case 'answer':
      handleAnswer(data.answer, data.viewerId);
      break;
    
    case 'ice-candidate':
      handleRemoteICECandidate(data.candidate, data.viewerId);
      break;
    
    case 'viewer-disconnected': // Assume server sends this if it detects viewer gone
      console.log(`Server indicated viewer disconnected: ${data.viewerId}`);
      cleanupViewerConnection(data.viewerId);
      break;

    case 'error':
      console.error('Error from server:', data.message);
      alert(`Server Error: ${data.message}`);
      // Potentially stop streaming if the error is critical
      if (data.message.includes("Broadcaster ID already taken")) {
          stopStreaming();
      }
      break;
    
    default:
      console.log(`Unknown message type received: ${data.type}`);
  }
}

// Start streaming process
async function startStreaming() {
  if (isStreaming) {
      console.warn("Already streaming.");
      return;
  }
  console.log('Attempting to start streaming...');

  try {
    console.log('Requesting access to local camera and microphone');
    
    const enableAudio = enableAudioCheckbox?.checked ?? false; // Default to false if element missing
    const selectedCameraId = cameraSelectElement?.value;

    let videoConstraints = true; // Default to true (let browser choose)
    if (selectedCameraId) {
        videoConstraints = { deviceId: { exact: selectedCameraId } };
    }
    
    // Ideal resolution/framerate (browser will try its best)
    videoConstraints = typeof videoConstraints === 'object' ? videoConstraints : {};
    videoConstraints = { ...videoConstraints, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };

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
      await videoElement.play(); // Ensure video plays
    }
    
    isStreaming = true;
    updateStatus('broadcasting');
    console.log('Local stream acquired. Broadcasting is active.');

    // Re-register in case the socket reconnected while stopped
    // registerAsBroadcaster(); 

  } catch (error) {
    console.error('Error accessing media devices:', error.name, error.message);
    alert(`Could not access camera or microphone: ${error.name} - ${error.message}`);
    updateStatus('error');
    isStreaming = false; // Ensure state is reset
  }
}

// Stop streaming process
function stopStreaming() {
  if (!isStreaming && !localStream) {
      console.log("Not currently streaming.");
      return;
  }
  console.log("Stopping streaming...");

  // Close all peer connections first
  Object.keys(peerConnections).forEach(viewerId => {
      cleanupViewerConnection(viewerId); // Use helper
  });
  peerConnections = {}; // Clear the map
  activeViewers.clear();
  
  // Stop local media tracks
  if (localStream) {
    localStream.getTracks().forEach(track => {
        track.stop();
        console.log(`Stopped track: ${track.kind} (${track.label})`);
    });
    localStream = null;
  }
  
  // Update UI
  if (videoElement) {
    videoElement.srcObject = null;
    videoElement.pause();
  }

  isStreaming = false;
  updateStatus('Disconnected from server'); // Or just 'disconnected'
  updateViewerCount(); // Reset count display
  console.log("Streaming stopped and resources released.");
}

// Create PeerConnection and generate offer for a viewer
async function createPeerConnectionAndOffer(viewerId) {
  console.log(`Setting up PeerConnection for viewer: ${viewerId}`);
  if (peerConnections[viewerId]) {
      console.warn(`PeerConnection for viewer ${viewerId} already exists. Closing old one.`);
      cleanupViewerConnection(viewerId);
  }

  try {
      const peerConnection = new RTCPeerConnection(config);
      peerConnections[viewerId] = peerConnection;

      // --- Event Listeners for the Peer Connection ---
      peerConnection.onicecandidate = (event) => {
          if (event.candidate && socket && socket.readyState === WebSocket.OPEN) {
              // console.log(`Generated ICE candidate for ${viewerId}:`, event.candidate.candidate.substring(0, 30) + "...");
              socket.send(JSON.stringify({
                  type: 'ice-candidate',
                  candidate: event.candidate,
                  viewerId: viewerId,
                  target: 'viewer' // Tell server this is for the viewer
              }));
          }
      };

      peerConnection.oniceconnectionstatechange = () => {
          const state = peerConnection.iceConnectionState;
          console.log(`ICE connection state change for viewer ${viewerId}: ${state}`);
          if (state === 'failed' || state === 'disconnected' || state === 'closed') {
              console.warn(`Connection to viewer ${viewerId} failed or closed.`);
              cleanupViewerConnection(viewerId);
          } else if (state === 'connected') {
              console.log(`Successfully connected to viewer ${viewerId}.`);
          }
      };

      peerConnection.onconnectionstatechange = () => {
          const state = peerConnection.connectionState;
          console.log(`PeerConnection state change for viewer ${viewerId}: ${state}`);
           if (state === 'failed' || state === 'disconnected' || state === 'closed') {
              console.warn(`Connection to viewer ${viewerId} failed or closed (overall).`);
              cleanupViewerConnection(viewerId);
          }
      };
      
      peerConnection.onnegotiationneeded = async () => {
          console.log(`Negotiation needed for viewer ${viewerId}`);
          // This might be triggered if tracks are added/removed later.
          // We typically handle initial offer explicitly.
          // Avoid creating offer here if we are already in the process.
      };

      // Add local stream tracks
      if (localStream) {
          localStream.getTracks().forEach(track => {
              try {
                  peerConnection.addTrack(track, localStream);
                  console.log(`Added ${track.kind} track to PC for ${viewerId}`);
              } catch (e) {
                  console.error(`Error adding track for ${viewerId}:`, e);
              }
          });
      } else {
          console.error("Cannot create offer: localStream is not available.");
          cleanupViewerConnection(viewerId);
          return; // Stop if no stream
      }

      // Apply quality settings AFTER adding tracks
      await applyQualitySettings(peerConnection);

      // Create the offer
      console.log(`Creating SDP offer for viewer ${viewerId}`);
      const offer = await peerConnection.createOffer();
      
      // Modify SDP *before* setting local description (optional hints)
      let modifiedOfferSdp = modifySdpForQualityHints(offer.sdp);
      offer.sdp = modifiedOfferSdp;

      await peerConnection.setLocalDescription(offer);
      console.log(`Set local description for ${viewerId}`);

      // Send the offer to the server
      if (socket && socket.readyState === WebSocket.OPEN) {
          console.log(`Sending offer to server for viewer ${viewerId}`);
          socket.send(JSON.stringify({
              type: 'offer',
              offer: peerConnection.localDescription, // Send the full localDescription
              viewerId: viewerId
          }));
      } else {
          console.error("WebSocket not open. Cannot send offer.");
          cleanupViewerConnection(viewerId);
      }

  } catch (error) {
      console.error(`Error creating PeerConnection or offer for viewer ${viewerId}:`, error);
      cleanupViewerConnection(viewerId); // Clean up if setup fails
  }
}


// Handle received answer from a viewer
async function handleAnswer(answer, viewerId) {
  const peerConnection = peerConnections[viewerId];
  if (peerConnection) {
    console.log(`Received answer from viewer: ${viewerId}`);
    try {
      const remoteDesc = new RTCSessionDescription(answer);
      await peerConnection.setRemoteDescription(remoteDesc);
      console.log(`Set remote description for viewer: ${viewerId}`);
    } catch (error) {
      console.error(`Error setting remote description for viewer ${viewerId}:`, error);
      cleanupViewerConnection(viewerId);
    }
  } else {
    console.warn(`Received answer for unknown or closed viewer ID: ${viewerId}`);
  }
}

// Handle received ICE candidate from a viewer
async function handleRemoteICECandidate(candidate, viewerId) {
  const peerConnection = peerConnections[viewerId];
  if (peerConnection && candidate) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      // console.log(`Added remote ICE candidate for viewer ${viewerId}:`, candidate.candidate.substring(0, 30) + "...");
    } catch (error) {
      // Ignore benign errors like candidate already added or PC closed
      if (!error.message.includes("already been gathered") && !error.message.includes("invalid state")) {
         console.warn(`Error adding remote ICE candidate for ${viewerId}:`, error);
      }
    }
  } else {
      // console.warn(`Could not add ICE candidate for viewer ${viewerId}. PC exists: ${!!peerConnection}, Candidate exists: ${!!candidate}`);
  }
}

// Cleanup resources for a specific viewer
function cleanupViewerConnection(viewerId) {
    const peerConnection = peerConnections[viewerId];
    if (peerConnection) {
        console.log(`Cleaning up connection for viewer: ${viewerId}`);
        peerConnection.onicecandidate = null;
        peerConnection.oniceconnectionstatechange = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.onnegotiationneeded = null;
        
        // Stop senders associated with this PC
        peerConnection.getSenders().forEach(sender => {
            if (sender.track) {
                // Don't stop the original localStream tracks here,
                // just remove them from this specific PC
                 try { peerConnection.removeTrack(sender); } catch (e) {/* ignore */}
            }
        });

        peerConnection.close();
        delete peerConnections[viewerId];
    }
    if (activeViewers.has(viewerId)) {
        activeViewers.delete(viewerId);
        updateViewerCount(); // Update UI
    }
}

// --- Copy Link Functionality ---
async function copyViewerLink() {
    if (!broadcasterId) {
        alert("Broadcaster ID not set yet.");
        return;
    }

    let bestIp = window.location.hostname; // Default to current hostname

    try {
        const response = await fetch('/network-info');
        if (response.ok) {
            const data = await response.json();
            // Prioritize LAN IP, then WiFi IP, then fallback
            bestIp = data.lanIp || data.wifiIp || bestIp;
            console.log("Using network info for link:", data);
        } else {
            console.warn("Failed to fetch network info, using window.location.hostname");
        }
    } catch (error) {
        console.error("Error fetching network info, using window.location.hostname:", error);
    }

    const protocol = window.location.protocol;
    const port = window.location.port ? `:${window.location.port}` : '';
    // Ensure we use the potentially updated broadcasterId
    const viewerUrl = `${protocol}//${bestIp}${port}/viewer.html?id=${broadcasterId}`;

    try {
        await navigator.clipboard.writeText(viewerUrl);
        alert(`Viewer link copied to clipboard:\n${viewerUrl}`);
    } catch (err) {
        console.error('Could not copy text: ', err);
        alert(`Failed to copy link. Please copy manually:\n${viewerUrl}`);
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

// Add listener for camera selection changes
if (cameraSelectElement) {
    cameraSelectElement.addEventListener('change', () => {
        if (isStreaming) {
            // If streaming, stop and restart with the new camera
            console.log("Camera changed while streaming. Restarting stream...");
            stopStreaming();
            // Short delay to ensure resources are released before restarting
            setTimeout(startStreaming, 500);
        }
    });
}

// Initialize on page load
window.addEventListener('load', initialize);

// Clean up on page unload/close
window.addEventListener('beforeunload', () => {
    if (isStreaming) {
        stopStreaming(); // Gracefully stop streaming
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
        // Optionally notify the server we are leaving
        // socket.send(JSON.stringify({ type: 'broadcaster-leaving', broadcasterId }));
        socket.close();
    }
});