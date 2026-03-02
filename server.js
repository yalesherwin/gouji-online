const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = new Map();

function code() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function buildDeck4() {
  const ranks = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
  const suits = ['♠','♥','♣','♦'];
  const d = [];
  for (let k = 0; k < 4; k++) {
    for (const s of suits) for (const r of ranks) d.push(r + s);
    d.push('SJ'); d.push('BJ');
  }
  return d;
}
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function count(hand, rank){return hand.filter(x => x.startsWith(rank)).length;}

function broadcastRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const seats = room.players.map((p, i) => ({ seat:i+1, id:p.id, name:p.name, ready:p.ready, cards:p.hand.length, qualified: p.qualified, isBot: !!p.isBot }));
  io.to(roomCode).emit('room:update', {
    roomCode,
    mode: room.mode,
    seats,
    started: room.started,
    ownerId: room.ownerId,
    logs: room.logs.slice(-20)
  });
}

io.on('connection', (socket) => {
  socket.on('room:create', ({ name, mode='不开点' }) => {
    let c = code();
    while (rooms.has(c)) c = code();
    const room = { roomCode:c, mode, players:[], started:false, logs:['房间创建成功'], tributeRule:true, ownerId: null };
    rooms.set(c, room);
    socket.emit('room:created', { roomCode:c });
  });

  socket.on('room:join', ({ roomCode, name }) => {
    const room = rooms.get(roomCode);
    if (!room) return socket.emit('err', '房间不存在');
    if (room.players.length >= 6) return socket.emit('err', '房间已满');
    if (room.started) return socket.emit('err', '游戏已开始');

    const player = { id: socket.id, name: name || `玩家${room.players.length+1}`, ready:false, hand:[], qualified:false, isBot:false };
    room.players.push(player);
    if (!room.ownerId) room.ownerId = socket.id;
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    room.logs.push(`${player.name} 加入房间`);
    broadcastRoom(roomCode);
  });

  socket.on('player:ready', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return;
    const p = room.players.find(x => x.id === socket.id);
    if (!p) return;
    p.ready = !p.ready;
    room.logs.push(`${p.name} ${p.ready ? '已准备' : '取消准备'}`);
    broadcastRoom(roomCode);
  });

  socket.on('room:addBots', ({ count = 1 } = {}) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return;
    if (room.ownerId !== socket.id) return socket.emit('err', '仅房主可添加机器人');
    if (room.started) return socket.emit('err', '游戏已开始，不能添加机器人');

    let canAdd = Math.min(Number(count) || 1, 6 - room.players.length);
    if (canAdd <= 0) return socket.emit('err', '房间已满，无法添加机器人');

    for (let i = 0; i < canAdd; i++) {
      const idx = room.players.filter(p => p.isBot).length + 1;
      room.players.push({
        id: `bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: `机器人${idx}`,
        ready: true,
        hand: [],
        qualified: false,
        isBot: true
      });
    }
    room.logs.push(`房主添加了 ${canAdd} 个机器人`);
    broadcastRoom(roomCode);
  });

  socket.on('game:start', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return;
    if (room.players.length !== 6) return socket.emit('err', '必须6人才能开始');
    if (!room.players.every(p => p.ready)) return socket.emit('err', '全员准备后才能开始');

    room.started = true;
    const deck = shuffle(buildDeck4());
    for (let i = 0; i < 216; i++) room.players[i % 6].hand.push(deck[i]);
    room.players.forEach(p => {
      p.qualified = count(p.hand, '3') >= 2 && count(p.hand, '4') >= 2;
      const msg = p.qualified ? `${p.name} 满足2张3+2张4` : `${p.name} 不满足，需买2`;
      room.logs.push(msg);
      if (!p.isBot) io.to(p.id).emit('player:hand', { hand: p.hand, qualified: p.qualified });
    });
    room.logs.push('发牌完成，进入进贡阶段（规则接口已启用）');
    broadcastRoom(roomCode);
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    room.logs.push('有玩家离线');
    if (room.players.length === 0) rooms.delete(roomCode);
    else broadcastRoom(roomCode);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`gouji online server: http://localhost:${PORT}`));
