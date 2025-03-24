# Webcam to WebRTC Broadcaster
A lightweight, self-hosted solution for broadcasting your webcam over a local network using WebRTC technology.

## Features
- Simple Setup: Runs on any device with Node.js
- Local Network Broadcasting: Share your webcam with anyone on your local network
- High Quality Video: Configurable video quality up to 1080p
- Built-in TURN Server: No external STUN/TURN servers needed
- Low Latency: Near real-time video streaming
Camera Selection: Choose from available webcams
Audio Toggle: Enable/disable audio as needed
Self-contained Builds: Package as a standalone executable

## Requirements
Node.js 14+ and npm
Webcam and microphone
Web browser with WebRTC support (Chrome, Firefox, Edge, Safari)

## Installation
From Source
Clone the repository or download the source code

git clone https://github.com/mko1989/WebcamToWebRTC
cd WebcamToWebRTC

Install dependencies

npm install

Start the server

npm start

Open the broadcaster page in your browser

http://localhost:3000/broadcaster.html

## Using Standalone Executable
Download the appropriate executable for your platform from the releases page
Run the executable
Windows: Double-click the .exe file
macOS: Double-click the app file (you may need to right-click and select "Open" the first time)
Open your browser to http://localhost:3000/broadcaster.html

## Usage
### Broadcasting
Open http://localhost:3000/broadcaster.html on the device with the webcam
Select your preferred camera from the dropdown
Toggle audio on/off as needed
Click "Start Broadcasting"
Click "Copy Viewer Link" to get a link to share with viewers
Share the link with anyone on your local network

### Viewing
Open the viewer link provided by the broadcaster
The stream should start automatically

## Building Standalone Executables
To create a self-contained executable that includes all dependencies:

Install the pkg tool

npm install --save-dev pkg
Build for your target platform(s)


# Build for all platforms
npm run build

# Build for Windows only
npm run build-win

# Build for macOS only
npm run build-mac
Find your executables in the dist folder

## Technical Details
This application uses:

Express.js for the web server
WebRTC for peer-to-peer video streaming
WebSockets for signaling
node-turn for TURN server functionality
MediaStream API for webcam access
The system works by:

Establishing a WebSocket connection for signaling
Broadcasting device connects to the signaling server
Viewers connect to the same server and request the broadcast
WebRTC peer connections are established with the broadcaster
Video is streamed directly peer-to-peer when possible
The built-in TURN server relays traffic when direct connections fail
Performance Considerations
Video bitrate is capped at 10 Mbps to balance quality and network usage
Performance depends on your local network capabilities
Multiple viewers will increase CPU and network usage on the broadcasting device
Limitations
Designed for local network use (though could work over the internet with proper port forwarding)
No encryption or authentication built in
Performance may vary based on network conditions and device capabilities

## License
MIT
