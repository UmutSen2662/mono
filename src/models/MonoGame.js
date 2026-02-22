const { v4: uuidv4 } = require("uuid");
const { mod, shuffle } = require("../utils");
const { GAME_STATES, AI_NAMES } = require("../constants");

class MonoGame {
    constructor(id, name, password) {
        this.id = id;
        this.name = name;
        this.password = password;

        // Game State
        this.players = [];
        this.deck = [];
        this.discard = [];
        this.state = GAME_STATES.LOBBY;

        // Turn State
        this.current_player = 0;
        this.reversed = false;
        this.plus = 1;

        // Internal tracking to prevent "Ghost Bot" moves
        this.matchId = 0;
    }

    // --- Player Management ---
    addPlayer(id, name, isBot = false) {
        if (this.state !== GAME_STATES.LOBBY) return false;

        this.players.push({
            id: id,
            name: name,
            ready: isBot, // Bots are always ready
            hand: [],
            bot: isBot,
            score: 0,
        });
        return true;
    }

    removePlayer(id) {
        this.players = this.players.filter((p) => p.id !== id);
        // Force unready to prevent race conditions
        this.players.forEach((p) => {
            if (!p.bot) p.ready = false;
        });

        // If game was running and a human left, abort to lobby
        if (this.state !== GAME_STATES.LOBBY) {
            this.resetToLobby();
        }
    }

    addBot() {
        const currentNames = this.players.map((p) => p.name);
        const availableNames = AI_NAMES.filter((n) => !currentNames.includes(n));
        const name =
            availableNames.length > 0
                ? availableNames[Math.floor(Math.random() * availableNames.length)]
                : "Bot " + Math.floor(Math.random() * 100);

        this.addPlayer(uuidv4().replace(/-/g, ""), name, true);
    }

    setReady(playerId, status) {
        if (this.state !== GAME_STATES.LOBBY) return;
        const p = this.players.find((p) => p.id === playerId);
        if (p) p.ready = status;
    }

    // --- Game Lifecycle ---
    tryStartGame() {
        if (this.state !== GAME_STATES.LOBBY) return false;
        if (this.players.length < 2) return false;
        if (!this.players.every((p) => p.ready)) return false;

        this.matchId++; // Increment match ID. Old bot timeouts will now fail.
        this.state = "s"; // "Start" animation state
        this.reversed = false;
        this.current_player = 0;
        this.plus = 1;

        this._setupDeck();
        this._dealCards();

        return true;
    }

    resetToLobby() {
        this.state = GAME_STATES.LOBBY;
        this.matchId++;
        this.players.forEach((p) => {
            p.hand = [];
            if (!p.bot) p.ready = false;
        });
    }

    // --- Gameplay Actions ---
    drawCard(playerId) {
        if (this.state === GAME_STATES.LOBBY) return;

        if (this.players[this.current_player].id !== playerId) return;

        if (this.deck.length < this.plus + 1) this._recycleDiscard();

        // Must play check
        if (this.plus !== 1) {
            // They accepted the penalty
            this._giveCards(this.current_player, this.plus);
            this.plus = 1;
            this._nextTurn();
        } else {
            // Normal Draw
            const newCard = this.deck[this.deck.length - 1]; // Peek
            const topCard = this.discard[this.discard.length - 1];

            this._giveCards(this.current_player, 1);

            if (!this._isPlayable(topCard, newCard)) {
                this._nextTurn();
            }
        }

        if (this.state !== GAME_STATES.LOBBY) this.state = GAME_STATES.PLAYING;
    }

    playCard(playerId, card) {
        if (this.state === GAME_STATES.LOBBY) return false;

        const playerIdx = this.players.findIndex((p) => p.id === playerId);
        if (playerIdx !== this.current_player) return false;

        const player = this.players[playerIdx];
        if (!player.hand.includes(card)) return false;

        const topCard = this.discard[this.discard.length - 1];
        if (!this._isPlayable(topCard, card)) {
            return false; // Reject illegal move
        }

        // Execute Play
        player.hand = player.hand.filter((c) => c !== card);
        this.discard.push(card);
        this.state = GAME_STATES.PLAYING;

        // Check Win
        if (player.hand.length === 0) {
            player.score++;
            return { winner: player, played: true };
        }

        // Apply Card Effects
        let skip = 1;

        if (card[0] === "s") {
            skip = 0; // Pause for color pick
            if (card[1] === "p") {
                this.state = "p4"; // Visual state
                this.plus += this.plus !== 1 ? 4 : 3;
            }
        } else {
            if (card[1] === "p") {
                this.state = "p2";
                this.plus += this.plus !== 1 ? 2 : 1;
            } else if (card[1] === "s") {
                skip = 2;
            } else if (card[1] === "r") {
                this.reversed = !this.reversed;
            }
        }

        this._nextTurn(skip);
        return { played: true };
    }

    pickColor(playerId, color) {
        // Validation
        if (this.players[this.current_player].id !== playerId) return;
        const top = this.discard[this.discard.length - 1];
        if (top[0] !== "s") return; // Can't pick color if not wild

        this.discard[this.discard.length - 1] = top + color;
        this._nextTurn(1);
    }

    // --- Bot AI ---
    getBotMove() {
        const current = this.players[this.current_player];
        if (!current.bot) return null;

        return {
            playerId: current.id,
            matchId: this.matchId, // Crucial for fixing the ghost bug
        };
    }

    executeBotLogic() {
        if (this.state === GAME_STATES.LOBBY) return null;

        const current = this.players[this.current_player];
        if (!current.bot) return null;

        const topCard = this.discard[this.discard.length - 1];
        let played = false;

        // --- PRIORITY 1: Handle Draw Stacking (p4 / p2) ---
        if (this.state === "p4") {
            // Must play a Draw 4 (sp) to stack
            const card = current.hand.find((c) => c.substring(0, 2) === "sp");
            if (card) {
                this._playBotWild(current, card, true);
                played = true;
            }
        } else if (this.state === "p2") {
            // Must play a Draw 2 (p) to stack
            const card = current.hand.find((c) => c[1] === "p" && c[0] !== "s");
            if (card) {
                const res = this.playCard(current.id, card);
                if (res && res.winner) return res;
                played = true;
            }
        }
        // --- PRIORITY 2: Normal Play ---
        else {
            // Find the FIRST card that the Engine allows
            const playableCard = current.hand.find((c) => this._isPlayable(topCard, c));

            if (playableCard) {
                // If it's a Wild, handle color picking manually
                if (playableCard[0] === "s") {
                    this._playBotWild(current, playableCard, false);
                } else {
                    const res = this.playCard(current.id, playableCard);
                    if (res && res.winner) return res;
                }
                played = true;
            }
        }

        if (!played) {
            // Capture who is playing BEFORE the draw
            const playerIndexBeforeDraw = this.current_player;

            this.drawCard(current.id);

            // FIX: Check if the turn passed.
            // If current_player is STILL the same after drawing, it means
            // the drawn card is playable and the bot kept the turn.
            if (this.current_player === playerIndexBeforeDraw) {
                return { played: false, keepTurn: true };
            }
        }

        // Check Win
        if (current.hand.length === 0) {
            current.score++;
            return { winner: current, played: true };
        }

        return { played };
    }

    // --- Private Helpers ---
    _playBotWild(player, card, isStacking) {
        const color = this._botPickColor(player.hand);

        player.hand = player.hand.filter((c) => c !== card);
        this.discard.push(card + color);

        if (isStacking || card[1] === "p") {
            this.state = "p4";
            this.plus += this.plus !== 1 ? 4 : 3;
        } else {
            this.state = GAME_STATES.PLAYING;
        }

        this._nextTurn(1);
    }

    _setupDeck() {
        let deck = [];
        ["r", "g", "b", "y"].forEach((color) => {
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, "p", "s", "r"].forEach((type) => {
                deck.push(color + type + "0");
                deck.push(color + type + "1");
            });
        });
        for (let i = 0; i < 4; i++) {
            deck.push("sp" + i);
            deck.push("sc" + i);
        }
        this.deck = shuffle(deck);
        this.discard = [this.deck.pop()];
        while (this.discard[this.discard.length - 1][0] === "s") {
            this.discard.push(this.deck.pop());
        }
    }

    _dealCards() {
        this.players.forEach((p) => {
            p.hand = [];
            for (let i = 0; i < 7; i++) p.hand.push(this.deck.pop());
        });
    }

    _recycleDiscard() {
        const top = this.discard.pop();
        const recycled = this.discard.map((c) => c.substring(0, 3));
        this.deck = shuffle([...this.deck, ...recycled]);
        this.discard = [top];
    }

    _nextTurn(skip = 1) {
        if (skip === 0) return; // Waiting for color pick
        const dir = this.reversed ? -skip : skip;
        this.current_player = mod(this.current_player + dir, this.players.length);
    }

    _giveCards(playerIdx, count) {
        if (this.deck.length < count) this._recycleDiscard();
        const cards = this.deck.splice(-count);
        this.players[playerIdx].hand.push(...cards);
    }

    _isPlayable(topCard, card) {
        // Handle Draw 4 State (Must play Draw 4 to stack)
        if (this.state === "p4") {
            return card.substring(0, 2) === "sp";
        }

        // Handle Draw 2 State (Must play Draw 2 to stack)
        if (this.state === "p2") {
            // Must be a '+2' card (index 1 is 'p') and NOT a wild (index 0 is not 's')
            return card[1] === "p" && card[0] !== "s";
        }

        // 3. Normal State
        if (card[0] === "s") return true;

        let activeTop = topCard;
        if (activeTop.length === 4) {
            activeTop = activeTop[3] + activeTop.substring(1);
        }

        // Match Color OR Match Type/Number
        return card[0] === activeTop[0] || card[1] === activeTop[1];
    }

    _botPickColor(hand) {
        const counts = {};
        hand.forEach((c) => {
            counts[c[0]] = (counts[c[0]] || 0) + 1;
        });
        const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        return best && best[0] !== "s" ? best[0] : ["r", "g", "b", "y"][Math.floor(Math.random() * 4)];
    }
}

module.exports = MonoGame;
