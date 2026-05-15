const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = createServer(app);

// CORS configuration — tolerant of trailing slashes and missing env vars
const stripSlash = (s) => (typeof s === 'string' ? s.replace(/\/$/, '') : s);

const rawAllowed = process.env.NODE_ENV === 'production'
  ? [
      process.env.FRONTEND_URL,
      process.env.NETLIFY_URL,
      process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`,
    ]
  : ['http://localhost:3000'];

const allowedOrigins = rawAllowed.filter(Boolean).map(stripSlash);

const originCheck = (origin, cb) => {
  // Allow same-origin / server-side / curl (no Origin header)
  if (!origin) return cb(null, true);
  if (allowedOrigins.includes(stripSlash(origin))) return cb(null, true);
  console.warn(`CORS blocked origin: ${origin}. Allowed: ${allowedOrigins.join(', ')}`);
  return cb(new Error(`Origin ${origin} not allowed by CORS`));
};

console.log('Environment:', process.env.NODE_ENV);
console.log('Allowed origins:', allowedOrigins);

const io = new Server(server, {
  cors: {
    origin: originCheck,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Middleware
app.use(cors({
  origin: originCheck,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
app.use(express.json());

// Global error handler
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    rooms: Object.keys(rooms).length,
    uptime: process.uptime()
  });
});

/**
 * In-memory storage for rooms
 * Structure: {
 *   roomCode: {
 *     id: string,
 *     host: socketId,
 *     users: [{ id: socketId, username: string }],
 *     currentVideo: { videoId: string, title: string, position: number, isPlaying: boolean },
 *     messages: [{ id: string, username: string, message: string, timestamp: number }],
 *     createdAt: timestamp
 *   }
 * }
 */
const rooms = {};

/**
 * In-memory storage for online users
 * Structure: {
 *   userId: {
 *     socketId: string,
 *     userProfile: object,
 *     connectedAt: timestamp,
 *     lastSeen: timestamp
 *   }
 * }
 */
const onlineUsers = {};

/**
 * Generate a random 6-character room code
 */
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Extract YouTube video ID from URL
 */
function extractYouTubeVideoId(url) {
  if (!url) return null;

  // Handle youtu.be short links
  const shortLinkMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (shortLinkMatch) return shortLinkMatch[1];

  // Handle youtube.com URLs with various formats
  const longLinkMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (longLinkMatch) return longLinkMatch[1];

  // Handle embed URLs
  const embedMatch = url.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
  if (embedMatch) return embedMatch[1];

  // Handle youtube.com/watch URLs
  const watchMatch = url.match(/youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/);
  if (watchMatch) return watchMatch[1];

  return null;
}

/**
 * Clean up empty rooms
 */
function cleanupEmptyRooms() {
  Object.keys(rooms).forEach(roomCode => {
    if (rooms[roomCode].users.length === 0) {
      console.log(`Cleaning up empty room: ${roomCode}`);
      delete rooms[roomCode];
    }
  });
}

/**
 * Add user to online users
 */
function addOnlineUser(userId, socketId, userProfile) {
  if (userId) {
    onlineUsers[userId] = {
      socketId,
      userProfile,
      connectedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString()
    };
    
    // Broadcast online users update to all connected sockets
    io.emit('online-users-updated', getOnlineUsersList());
    console.log(`User ${userProfile?.username || userId} is now online`);
  }
}

/**
 * Remove user from online users
 */
function removeOnlineUser(userId) {
  if (userId && onlineUsers[userId]) {
    const user = onlineUsers[userId];
    delete onlineUsers[userId];
    
    // Broadcast online users update to all connected sockets
    io.emit('online-users-updated', getOnlineUsersList());
    console.log(`User ${user.userProfile?.username || userId} went offline`);
  }
}

/**
 * Get formatted online users list
 */
function getOnlineUsersList() {
  return Object.keys(onlineUsers).map(userId => ({
    id: userId,
    ...onlineUsers[userId].userProfile,
    lastSeen: onlineUsers[userId].lastSeen
  }));
}

/**
 * Update user's last seen timestamp
 */
function updateUserLastSeen(userId) {
  if (userId && onlineUsers[userId]) {
    onlineUsers[userId].lastSeen = new Date().toISOString();
  }
}

// API Routes
/**
 * Create a new room
 */
app.post('/api/create-room', (req, res) => {
  let roomCode;
  do {
    roomCode = generateRoomCode();
  } while (rooms[roomCode]);

  rooms[roomCode] = {
    id: roomCode,
    host: null,
    users: [],
    currentVideo: null,
    messages: [],
    canvasHistory: [],
    createdAt: Date.now()
  };

  console.log(`Room created: ${roomCode}`);
  res.json({ roomCode });
});

/**
 * Get room info
 */
app.get('/api/room/:code', (req, res) => {
  const { code } = req.params;
  const room = rooms[code.toUpperCase()];
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  res.json({
    roomCode: room.id,
    userCount: room.users.length,
    currentVideo: room.currentVideo,
    exists: true
  });
});

// Socket.IO Connection Handling
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  /**
   * User goes online
   */
  socket.on('user-online', ({ userId, userProfile }) => {
    console.log('User going online:', { userId, username: userProfile?.username });
    addOnlineUser(userId, socket.id, userProfile);
    
    // Send current online users list to the newly connected user
    socket.emit('online-users-updated', getOnlineUsersList());
  });

  /**
   * User sends heartbeat to stay online
   */
  socket.on('heartbeat', ({ userId }) => {
    updateUserLastSeen(userId);
  });

  /**
   * Get current online users
   */
  socket.on('get-online-users', () => {
    socket.emit('online-users-updated', getOnlineUsersList());
  });

  /**
   * Join a room
   */
  socket.on('join-room', ({ roomCode, username, avatar, isAuthenticated, userId, userProfile }) => {
    console.log('Join room request:', { 
      roomCode, 
      username, 
      avatar: avatar ? 'provided' : 'not provided',
      isAuthenticated: isAuthenticated || false,
      userId: userId || 'none'
    });
    
    const room = rooms[roomCode.toUpperCase()];
    
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    // Leave any previously joined rooms
    socket.rooms.forEach(roomName => {
      if (roomName !== socket.id) {
        socket.leave(roomName);
      }
    });

    // Join the new room
    socket.join(roomCode.toUpperCase());
    
    // Set host if room is empty
    if (room.users.length === 0) {
      room.host = socket.id;
    }

    // Add user to room with enhanced data
    const user = { 
      id: socket.id, 
      username: username || `User${Math.floor(Math.random() * 1000)}`,
      avatar: avatar || `${process.env.DICEBEAR_API_URL || 'https://api.dicebear.com/7.x/initials/svg'}?seed=${encodeURIComponent((username || 'Guest').charAt(0).toUpperCase())}&backgroundColor=7c3aed,a855f7,ec4899&textColor=ffffff`,
      isAuthenticated: isAuthenticated || false,
      userId: userId || null,
      userProfile: userProfile || null,
      joinedAt: new Date().toISOString()
    };
    room.users.push(user);
    
    console.log('User added to room:', { username: user.username, hasAvatar: !!user.avatar });
    
    socket.emit('joined-room', {
      roomCode: roomCode.toUpperCase(),
      isHost: room.host === socket.id,
      currentVideo: room.currentVideo,
      messages: room.messages,
      users: room.users,
      canvasHistory: room.canvasHistory
    });

    // Notify other users
    socket.to(roomCode.toUpperCase()).emit('user-joined', { user, userCount: room.users.length });
    
    console.log(`User ${username} joined room ${roomCode.toUpperCase()} with avatar`);
  });

  /**
   * Load a video (host only)
   */
  socket.on('load-video', ({ roomCode, videoUrl }) => {
    console.log(`Load video request: roomCode=${roomCode}, videoUrl=${videoUrl}`);

    const room = rooms[roomCode];
    if (!room) {
      console.log(`Room not found: ${roomCode}`);
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    if (room.host !== socket.id) {
      console.log(`User ${socket.id} is not host of room ${roomCode}`);
      socket.emit('error', { message: 'Only the host can load videos' });
      return;
    }

    const videoId = extractYouTubeVideoId(videoUrl);
    console.log(`Extracted video ID: ${videoId} from URL: ${videoUrl}`);

    if (!videoId) {
      console.log(`Invalid YouTube URL: ${videoUrl}`);
      socket.emit('error', { message: 'Invalid YouTube URL' });
      return;
    }

    // Update room video state
    room.currentVideo = {
      videoId,
      title: `Video ${videoId}`, // In production, fetch actual title from YouTube API
      position: 0,
      isPlaying: false
    };

    // Broadcast to all users in room
    io.to(roomCode).emit('video-loaded', {
      videoId,
      title: room.currentVideo.title
    });

    console.log(`Video loaded in room ${roomCode}: ${videoId}`);
  });

  /**
   * Video control events (host only)
   */
  socket.on('video-play', ({ roomCode, currentTime }) => {
    const room = rooms[roomCode];
    
    if (!room || room.host !== socket.id) return;

    room.currentVideo.isPlaying = true;
    room.currentVideo.position = currentTime || 0;

    socket.to(roomCode).emit('video-play', { time: currentTime });
  });

  socket.on('video-pause', ({ roomCode, currentTime }) => {
    const room = rooms[roomCode];
    
    if (!room || room.host !== socket.id) return;

    room.currentVideo.isPlaying = false;
    room.currentVideo.position = currentTime || 0;

    socket.to(roomCode).emit('video-pause', { time: currentTime });
  });

  socket.on('video-seek', ({ roomCode, seekTime }) => {
    const room = rooms[roomCode];
    
    if (!room || room.host !== socket.id) return;

    room.currentVideo.position = seekTime;

    socket.to(roomCode).emit('video-seek', { time: seekTime });
  });

  /**
   * Chat messages
   */
  socket.on('send-message', ({ roomCode, message }) => {
    const room = rooms[roomCode];
    
    if (!room) return;

    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;

    console.log('Sending message with user avatar:', { username: user.username, hasAvatar: !!user.avatar });

    const chatMessage = {
      id: Date.now().toString(),
      username: user.username,
      avatar: user.avatar,
      message: message.trim(),
      timestamp: Date.now()
    };

    room.messages.push(chatMessage);

    // Keep only last 50 messages to prevent memory bloat
    if (room.messages.length > 50) {
      room.messages = room.messages.slice(-50);
    }

    io.to(roomCode).emit('new-message', chatMessage);
  });

  /**
   * Voice Chat Events - WebRTC Signaling
   */
  
  // Join voice chat
  socket.on('join-voice-chat', ({ roomCode, username }) => {
    const room = rooms[roomCode];
    
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    // Initialize voice users array if it doesn't exist
    if (!room.voiceUsers) {
      room.voiceUsers = [];
    }

    // Add user to voice chat if not already in
    if (!room.voiceUsers.includes(socket.id)) {
      room.voiceUsers.push(socket.id);
      
      // Notify all users in the room about voice chat users update
      io.to(roomCode).emit('voice-chat-users', room.voiceUsers);
      
      // Notify other users that this user joined voice
      socket.to(roomCode).emit('user-joined-voice', { 
        callerID: socket.id, 
        username 
      });
      
      console.log(`User ${username} (${socket.id}) joined voice chat in room ${roomCode}`);
    }
  });

  // Leave voice chat
  socket.on('leave-voice-chat', ({ roomCode }) => {
    const room = rooms[roomCode];
    
    if (!room || !room.voiceUsers) return;

    // Remove user from voice chat
    const userIndex = room.voiceUsers.indexOf(socket.id);
    if (userIndex !== -1) {
      room.voiceUsers.splice(userIndex, 1);
      
      // Notify all users about voice chat users update
      io.to(roomCode).emit('voice-chat-users', room.voiceUsers);
      
      // Notify other users that this user left voice
      socket.to(roomCode).emit('user-left-voice', { 
        callerID: socket.id 
      });
      
      console.log(`User ${socket.id} left voice chat in room ${roomCode}`);
    }
  });

  // WebRTC signaling - sending signal to establish connection
  socket.on('sending-signal', ({ userToCall, callerID, signal }) => {
    io.to(userToCall).emit('receiving-signal', { 
      signal, 
      callerID 
    });
  });

  // WebRTC signaling - returning signal to complete connection
  socket.on('returning-signal', ({ signal, callerID }) => {
    io.to(callerID).emit('receiving-returned-signal', { 
      signal, 
      id: socket.id 
    });
  });

  /**
   * Mute Status Events
   */
  socket.on('user-muted', ({ roomCode }) => {
    console.log(`User ${socket.id} muted in room ${roomCode}`);
    socket.to(roomCode).emit('user-muted', { userId: socket.id });
  });

  socket.on('user-unmuted', ({ roomCode }) => {
    console.log(`User ${socket.id} unmuted in room ${roomCode}`);
    socket.to(roomCode).emit('user-unmuted', { userId: socket.id });
  });

  /**
   * Canvas drawing events
   */
  socket.on('canvas-draw', ({ roomCode, startX, startY, endX, endY, color, brushSize }) => {
    console.log(`Canvas draw in room ${roomCode} by ${socket.id}`);
    
    const room = rooms[roomCode];
    if (!room) return;
    
    // Store drawing in history
    const drawing = { startX, startY, endX, endY, color, brushSize, timestamp: Date.now() };
    room.canvasHistory.push(drawing);
    
    // Limit history to prevent memory issues (keep last 1000 drawings)
    if (room.canvasHistory.length > 1000) {
      room.canvasHistory = room.canvasHistory.slice(-1000);
    }
    
    // Broadcast to all other users in the room
    socket.to(roomCode).emit('canvas-draw', {
      startX, startY, endX, endY, color, brushSize
    });
  });

  socket.on('canvas-clear', ({ roomCode }) => {
    console.log(`Canvas cleared in room ${roomCode} by ${socket.id}`);
    
    const room = rooms[roomCode];
    if (!room) return;
    
    // Clear canvas history
    room.canvasHistory = [];
    
    // Broadcast to all other users in the room
    socket.to(roomCode).emit('canvas-clear');
  });

  /**
   * Handle disconnection
   */
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    
    // Find and remove user from online users
    const userId = Object.keys(onlineUsers).find(id => onlineUsers[id].socketId === socket.id);
    if (userId) {
      removeOnlineUser(userId);
    }
    
    // Remove user from all rooms and cleanup
    Object.keys(rooms).forEach(roomCode => {
      const room = rooms[roomCode];
      const userIndex = room.users.findIndex(u => u.id === socket.id);
      
      if (userIndex !== -1) {
        const user = room.users[userIndex];
        room.users.splice(userIndex, 1);
        
        // Remove from voice chat if they were in it
        if (room.voiceUsers) {
          const voiceUserIndex = room.voiceUsers.indexOf(socket.id);
          if (voiceUserIndex !== -1) {
            room.voiceUsers.splice(voiceUserIndex, 1);
            // Notify other users that this user left voice
            socket.to(roomCode).emit('user-left-voice', { 
              callerID: socket.id 
            });
            // Update voice chat users list
            io.to(roomCode).emit('voice-chat-users', room.voiceUsers);
          }
        }
        
        // If host disconnected, assign new host
        if (room.host === socket.id && room.users.length > 0) {
          room.host = room.users[0].id;
          io.to(roomCode).emit('new-host', { newHost: room.users[0] });
        }
        
        // Notify remaining users
        socket.to(roomCode).emit('user-left', { 
          user, 
          userCount: room.users.length,
          newHost: room.host === room.users[0]?.id ? room.users[0] : null
        });
        
        console.log(`User ${user.username} left room ${roomCode}`);
      }
    });
    
    // Cleanup empty rooms
    cleanupEmptyRooms();
  });
});

// Periodic cleanup of old empty rooms
setInterval(() => {
  const now = Date.now();
  Object.keys(rooms).forEach(roomCode => {
    const room = rooms[roomCode];
    // Clean up rooms older than 24 hours with no users
    if (room.users.length === 0 && (now - room.createdAt) > 24 * 60 * 60 * 1000) {
      delete rooms[roomCode];
      console.log(`Cleaned up old empty room: ${roomCode}`);
    }
  });
}, 60 * 60 * 1000); // Run every hour

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`🚀 Watch Party Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});