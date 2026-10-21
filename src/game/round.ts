import type { Server } from 'socket.io';
import {
  type ChatMessage,
  type ChatTone,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type WordChoice,
  guessKey,
  isCloseGuess,
  isHintable,
  maskWord,
  normalizeWord,
} from '../contract/index.js';
import { clearStrokes } from './drawing.js';
import { StoreError, store } from './store.js';
import { buildSummary, recordGuess, recordTurn, resetSummary, tallyOf } from './summary.js';
import type { PlayerRecord, Room } from './types.js';
import {
  acceptCustomWord,
  customIndex,
  markDrawn,
  markGuessed,
  markSuggestionGuessed,
  pickChoices,
  wordById,
} from './words.js';

type IO = Server<ClientToServerEvents, ServerToClientEvents>;

/** How long the solution stays on screen before the next turn. */
const REVEAL_MS = 4000;
const SCOREBOARD_MS = 5000;
/** A drawer may invent at most this many words per game. */
const MAX_CUSTOM_PER_GAME = 3;

/**
 * Scoring. A guess is worth GUESS_BASE at the buzzer, rising to
 * GUESS_BASE + GUESS_SPEED for an instant answer, plus a bonus for being
 * among the first to get it — so racing matters, not just the clock.
 */
const GUESS_BASE = 50;
const GUESS_SPEED = 250;
const ORDER_BONUS = [50, 30, 15];
/**
 * The drawer earns a share of DRAWER_TURN_POINTS for each player who gets it:
 * everyone guessing pays the full amount whether the room has 2 guessers or
 * 12. A flat amount per guess (as before) made a drawer in a big room worth
 * five times one in a small room, so turn order decided games.
 */
const DRAWER_TURN_POINTS = 250;
/** Hints appear between these fractions of the drawing time. */
const HINTS_FROM = 0.35;
const HINTS_UNTIL = 0.85;
/** How long a departed player has to come back before the room acts on it. */
const DEPARTURE_GRACE_MS = 10_000;

/**
 * Owns phase transitions and every timer. All timing is server-side: clients
 * render `endsAt` and are told what to show, so a slow or hostile client cannot
 * extend its own turn.
 */
export class RoundEngine {
  private timers = new Map<string, NodeJS.Timeout[]>();
  /**
   * Roster checks are held apart from the phase timers deliberately. `advance`
   * clears those on every transition and `later` ties them to a `seq` snapshot,
   * which is right for "finish this turn in 30s" and wrong for "did the room
   * empty out?" — that question outlives whatever the round does next. One
   * pending check per room is enough, since it re-reads live state when it
   * fires.
   */
  private rosterChecks = new Map<string, NodeJS.Timeout>();

  constructor(private io: IO) {}

  /* ------------------------------------------------------------ timers */

  private clear(room: Room): void {
    for (const t of this.timers.get(room.code) ?? []) clearTimeout(t);
    this.timers.delete(room.code);
  }

  /**
   * Schedules work against a phase snapshot. If anything advances the room in
   * the meantime — an early finish, a drawer leaving — `seq` moves and the
   * stale callback silently does nothing. Without this, a cancelled round's
   * timer would fire into the next one.
   */
  private later(room: Room, ms: number, fn: () => void): void {
    const seq = room.seq;
    const t = setTimeout(() => {
      if (room.seq !== seq) return;
      try {
        fn();
      } catch (e) {
        console.error('[round] timer failed', e);
      }
    }, ms);
    const list = this.timers.get(room.code) ?? [];
    list.push(t);
    this.timers.set(room.code, list);
  }

  private advance(room: Room): void {
    room.seq++;
    this.clear(room);
  }

  /* ------------------------------------------------------- broadcasting */

  /** Public round state: never carries the solution while it is still in play. */
  private publish(room: Room): void {
    this.io.to(room.code).emit('round:state', room.round);
  }

  private sendPlayers(room: Room): void {
    this.io.to(room.code).emit('room:players', { players: store.publicPlayers(room) });
  }

  private system(room: Room, text: string, tone: ChatTone = 'neutral'): void {
    this.io.to(room.code).emit('chat:message', {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channel: 'system',
      tone,
      playerId: null,
      playerName: null,
      text,
      at: Date.now(),
    });
  }

  private socketOf(player: PlayerRecord) {
    return player.socketId ? this.io.sockets.sockets.get(player.socketId) : undefined;
  }

  /* ------------------------------------------------------------- flow */

  startGame(room: Room): void {
    this.advance(room);
    // Shuffled: join order meant the host always drew first, every game.
    room.drawOrder = shuffle(room.order.filter((id) => room.players.get(id)?.connected));
    room.turnIndex = 0;
    room.usedWordIds = [];
    room.usedCustom = new Set();
    room.customOffered = new Map();
    room.turnNo = 0;
    room.drawn = new Set();
    room.customCounts = {};
    room.finalScoreboard = false;
    // Here as well as in reset: play again comes straight from the podium.
    resetSummary(room);
    room.round = {
      ...room.round,
      phase: 'selecting',
      round: 1,
      totalRounds: room.settings.rounds,
      guessedPlayerIds: [],
      likes: 0,
      dislikes: 0,
    };
    for (const p of room.players.values()) p.score = 0;
    this.sendPlayers(room);
    this.beginSelection(room);
  }

  private currentDrawer(room: Room): PlayerRecord | null {
    const id = room.drawOrder[room.turnIndex];
    return id ? (room.players.get(id) ?? null) : null;
  }

  private beginSelection(room: Room): void {
    this.advance(room);
    clearStrokes(room);
    room.revealed = [];
    room.hintPlan = [];
    room.active = null;
    room.reportedBy.clear();
    room.reactions.clear();
    this.io.to(room.code).emit('draw:clear', {});

    const drawer = this.currentDrawer(room);
    if (!drawer || !drawer.connected) {
      // Nobody home for this slot — skip rather than stall the room.
      this.nextTurn(room);
      return;
    }

    room.turnNo++;
    const choices = pickChoices({
      packs: room.settings.wordPacks,
      difficulty: room.settings.difficulty,
      count: room.settings.wordChoices,
      usedIds: room.usedWordIds,
      custom: room.customWords,
      usedCustom: room.usedCustom,
      drawn: room.drawn,
      customOffered: room.customOffered,
      turn: room.turnNo,
      turnsLeft:
        room.drawOrder.length - room.turnIndex +
        room.drawOrder.length * Math.max(0, room.settings.rounds - room.round.round),
      customOnly: room.settings.customWordsOnly,
    });
    if (!choices.length) {
      this.system(room, 'The dictionary is out of unused words — ending the game.');
      this.finish(room);
      return;
    }
    room.offered = choices;
    for (const c of choices) if (c.id < 0) room.customOffered.set(customIndex(c.id), room.turnNo);

    const endsAt = Date.now() + room.settings.selectSeconds * 1000;
    room.round = {
      ...room.round,
      phase: 'selecting',
      drawerId: drawer.id,
      maskedWord: null,
      solution: null,
      endsAt,
      guessedPlayerIds: [],
      likes: 0,
      dislikes: 0,
    };
    this.publish(room);
    this.system(room, `${drawer.name} is choosing a word…`);

    this.socketOf(drawer)?.emit('word:options', {
      choices,
      allowCustom:
        room.settings.allowCustomWords &&
        (room.customCounts[drawer.id] ?? 0) < MAX_CUSTOM_PER_GAME,
    });

    // One stalled drawer must not freeze the room.
    this.later(room, room.settings.selectSeconds * 1000, () => this.autoPick(room));
  }

  /** The drawer ran out of time to choose: pick one of the offers for them. */
  private autoPick(room: Room): void {
    const pick = room.offered[Math.floor(Math.random() * room.offered.length)];
    if (!pick) return this.nextTurn(room);
    const drawer = this.currentDrawer(room);
    this.system(room, `${drawer?.name ?? 'The drawer'} took too long — picked for them.`);
    this.beginDrawing(room, this.activeFrom(room, pick));
  }

  choose(room: Room, player: PlayerRecord, wordId: number): void {
    this.assertSelecting(room, player);
    if (!room.offered.some((o) => o.id === wordId)) {
      throw new StoreError('INVALID', 'That word was not offered');
    }
    const offered = room.offered.find((o) => o.id === wordId)!;
    if (wordId > 0 && !wordById(wordId)) {
      throw new StoreError('INVALID', 'That word is no longer available');
    }
    this.beginDrawing(room, this.activeFrom(room, offered));
  }

  /**
   * An offered choice as the turn's word. Negative ids are entries of the
   * host's custom list: no dictionary row, so they are tracked per room.
   */
  private activeFrom(room: Room, choice: WordChoice): NonNullable<Room['active']> {
    if (choice.id < 0) {
      room.usedCustom.add(customIndex(choice.id));
      return { wordId: null, text: choice.text, normalized: normalizeWord(choice.text), custom: true };
    }
    return { wordId: choice.id, text: choice.text, normalized: normalizeWord(choice.text), custom: false };
  }

  /** Requirement 1: the drawer writes their own instead of taking an offer. */
  custom(room: Room, player: PlayerRecord, text: string): void {
    this.assertSelecting(room, player);
    if (!room.settings.allowCustomWords) {
      throw new StoreError('INVALID', 'Custom words are off in this room');
    }
    const used = room.customCounts[player.id] ?? 0;
    if (used >= MAX_CUSTOM_PER_GAME) {
      throw new StoreError('RATE_LIMITED', `Only ${MAX_CUSTOM_PER_GAME} custom words per game`);
    }
    const clean = acceptCustomWord(text, player.id, room.code);
    if (room.drawn.has(normalizeWord(clean))) {
      throw new StoreError('INVALID', 'That word was already drawn this game — pick another');
    }
    room.customCounts[player.id] = used + 1;
    this.beginDrawing(room, {
      wordId: null,
      text: clean,
      normalized: normalizeWord(clean),
      custom: true,
    });
  }

  private assertSelecting(room: Room, player: PlayerRecord): void {
    if (room.round.phase !== 'selecting') {
      throw new StoreError('BAD_PHASE', 'Not choosing a word right now');
    }
    if (room.round.drawerId !== player.id) {
      throw new StoreError('NOT_DRAWER', 'You are not the drawer');
    }
  }

  private beginDrawing(room: Room, active: Room['active']): void {
    if (!active) return;
    this.advance(room);
    // Dictionary words offered but passed over are spent too: being offered
    // the same three words again two turns later felt like a broken shuffle.
    // A host's word passed over stays in play — the host wants it drawn — and
    // sits out a couple of turns instead (see pickChoices).
    for (const o of room.offered) {
      if (o.id > 0 && !room.usedWordIds.includes(o.id)) room.usedWordIds.push(o.id);
    }
    room.active = active;
    room.offered = [];
    room.revealed = [];
    room.hintPlan = [];
    room.drawerEarned = 0;
    room.drawn.add(active.normalized);
    if (!active.custom) {
      if (!room.usedWordIds.includes(active.wordId!)) room.usedWordIds.push(active.wordId!);
      markDrawn(active.wordId);
    }

    const ms = room.settings.drawSeconds * 1000;
    room.round = {
      ...room.round,
      phase: 'drawing',
      maskedWord: maskWord(active.text),
      solution: null,
      endsAt: Date.now() + ms,
      guessedPlayerIds: [],
      likes: 0,
      dislikes: 0,
    };
    this.publish(room);

    const drawer = this.currentDrawer(room);
    if (drawer) {
      // On the books from the start, so the turn still counts for the summary
      // if their seat is gone before it ends.
      tallyOf(room, drawer);
      this.socketOf(drawer)?.emit('word:assigned', { text: active.text });
    }

    this.scheduleHints(room, active.text, ms);
    this.later(room, ms, () => this.endTurn(room, 'time'));
  }

  /**
   * Letters appear as the clock drains: up to the room's hint setting, spread
   * evenly between HINTS_FROM and HINTS_UNTIL of the turn.
   *
   * Never more than half of any word, so no word in a phrase is ever handed
   * over whole, and round-robin across the words — front-loading the first
   * word of "circle back" would give away far more than its share. Only
   * letters and digits are hints; punctuation is visible from the start.
   */
  private scheduleHints(room: Room, text: string, totalMs: number): void {
    const words: number[][] = [];
    let current: number[] = [];
    [...text].forEach((ch, i) => {
      if (ch === ' ') {
        if (current.length) words.push(current);
        current = [];
      } else if (isHintable(ch)) {
        current.push(i);
      }
    });
    if (current.length) words.push(current);

    // Each word keeps at least half its letters hidden.
    const queues = words.map((w) => shuffle(w).slice(0, Math.floor(w.length / 2)));
    const available = queues.reduce((n, q) => n + q.length, 0);
    const budget = Math.min(room.settings.hints, available);
    if (budget <= 0) return;

    const order: number[] = [];
    for (let i = 0; order.length < budget; i++) {
      for (const q of queues) {
        if (i < q.length && order.length < budget) order.push(q[i]!);
      }
    }

    const span = HINTS_UNTIL - HINTS_FROM;
    const start = Date.now();
    room.hintPlan = order.map((idx, n) => ({
      idx,
      at: start + totalMs * (HINTS_FROM + (span * (n + 1)) / (budget + 1)),
    }));
    for (const h of room.hintPlan) this.armHint(room, h.idx, h.at - start);
  }

  private armHint(room: Room, idx: number, delay: number): void {
    this.later(room, Math.max(0, delay), () => {
      const text = room.active?.text;
      if (!text || room.revealed.includes(idx)) return;
      room.revealed.push(idx);
      const masked = maskWord(text, new Set(room.revealed));
      room.round = { ...room.round, maskedWord: masked };
      this.io.to(room.code).emit('round:hint', { maskedWord: masked });
    });
  }

  /**
   * Picks a restored room back up after a server restart. Every deadline moves
   * by the downtime — the game was paused, not running unattended — and the
   * timers for the current phase are re-armed from the room's own state.
   */
  resumeRoom(room: Room, downtimeMs: number): void {
    const now = Date.now();
    if (room.round.endsAt) room.round = { ...room.round, endsAt: room.round.endsAt + downtimeMs };
    room.hintPlan = room.hintPlan.map((h) => ({ ...h, at: h.at + downtimeMs }));
    const left = Math.max(1000, (room.round.endsAt ?? now) - now);

    switch (room.round.phase) {
      case 'selecting':
        this.later(room, left, () => this.autoPick(room));
        break;
      case 'drawing':
        for (const h of room.hintPlan) {
          if (!room.revealed.includes(h.idx)) this.armHint(room, h.idx, h.at - now);
        }
        this.later(room, left, () => this.endTurn(room, 'time'));
        break;
      case 'reveal':
        this.later(room, left, () => this.nextTurn(room));
        break;
      case 'scoreboard':
        this.later(room, left, () =>
          room.finalScoreboard ? this.finish(room) : this.beginSelection(room),
        );
        break;
      case 'finished':
        // No clock. The summary was saved with the room and is never rebuilt:
        // a snapshot from before summaries existed has empty tallies. Nobody
        // is connected this early; each player gets it as they resume.
        break;
      default:
        break; // the lobby has no clock
    }
  }

  /* ---------------------------------------------------------- reactions */

  /**
   * A guesser's 👍 / 👎 on the drawing in progress. One vote each per turn:
   * switching is allowed, repeating the same vote is ignored — so the buttons
   * can't be used to flood the room. Totals ride in the round state, so they
   * survive a reconnect or a server restart.
   */
  react(room: Room, player: PlayerRecord, reaction: 'up' | 'down'): void {
    if (room.round.phase !== 'drawing') {
      throw new StoreError('BAD_PHASE', 'You can react while someone is drawing');
    }
    if (room.round.drawerId === player.id) {
      throw new StoreError('NOT_DRAWER', 'No rating your own drawing!');
    }
    if (room.reactions.get(player.id) === reaction) return;
    room.reactions.set(player.id, reaction);
    let likes = 0;
    let dislikes = 0;
    for (const r of room.reactions.values()) r === 'up' ? likes++ : dislikes++;
    room.round = { ...room.round, likes, dislikes };
    this.io.to(room.code).emit('draw:reaction', {
      playerId: player.id,
      playerName: player.name,
      reaction,
      likes,
      dislikes,
    });
    this.system(
      room,
      `${player.name} ${reaction === 'up' ? 'liked' : 'disliked'} the drawing`,
      reaction === 'up' ? 'correct' : 'wrong',
    );
  }

  /* ----------------------------------------------------------- guessing */

  /**
   * One entry point for everything typed into chat during a round. Returns
   * nothing: all feedback goes out as events, because what each player may see
   * differs — the guesser, the people who already solved it, and everyone else
   * get different views of the same message.
   */
  guess(room: Room, player: PlayerRecord, raw: string): void {
    const text = raw.trim().slice(0, 120);
    if (!text) return;

    const active = room.active;
    const live = room.round.phase === 'drawing' && active !== null;

    // Outside a live round chat is just chat.
    if (!live) {
      this.broadcastChat(room, this.chat('guess', player, text));
      return;
    }

    // The drawer typing would be an instant spoiler, deliberate or not.
    if (room.round.drawerId === player.id) {
      this.socketOf(player)?.emit('error:toast', {
        code: 'NOT_DRAWER',
        message: 'You are drawing — no chatting!',
      });
      return;
    }

    const already = room.round.guessedPlayerIds.includes(player.id);
    if (already) {
      // Solvers talk among themselves; the room must not see it.
      this.sendToSolvers(room, this.chat('post-guess', player, text));
      return;
    }

    // Spaces count no more than capitals or punctuation: "icecream" is a
    // right answer to "Ice Cream", not a near miss.
    if (guessKey(text) === guessKey(active!.text)) {
      this.award(room, player);
      return;
    }

    if (isCloseGuess(text, active!.text)) {
      this.socketOf(player)?.emit('chat:close', { text: `"${text}" is close!` });
    }
    this.broadcastChat(room, this.chat('guess', player, text, 'wrong'));
  }

  private award(room: Room, player: PlayerRecord): void {
    const total = room.settings.drawSeconds * 1000;
    const left = Math.max(0, (room.round.endsAt ?? 0) - Date.now());
    const frac = total > 0 ? Math.min(1, left / total) : 0;

    const place = room.round.guessedPlayerIds.length; // 0 = first to get it
    player.score += guessPoints(frac, place);
    room.round = {
      ...room.round,
      guessedPlayerIds: [...room.round.guessedPlayerIds, player.id],
    };

    const drawer = room.round.drawerId ? room.players.get(room.round.drawerId) : null;
    if (drawer) {
      // A share per guesser, sized to the room, capped at the full amount.
      const guessers = [...room.players.values()].filter(
        (p) => p.connected && p.id !== drawer.id,
      ).length;
      const share = Math.round(DRAWER_TURN_POINTS / Math.max(1, guessers));
      const earned = Math.min(share, Math.max(0, DRAWER_TURN_POINTS - room.drawerEarned));
      drawer.score += earned;
      room.drawerEarned += earned;
    }

    // For the summary. Time into the drawing rather than a timestamp: endsAt
    // moves with a restart's downtime, so this survives one.
    recordGuess(room, player, place, total - left);
    if (drawer) tallyOf(room, drawer);

    // Stats feed the retirement query — see PLAN.md §7a.
    if (room.active?.custom) markSuggestionGuessed(room.active.normalized);
    else markGuessed(room.active?.wordId ?? null);

    this.system(room, `${player.name} guessed it!`, 'correct');
    this.publish(room);
    this.sendPlayers(room);
    // The solver sees the word instead of the blanks for the rest of the turn;
    // only them — everyone else is still guessing.
    if (room.active) this.socketOf(player)?.emit('word:assigned', { text: room.active.text });

    // Everyone but the drawer has it — no reason to run the clock down.
    const pending = [...room.players.values()].filter(
      (p) =>
        p.connected &&
        p.id !== room.round.drawerId &&
        !room.round.guessedPlayerIds.includes(p.id),
    );
    if (pending.length === 0) this.endTurn(room, 'all-guessed');
  }

  private chat(
    channel: ChatMessage['channel'],
    player: PlayerRecord,
    text: string,
    tone: ChatTone = 'neutral',
  ): ChatMessage {
    return {
      id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channel,
      tone,
      playerId: player.id,
      playerName: player.name,
      text,
      at: Date.now(),
    };
  }

  private broadcastChat(room: Room, m: ChatMessage): void {
    this.io.to(room.code).emit('chat:message', m);
  }

  /**
   * Post-guess chat reaches only players who have already solved it, plus the
   * drawer. Without this the first correct guesser trivially spoils the round
   * for everyone else.
   */
  private sendToSolvers(room: Room, m: ChatMessage): void {
    for (const p of room.players.values()) {
      const eligible =
        p.id === room.round.drawerId || room.round.guessedPlayerIds.includes(p.id);
      if (eligible) this.socketOf(p)?.emit('chat:message', m);
    }
  }

  /**
   * Re-send whatever the round had already pushed to this player privately.
   * `room:state` carries the public view, so a reconnecting drawer gets the
   * mask like everyone else and is left drawing a word they can no longer see —
   * or, mid-selection, with no choices to pick from. Refreshing the page is the
   * first thing a confused player does, so this path has to be whole.
   */
  resendTurnContext(room: Room, player: PlayerRecord): void {
    const socket = this.socketOf(player);
    if (!socket) return;
    // A guesser who already solved this turn gets the word back too.
    if (room.round.drawerId !== player.id) {
      if (room.round.phase === 'drawing' && room.active && room.round.guessedPlayerIds.includes(player.id)) {
        socket.emit('word:assigned', { text: room.active.text });
      }
      return;
    }

    if (room.round.phase === 'drawing' && room.active) {
      socket.emit('word:assigned', { text: room.active.text });
    } else if (room.round.phase === 'selecting' && room.offered.length) {
      socket.emit('word:options', {
        choices: room.offered,
        allowCustom:
          room.settings.allowCustomWords &&
          (room.customCounts[player.id] ?? 0) < MAX_CUSTOM_PER_GAME,
      });
    }
  }

  /**
   * Someone left. Re-check after a grace period rather than immediately,
   * because a page refresh reaches the server as exactly this event — acting on
   * it at once meant a drawer who refreshed killed their own turn before they
   * could come back, and in a two-player room ended the whole game.
   */
  playerLeft(room: Room, graceMs = DEPARTURE_GRACE_MS): void {
    const phase = room.round.phase;
    if (phase === 'lobby' || phase === 'finished') return;
    if (this.rosterChecks.has(room.code)) return;
    const t = setTimeout(() => {
      this.rosterChecks.delete(room.code);
      try {
        this.reevaluate(room);
      } catch (e) {
        console.error('[round] roster check failed', e);
      }
    }, graceMs);
    this.rosterChecks.set(room.code, t);
  }

  /**
   * Every rule about whether a turn or a game should still be running hangs off
   * an event that a departure does not fire — `award` decides "everyone has
   * guessed", `startGame` decides "enough players". Without re-checking here,
   * the room keeps running a turn nobody is left to finish.
   *
   */
  private reevaluate(room: Room): void {
    const phase = room.round.phase;
    if (phase === 'lobby' || phase === 'finished') return;

    const connected = [...room.players.values()].filter((p) => p.connected);
    if (connected.length < 2) {
      // Every turn has been played: the game ends on schedule, complete,
      // rather than being called off during its closing screens.
      if (this.noTurnsLeft(room)) return;
      this.system(room, 'Not enough players left — ending the game.');
      this.finish(room, 'abandoned');
      return;
    }

    const drawer = room.round.drawerId ? room.players.get(room.round.drawerId) : null;
    if ((phase === 'selecting' || phase === 'drawing') && !drawer?.connected) {
      this.endTurn(room, 'drawer-left');
      return;
    }

    if (phase === 'drawing') {
      const pending = connected.filter(
        (p) =>
          p.id !== room.round.drawerId &&
          !room.round.guessedPlayerIds.includes(p.id),
      );
      if (pending.length === 0) this.endTurn(room, 'all-guessed');
    }
  }

  /**
   * Only the closing screens are left: the final scoreboard, or the reveal of
   * the last round's last turn. A slot still to come is a turn left unless its
   * seat is gone (a kicked player's is skipped), and so is a newcomer waiting
   * to be added to the queue.
   */
  private noTurnsLeft(room: Room): boolean {
    if (room.round.phase === 'scoreboard') return room.finalScoreboard;
    return (
      room.round.phase === 'reveal' &&
      room.round.round >= room.settings.rounds &&
      room.drawOrder.slice(room.turnIndex + 1).every((id) => !room.players.has(id)) &&
      room.order.every((id) => room.drawOrder.includes(id))
    );
  }

  /** Called by the timer, by the guess handler when everyone is done, or on drawer exit. */
  endTurn(room: Room, reason: 'time' | 'all-guessed' | 'drawer-left'): void {
    if (room.round.phase !== 'drawing' && room.round.phase !== 'selecting') return;
    this.advance(room);
    recordTurn(room);
    const solution = room.active?.text ?? null;
    room.round = {
      ...room.round,
      phase: 'reveal',
      solution,
      endsAt: Date.now() + REVEAL_MS,
    };
    this.publish(room);
    this.sendPlayers(room);
    const guessers = [...room.players.values()].filter(
      (p) => p.connected && p.id !== room.round.drawerId,
    ).length;
    if (solution) {
      const why =
        reason === 'all-guessed' ? 'Everyone got it!'
        : reason === 'drawer-left' ? 'The drawer left.'
        : "Time's up.";
      this.system(room, `${why} The word was "${solution}".`);
    }
    this.later(room, REVEAL_MS, () => this.nextTurn(room));
  }

  /**
   * The draw order is snapshotted when the game starts, so a player who joins
   * afterwards is simply absent from it and would sit out every round of the
   * game. Fold newcomers in at the back of the queue between turns: appending
   * cannot disturb `turnIndex`, which makes it safe mid-round, and it means a
   * late arrival draws in the round they joined rather than waiting one out.
   */
  private admitNewcomers(room: Room): void {
    const queued = new Set(room.drawOrder);
    for (const id of room.order) {
      if (!queued.has(id)) room.drawOrder.push(id);
    }
  }

  /**
   * Rebuild the queue from the live roster, dropping anyone who left for good.
   * Only safe at a round boundary, where `turnIndex` resets anyway — removing
   * an entry mid-round shifts every later slot and would change who draws next.
   * Players who are merely disconnected keep their slot; they may be back
   * before it comes round, and `beginSelection` skips them if not.
   */
  private rebuildDrawOrder(room: Room): void {
    room.drawOrder = room.order.filter((id) => room.players.has(id));
  }

  private nextTurn(room: Room): void {
    this.advance(room);
    this.admitNewcomers(room);
    room.turnIndex++;
    if (room.turnIndex < room.drawOrder.length) {
      this.beginSelection(room);
      return;
    }
    // Everyone has drawn once: that is one round.
    room.turnIndex = 0;
    this.rebuildDrawOrder(room);
    if (room.round.round >= room.settings.rounds) {
      this.showScoreboard(room, true);
      return;
    }
    room.round = { ...room.round, round: room.round.round + 1 };
    this.showScoreboard(room, false);
  }

  private showScoreboard(room: Room, final: boolean): void {
    this.advance(room);
    room.finalScoreboard = final;
    room.round = {
      ...room.round,
      phase: 'scoreboard',
      endsAt: Date.now() + SCOREBOARD_MS,
      solution: null,
    };
    this.publish(room);
    this.io.to(room.code).emit('game:scores', {
      players: store.publicPlayers(room),
      final,
    });
    if (final) {
      this.later(room, SCOREBOARD_MS, () => this.finish(room));
    } else {
      this.later(room, SCOREBOARD_MS, () => this.beginSelection(room));
    }
  }

  private finish(room: Room, reason: 'completed' | 'abandoned' = 'completed'): void {
    this.advance(room);
    // A game cut short mid-turn keeps its last drawing. Only then: from the
    // reveal or a scoreboard, `active` is a turn endTurn has already booked.
    if (room.round.phase === 'drawing' && room.active) recordTurn(room);
    // A scoreboard between rounds has already counted in a round nobody drew.
    const rounds =
      room.round.phase === 'scoreboard' && !room.finalScoreboard
        ? room.round.round - 1
        : room.round.round;
    room.round = {
      ...room.round,
      phase: 'finished',
      drawerId: null,
      maskedWord: null,
      endsAt: null,
    };
    room.active = null;
    room.summary = buildSummary(room, rounds, reason === 'abandoned');
    // Ahead of the phase change: clients open the results screen on it, and
    // the summary should already be there.
    this.io.to(room.code).emit('game:summary', room.summary);
    this.publish(room);
    this.io.to(room.code).emit('game:scores', {
      players: store.publicPlayers(room),
      final: true,
    });
  }

  /** Back to lobby: the host restarted, mid-game or from the podium. */
  reset(room: Room): void {
    this.advance(room);
    const pending = this.rosterChecks.get(room.code);
    if (pending) clearTimeout(pending);
    this.rosterChecks.delete(room.code);
    room.round = {
      phase: 'lobby',
      round: 0,
      totalRounds: room.settings.rounds,
      drawerId: null,
      maskedWord: null,
      solution: null,
      endsAt: null,
      guessedPlayerIds: [],
      likes: 0,
      dislikes: 0,
    };
    room.active = null;
    room.offered = [];
    room.revealed = [];
    room.finalScoreboard = false;
    clearStrokes(room);
    resetSummary(room);
    for (const p of room.players.values()) p.score = 0;
    this.publish(room);
    this.sendPlayers(room);
    this.io.to(room.code).emit('draw:clear', {});
  }

  /** A room being collected must not leave timers behind. */
  dispose(code: string): void {
    for (const t of this.timers.get(code) ?? []) clearTimeout(t);
    this.timers.delete(code);
    const pending = this.rosterChecks.get(code);
    if (pending) clearTimeout(pending);
    this.rosterChecks.delete(code);
  }
}

/** Points for a correct guess: speed, plus a bonus for the first few to get it. */
export function guessPoints(timeLeftFraction: number, place: number): number {
  const f = Math.min(1, Math.max(0, timeLeftFraction));
  return Math.round(GUESS_BASE + GUESS_SPEED * f) + (ORDER_BONUS[place] ?? 0);
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
