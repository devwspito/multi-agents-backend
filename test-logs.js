/**
 * Test script to verify WebSocket log emission
 */

const io = require('socket.io-client');

// Create a fake task ID (24 hex chars)
const testTaskId = '507f1f77bcf86cd799439011';

// Connect to WebSocket
const socket = io('http://localhost:3001', {
  path: '/ws/notifications',
  transports: ['websocket', 'polling'],
});

socket.on('connect', () => {
  console.log('✅ Connected to WebSocket');
  console.log(`📌 Socket ${socket.id} joining task room: ${testTaskId}`);

  // Join the task room
  socket.emit('join-task', testTaskId);
});

socket.on('task-joined', (data) => {
  console.log('✅ Joined task room:', data);

  // Now emit some test logs
  setTimeout(() => {
    console.log(`[TEST] Task ${testTaskId}: Starting orchestration...`);
  }, 1000);

  setTimeout(() => {
    console.log(`[TEST] Task ${testTaskId}: Product Manager analyzing requirements`);
  }, 2000);

  setTimeout(() => {
    console.log(`[TEST] Task ${testTaskId}: Tech Lead designing architecture`);
  }, 3000);

  setTimeout(() => {
    console.log(`[TEST] Task ${testTaskId}: Developers implementing code`);
  }, 4000);

  setTimeout(() => {
    console.log(`[TEST] Task ${testTaskId}: QA testing implementation`);
  }, 5000);

  setTimeout(() => {
    console.log(`✅ Task ${testTaskId}: Orchestration completed successfully!`);
    process.exit(0);
  }, 6000);
});

socket.on('console:log', (data) => {
  console.log('📨 Received log via WebSocket:', data);
});

socket.on('error', (error) => {
  console.error('❌ WebSocket error:', error);
});

socket.on('disconnect', () => {
  console.log('❌ Disconnected from WebSocket');
});