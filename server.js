const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

const rooms = new Map();
const RANK_ORDER = ['3','4','5','6','7','8','9','10','J','Q','K','A','2','SJ','BJ'];

function rankOf(card){
  if (card === 'SJ' || card === 'BJ') return card;
  return card.slice(0, -1);
}
function rankValue(card){ return RANK_ORDER.indexOf(rankOf(card)); }
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

function nextIndex(room, idx){ return (idx + 1) % room.players.length; }

function summarySeats(room){
  return room.players.map((p, i) => ({
    seat:i+1, id:p.id, name:p.name, ready:p.ready, cards:p.hand.length,
    qualified:p.qualified, isBot:!!p.isBot
  }));
}

function emitGameState(roomCode){
  const room = rooms.get(roomCode); if(!room) return;
  io.to(roomCode).emit('game:state', {
    started: room.started,
    turnSeat: room.turnIndex != null ? room.turnIndex + 1 : null,
    turnPlayerId: room.turnIndex != null ? room.players[room.turnIndex]?.id : null,
    lastPlay: room.lastPlay,
    passCount: room.passCount || 0,
  });
}

function broadcastRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  io.to(roomCode).emit('room:update', {
    roomCode,
    mode: room.mode,
    seats: summarySeats(room),
    started: room.started,
    ownerId: room.ownerId,
    logs: room.logs.slice(-30)
  });
  emitGameState(roomCode);
}

function removeCards(hand, cards){
  cards.forEach(c => {
    const idx = hand.indexOf(c);
    if (idx >= 0) hand.splice(idx,1);
  });
}

function validSet(cards){
  if (!cards || cards.length === 0) return false;
  const r = rankOf(cards[0]);
  return cards.every(c => rankOf(c) === r);
}

function canBeat(play, last){
  if (!last || !last.cards || last.cards.length === 0) return true;
  if (play.cards.length !== last.cards.length) return false;
  const pv = rankValue(play.cards[0]);
  const lv = rankValue(last.cards[0]);
  return pv > lv;
}

function maybeBotAct(roomCode){
  const room = rooms.get(roomCode); if(!room || !room.started) return;
  const p = room.players[room.turnIndex];
  if (!p || !p.isBot) return;

  setTimeout(() => {
    const fresh = rooms.get(roomCode); if(!fresh || !fresh.started) return;
    const bot = fresh.players[fresh.turnIndex];
    if (!bot || !bot.isBot) return;

    // 简化BOT：有上家牌就过；没上家牌就出最小单张
    if (fresh.lastPlay && fresh.lastPlay.playerId !== bot.id) {
      fresh.passCount = (fresh.passCount || 0) + 1;
      fresh.logs.push(`${bot.name} 过牌`);
      if (fresh.passCount >= fresh.players.length - 1) {
        fresh.lastPlay = null;
        fresh.passCount = 0;
        fresh.logs.push('新一轮开始（清台）');
      }
      fresh.turnIndex = nextIndex(fresh, fresh.turnIndex);
      broadcastRoom(roomCode);
      return maybeBotAct(roomCode);
    }

    if (bot.hand.length === 0) {
      fresh.turnIndex = nextIndex(fresh, fresh.turnIndex);
      broadcastRoom(roomCode);
      return maybeBotAct(roomCode);
    }

    bot.hand.sort((a,b)=>rankValue(a)-rankValue(b));
    const card = bot.hand.shift();
    fresh.lastPlay = { playerId: bot.id, playerName: bot.name, cards:[card], kind:'single' };
    fresh.passCount = 0;
    fresh.logs.push(`${bot.name} 出牌: ${card}`);
    if (bot.hand.length === 0) {
      fresh.logs.push(`🏆 ${bot.name} 出完牌！`);
      fresh.started = false;
      broadcastRoom(roomCode);
      return;
    }
    fresh.turnIndex = nextIndex(fresh, fresh.turnIndex);
    broadcastRoom(roomCode);
    maybeBotAct(roomCode);
  }, 700);
}

io.on('connection', (socket) => {
  socket.on('room:create', ({ mode='不开点' }) => {
    let c = code(); while (rooms.has(c)) c = code();
    const room = {
      roomCode:c, mode, players:[], started:false, logs:['房间创建成功'],
      tributeRule:true, ownerId:null, turnIndex:null, lastPlay:null, passCount:0
    };
    rooms.set(c, room);
    socket.emit('room:created', { roomCode:c });
  });

  socket.on('room:join', ({ roomCode, name }) => {
    const room = rooms.get(roomCode);
    if (!room) return socket.emit('err', '房间不存在');
    if (room.started) return socket.emit('err', '游戏已开始');

    const exists = room.players.find(p => p.id === socket.id);
    if (!exists) {
      if (room.players.length >= 6) return socket.emit('err', '房间已满');
      const player = { id: socket.id, name: name || `玩家${room.players.length+1}`, ready:false, hand:[], qualified:false, isBot:false };
      room.players.push(player);
      if (!room.ownerId) room.ownerId = socket.id;
      room.logs.push(`${player.name} 加入房间`);
    }

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    broadcastRoom(roomCode);
  });

  socket.on('player:ready', () => {
    const room = rooms.get(socket.data.roomCode); if(!room) return;
    const p = room.players.find(x => x.id === socket.id); if(!p) return;
    p.ready = !p.ready;
    room.logs.push(`${p.name} ${p.ready?'已准备':'取消准备'}`);
    broadcastRoom(room.roomCode);
  });

  socket.on('room:addBots', ({ count = 1 } = {}) => {
    const room = rooms.get(socket.data.roomCode); if(!room) return;
    if (room.ownerId !== socket.id) return socket.emit('err', '仅房主可添加机器人');
    if (room.started) return socket.emit('err', '游戏已开始，不能添加机器人');
    const canAdd = Math.min(Number(count)||1, 6-room.players.length);
    if (canAdd <= 0) return socket.emit('err', '房间已满');
    for (let i=0;i<canAdd;i++) {
      const idx = room.players.filter(p=>p.isBot).length + 1;
      room.players.push({
        id:`bot_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
        name:`机器人${idx}`, ready:true, hand:[], qualified:false, isBot:true
      });
    }
    room.logs.push(`房主添加了 ${canAdd} 个机器人`);
    broadcastRoom(room.roomCode);
  });

  socket.on('game:start', () => {
    const room = rooms.get(socket.data.roomCode); if(!room) return;

    if (room.players.length < 6) {
      const need = 6 - room.players.length;
      for (let i=0;i<need;i++) {
        const idx = room.players.filter(p=>p.isBot).length + 1;
        room.players.push({ id:`bot_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, name:`机器人${idx}`, ready:true, hand:[], qualified:false, isBot:true });
      }
      room.logs.push(`开局自动补齐 ${need} 个机器人`);
    }

    if (!room.players.every(p => p.ready)) return socket.emit('err', '全员准备后才能开始');
    room.started = true;
    room.lastPlay = null;
    room.passCount = 0;

    const deck = shuffle(buildDeck4());
    room.players.forEach(p => { p.hand = []; });
    for (let i=0;i<216;i++) room.players[i%6].hand.push(deck[i]);

    room.players.forEach(p => {
      p.qualified = count(p.hand,'3') >= 2 && count(p.hand,'4') >= 2;
      room.logs.push(p.qualified ? `${p.name} 满足2张3+2张4` : `${p.name} 不满足，需买2`);
      if (!p.isBot) io.to(p.id).emit('player:hand', { hand:p.hand, qualified:p.qualified });
    });

    room.turnIndex = 0;
    room.logs.push('发牌完成，进入出牌阶段');
    broadcastRoom(room.roomCode);
    maybeBotAct(room.roomCode);
  });

  socket.on('play:cards', ({ cards }) => {
    const room = rooms.get(socket.data.roomCode); if(!room || !room.started) return;
    const p = room.players[room.turnIndex];
    if (!p || p.id !== socket.id) return socket.emit('err','还没轮到你');
    if (!Array.isArray(cards) || cards.length===0) return socket.emit('err','请选择要出的牌');
    if (!cards.every(c => p.hand.includes(c))) return socket.emit('err','选择的牌不在手牌中');
    if (!validSet(cards)) return socket.emit('err','当前版本仅支持同点数出牌（单/对/三/四）');

    const play = { playerId:p.id, playerName:p.name, cards:[...cards], kind:'set' };
    if (!canBeat(play, room.lastPlay)) return socket.emit('err','压不过上家牌');

    removeCards(p.hand, cards);
    room.lastPlay = play;
    room.passCount = 0;
    room.logs.push(`${p.name} 出牌: ${cards.join(' ')}`);

    io.to(p.id).emit('player:hand', { hand:p.hand, qualified:p.qualified });

    if (p.hand.length === 0) {
      room.logs.push(`🏆 ${p.name} 出完牌！`);
      room.started = false;
      broadcastRoom(room.roomCode);
      return;
    }

    room.turnIndex = nextIndex(room, room.turnIndex);
    broadcastRoom(room.roomCode);
    maybeBotAct(room.roomCode);
  });

  socket.on('play:pass', () => {
    const room = rooms.get(socket.data.roomCode); if(!room || !room.started) return;
    const p = room.players[room.turnIndex];
    if (!p || p.id !== socket.id) return socket.emit('err','还没轮到你');
    if (!room.lastPlay) return socket.emit('err','新一轮不能过牌，请先出牌');

    room.passCount = (room.passCount || 0) + 1;
    room.logs.push(`${p.name} 过牌`);

    if (room.passCount >= room.players.length - 1) {
      room.lastPlay = null;
      room.passCount = 0;
      room.logs.push('新一轮开始（清台）');
    }

    room.turnIndex = nextIndex(room, room.turnIndex);
    broadcastRoom(room.roomCode);
    maybeBotAct(room.roomCode);
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode; if(!roomCode) return;
    const room = rooms.get(roomCode); if(!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.ownerId === socket.id) {
      const nextOwner = room.players.find(p=>!p.isBot);
      room.ownerId = nextOwner ? nextOwner.id : null;
    }
    room.logs.push('有玩家离线');
    if (room.players.length === 0) rooms.delete(roomCode);
    else broadcastRoom(roomCode);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`gouji online server: http://localhost:${PORT}`));
