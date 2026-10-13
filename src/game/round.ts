import type { Server } from 'socket.io';
import {
  type ChatMessage,
  type ChatTone,
  type ClientToServerEvents,
  type ServerToClientEvents,
  isCloseGuess,
  maskWord,
  normalizeWord,
} from '../contract/index.js';
import { StoreError, store } from './store.js';
import type { PlayerRecord, Room } from './types.js';
import {
  acceptCustomWord,
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

/** Guessing is worth this at the buzzer, rising toward BASE+BONUS at full time. */
const GUESS_BASE = 60;
const GUESS_BONUS = 240;
/** The drawer earns per person who gets it — drawing clearly beats drawing cryptically. */
const DRAWER_PER_GUESS = 50;
/** Ceiling on a drawer's take from one turn, just under a guesser's best. */
const DRAWER_MAX_PER_TURN = 250;
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
    room.drawOrder = room.order.filter((id) => room.players.get(id)?.connected);
    room.turnIndex = 0;
    room.usedWordIds = [];
    room.customCounts = {};
    room.round = {
      ...room.round,
      phase: 'selecting',
      round: 1,
      totalRounds: room.settings.rounds,
      guessedPlayerIds: [],
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
    room.strokes = [];
    room.revealed = [];
    room.active = null;
    this.io.to(room.code).emit('draw:clear', {});

    const drawer = this.currentDrawer(room);
    if (!drawer || !drawer.connected) {
      // Nobody home for this slot — skip rather than stall the room.
      this.nextTurn(room);
      return;
    }

    const choices = pickChoices(room.usedWordIds);
    if (!choices.length) {
      this.system(room, 'The dictionary is out of unused words — ending the game.');
      this.finish(room);
      return;
    }
    room.offered = choices;

    const endsAt = Date.now() + room.settings.selectSeconds * 1000;
    room.round = {
      ...room.round,
      phase: 'selecting',
      drawerId: drawer.id,
      maskedWord: null,
      solution: null,
      endsAt,
      guessedPlayerIds: [],
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
    this.later(room, room.settings.selectSeconds * 1000, () => {
      const pick = choices[Math.floor(Math.random() * choices.length)]!;
      this.system(room, `${drawer.name} took too long — picked for them.`);
      this.beginDrawing(room, {
        wordId: pick.id,
        text: pick.text,
        normalized: normalizeWord(pick.text),
        custom: false,
      });
    });
  }

  choose(room: Room, player: PlayerRecord, wordId: number): void {
    this.assertSelecting(room, player);
    if (!room.offered.some((o) => o.id === wordId)) {
      throw new StoreError('INVALID', 'That word was not offered');
    }
    const word = wordById(wordId);
    if (!word) throw new StoreError('INVALID', 'That word is no longer available');
    this.beginDrawing(room, {
      wordId: word.id,
      text: word.text,
      normalized: normalizeWord(word.text),
      custom: false,
    });
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
    room.active = active;
    room.offered = [];
    room.revealed = [];
    room.drawerEarned = 0;
    if (!active.custom) {
      room.usedWordIds.push(active.wordId!);
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
    };
    this.publish(room);

    const drawer = this.currentDrawer(room);
    if (drawer) this.socketOf(drawer)?.emit('word:assigned', { text: active.text });

    this.scheduleHints(room, active.text, ms);
    this.later(room, ms, () => this.endTurn(room, 'time'));
  }

  /**
   * Letters appear as the clock drains, capped at ~35% of non-space characters
   * and spread across every word in the phrase — front-loading the first word
   * of "circle back" would give away far more than a third of it.
   */
  private scheduleHints(room: Room, text: string, totalMs: number): void {
    const indices = [...text].map((c, i) => (c === ' ' ? -1 : i)).filter((i) => i >= 0);
    const budget = Math.floor(indices.length * 0.35);
    if (budget <= 0) return;

    const perWord = new Map<number, number[]>();
    let word = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === ' ') { word++; continue; }
      const list = perWord.get(word) ?? [];
      list.push(i);
      perWord.set(word, list);
    }
    // Round-robin across words so every word thaws at a similar rate.
    const queues = [...perWord.values()].map((l) => shuffle(l));
    const order: number[] = [];
    for (let i = 0; order.length < budget; i++) {
      let progressed = false;
      for (const q of queues) {
        if (i < q.length) { order.push(q[i]!); progressed = true; }
        if (order.length >= budget) break;
      }
      if (!progressed) break;
    }

    const firstAt = totalMs * 0.45;
    const gap = (totalMs * 0.45) / Math.max(1, order.length);
    order.forEach((idx, n) => {
      this.later(room, firstAt + gap * n, () => {
        room.revealed.push(idx);
        const masked = maskWord(text, new Set(room.revealed));
        room.round = { ...room.round, maskedWord: masked };
        this.io.to(room.code).emit('round:hint', { maskedWord: masked });
      });
    });
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

    if (normalizeWord(text) === active!.normalized) {
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

    player.score += Math.round(GUESS_BASE + GUESS_BONUS * frac);
    room.round = {
      ...room.round,
      guessedPlayerIds: [...room.round.guessedPlayerIds, player.id],
    };

    const drawer = room.round.drawerId ? room.players.get(room.round.drawerId) : null;
    if (drawer) {
      // Uncapped, this pays the drawer 50 per guesser, so in a ten-player room
      // one turn is worth more than a guesser can score all game and turn order
      // quietly decides the winner.
      const headroom = Math.max(0, DRAWER_MAX_PER_TURN - room.drawerEarned);
      const earned = Math.min(DRAWER_PER_GUESS, headroom);
      drawer.score += earned;
      room.drawerEarned += earned;
    }

    // Stats feed the retirement query — see PLAN.md §7a.
    if (room.active?.custom) markSuggestionGuessed(room.active.normalized);
    else markGuessed(room.active?.wordId ?? null);

    this.system(room, `${player.name} guessed it!`, 'correct');
    this.publish(room);
    this.sendPlayers(room);

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
    if (room.round.drawerId !== player.id) return;
    const socket = this.socketOf(player);
    if (!socket) return;

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
  playerLeft(room: Room): void {
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
    }, DEPARTURE_GRACE_MS);
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
      this.system(room, 'Not enough players left — ending the game.');
      this.finish(room);
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

  /** Called by the timer, by the guess handler when everyone is done, or on drawer exit. */
  endTurn(room: Room, reason: 'time' | 'all-guessed' | 'drawer-left'): void {
    if (room.round.phase !== 'drawing' && room.round.phase !== 'selecting') return;
    this.advance(room);
    const solution = room.active?.text ?? null;
    room.round = {
      ...room.round,
      phase: 'reveal',
      solution,
      endsAt: Date.now() + REVEAL_MS,
    };
    this.publish(room);
    this.sendPlayers(room);
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

  private finish(room: Room): void {
    this.advance(room);
    room.round = {
      ...room.round,
      phase: 'finished',
      drawerId: null,
      maskedWord: null,
      endsAt: null,
    };
    room.active = null;
    this.publish(room);
    this.io.to(room.code).emit('game:scores', {
      players: store.publicPlayers(room),
      final: true,
    });
  }

  /** Back to lobby, e.g. the host wants another game. */
  reset(room: Room): void {
    this.advance(room);
    room.round = {
      phase: 'lobby',
      round: 0,
      totalRounds: room.settings.rounds,
      drawerId: null,
      maskedWord: null,
      solution: null,
      endsAt: null,
      guessedPlayerIds: [],
    };
    room.active = null;
    room.strokes = [];
    this.publish(room);
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

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
