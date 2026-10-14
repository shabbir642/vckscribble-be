#!/usr/bin/env node
/**
 * Kicking: the host removes a player outright; everyone else votes, and a
 * majority of the players present removes them. A kicked browser stays out.
 */
import { io } from 'socket.io-client';

const URL = process.argv[2] ?? 'http://localhost:3001';
let pass = 0;
const failures = [];
const check = (l, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${l}`); }
  else { failures.push(l); console.log(`  ✗ ${l} ${d}`); }
};
const connect = () => new Promise((res, rej) => {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  s.once('connect', () => res(s));
  s.once('connect_error', rej);
});
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const next = (s, ev, ms = 8000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout: ${ev}`)), ms);
  s.once(ev, (p) => { clearTimeout(t); res(p); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dev = (n) => `kick-device-${n}-${Date.now().toString(36)}`;

/** A room with one seat per name; each seat remembers its socket, id, device. */
async function room(names) {
  const seats = [];
  for (const [i, name] of names.entries()) {
    const sock = await connect();
    const deviceId = dev(i);
    const st = next(sock, 'room:state');
    const r = i === 0
      ? await emit(sock, 'room:create', { name, avatar: 0, deviceId })
      : await emit(sock, 'room:join', { roomCode: seats[0].code, name, avatar: i, deviceId });
    const state = await st;
    seats.push({ sock, name, deviceId, id: state.you.playerId, code: r.roomCode ?? seats[0].code, last: state });
    sock.on('room:players', (p) => { sock.players = p.players; });
    sock.on('room:state', (p) => { sock.players = p.players; sock.state = p; });
  }
  return seats;
}
const closeAll = (seats) => seats.forEach((s) => s.sock.close());

console.log('host kick');
{
  const [host, bob, cat] = await room(['Hana', 'Bob', 'Cat']);
  const kicked = next(bob.sock, 'room:kicked');
  const r = await emit(host.sock, 'player:kick', { playerId: bob.id });
  check('host kick acks kicked', r.ok && r.kicked, JSON.stringify(r));
  const k = await kicked;
  check('kicked player is told, by host', k.by === 'host' && k.roomCode === host.code, JSON.stringify(k));
  await sleep(200);
  check('seat is gone from the roster', !cat.sock.players.some((p) => p.id === bob.id));
  const again = await emit(bob.sock, 'room:join', { roomCode: host.code, name: 'Bob', avatar: 1, deviceId: bob.deviceId });
  check('same browser cannot rejoin', !again.ok && again.code === 'KICKED', JSON.stringify(again));
  const chat = await emit(bob.sock, 'player:update', { name: 'Bobby' });
  check('kicked socket holds no seat', !chat.ok && chat.code === 'ROOM_NOT_FOUND', JSON.stringify(chat));
  const self = await emit(host.sock, 'player:kick', { playerId: host.id });
  check('cannot kick yourself', !self.ok, JSON.stringify(self));
  closeAll([host, bob, cat]);
}

console.log('vote kick needs 3 players');
{
  const [host, bob] = await room(['Hana', 'Bob']);
  const r = await emit(bob.sock, 'player:kick', { playerId: host.id });
  check('two-player room refuses a vote', !r.ok && r.code === 'INVALID', JSON.stringify(r));
  closeAll([host, bob]);
}

console.log('vote kick by majority');
{
  const seats = await room(['Hana', 'Ann', 'Ben', 'Cy', 'Dee']);
  const [host, ann, ben, cy, dee] = seats;
  // 5 present: 4 others, majority 3.
  let r = await emit(ann.sock, 'player:kick', { playerId: dee.id });
  check('first vote counts 1 of 3', r.ok && !r.kicked && r.votes === 1 && r.needed === 3, JSON.stringify(r));
  await sleep(150);
  const row = host.sock.players.find((p) => p.id === dee.id);
  check('roster shows who voted', row.kickVotes.length === 1 && row.kickVotes[0] === ann.id, JSON.stringify(row));
  r = await emit(ann.sock, 'player:kick', { playerId: dee.id });
  check('voting again withdraws', r.ok && r.votes === 0, JSON.stringify(r));
  await emit(ann.sock, 'player:kick', { playerId: dee.id });
  r = await emit(ben.sock, 'player:kick', { playerId: dee.id });
  check('second vote 2 of 3, still in', r.ok && !r.kicked && r.votes === 2, JSON.stringify(r));
  const kicked = next(dee.sock, 'room:kicked');
  r = await emit(cy.sock, 'player:kick', { playerId: dee.id });
  check('third vote kicks', r.ok && r.kicked, JSON.stringify(r));
  const k = await kicked;
  check('kicked player is told, by vote', k.by === 'vote', JSON.stringify(k));
  closeAll(seats);
}

console.log('a departure can decide a vote');
{
  const seats = await room(['Hana', 'Ann', 'Ben', 'Cy']);
  const [host, ann, ben, cy] = seats;
  // 4 present: 3 others, majority 2.
  await emit(ann.sock, 'player:kick', { playerId: cy.id });
  const r = await emit(ben.sock, 'player:kick', { playerId: cy.id });
  check('2 of 2 kicks in a room of 4', r.ok && r.kicked, JSON.stringify(r));
  closeAll(seats);
}
{
  const seats = await room(['Hana', 'Ann', 'Ben', 'Cy', 'Dee']);
  const [host, ann, ben, cy, dee] = seats;
  // 5 present, majority 3. Two votes against Dee, then Cy leaves for good:
  // 4 present, 3 others, majority 2 — the two votes now carry it.
  await emit(ann.sock, 'player:kick', { playerId: dee.id });
  await emit(ben.sock, 'player:kick', { playerId: dee.id });
  const kicked = next(dee.sock, 'room:kicked');
  cy.sock.disconnect();
  const k = await kicked.catch(() => null);
  check('votes carry once a departure lowers the bar', k?.by === 'vote');
  closeAll(seats);
}

console.log('kicking the host or the drawer');
{
  const seats = await room(['Hana', 'Ann', 'Ben']);
  const [host, ann, ben] = seats;
  await emit(ann.sock, 'player:kick', { playerId: host.id });
  const kicked = next(host.sock, 'room:kicked');
  await emit(ben.sock, 'player:kick', { playerId: host.id });
  await kicked;
  await sleep(200);
  const hostNow = ann.sock.players.find((p) => p.isHost);
  check('host voted out hands the role on', hostNow && hostNow.id !== host.id, JSON.stringify(ann.sock.players));
  closeAll(seats);
}
{
  const seats = await room(['Hana', 'Ann', 'Ben']);
  const [host] = seats;
  await emit(host.sock, 'room:settings', { drawSeconds: 60, selectSeconds: 10 });
  const offers = seats.map((s) => next(s.sock, 'word:options').then((o) => ({ s, o })));
  await emit(host.sock, 'room:start', {});
  const { s: drawer, o } = await Promise.race(offers);
  await emit(drawer.sock, 'word:choose', { wordId: o.choices[0].id });
  await sleep(200);
  const others = seats.filter((s) => s !== drawer);
  const kicker = others.find((s) => s === host) ?? null;
  const watcher = others.find((s) => s !== host) ?? others[0];
  const reveal = new Promise((res) => watcher.sock.on('round:state', (p) => { if (p.phase === 'reveal') res(p); }));
  if (kicker) {
    await emit(host.sock, 'player:kick', { playerId: drawer.id });
  } else {
    // The host is drawing: the other two vote them out.
    for (const s of others) await emit(s.sock, 'player:kick', { playerId: drawer.id });
  }
  const st = await Promise.race([reveal, sleep(3000).then(() => null)]);
  check('kicking the drawer ends the turn at once', st?.phase === 'reveal', JSON.stringify(st));
  closeAll(seats);
}

console.log(failures.length ? `\n${failures.length} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(failures.length ? 1 : 0);
