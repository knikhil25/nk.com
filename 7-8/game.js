/**
 * Saat Aath (7-8) Card Game - Table Card Variation Logic
 */

// ── CONSTANTS & SUIT PATHS ──
const SUIT_SYMBOLS = {
    'S': '♠',
    'H': '♥',
    'D': '♦',
    'C': '♣'
};

const SUIT_NAMES = {
    'S': 'Spades',
    'H': 'Hearts',
    'D': 'Diamonds',
    'C': 'Clubs'
};

const CARD_RANKS = {
    7: '7',
    8: '8',
    9: '9',
    10: '10',
    11: 'J',
    12: 'Q',
    13: 'K',
    14: 'A'
};

// ── BROKER CONFIG ──
const BROKERS = [
    "wss://broker.emqx.io:8084/mqtt",
    "wss://broker.hivemq.com:8884/mqtt"
];
let brokerIndex = 0;
let client = null;
let roomCode = null;
let myId = 'p_' + Math.random().toString(36).substring(2, 10);
let opponentId = null;
let myRole = null; // 'host' or 'guest'
let opponentPresent = false;
let heartbeatInterval = null;

// AUTHORITATIVE GAME STATE (only modified by host, synced to guest)
let gameState = {
    round: 1,
    player1Id: null, // Host (starts as Trump Maker, needs 8)
    player2Id: null, // Guest (starts as Dealer, needs 7)
    trumpSuit: null,
    tricks: {}, // { playerId: tricksWon }
    playerHands: {}, // { playerId: Array of card objects (5 cards) }
    tableSets: {}, // { playerId: Array of { bottom: card|null, top: card|null } }
    deckRemaining: [],
    currentTrick: [], // Array of { playerId, card }
    lastTrick: [],
    roundState: 'LOBBY', // 'LOBBY', 'DEAL_5', 'CHOOSE_TRUMP', 'PLAYING', 'PULLING', 'ROUND_OVER'
    
    // Card Pulling state
    pullsRemaining: 0,
    pullerId: null,
    returnerId: null,
    pulledCard: null,
    pullHistory: [],
    
    readyForNextRound: {}, // { playerId: boolean }
    history: []
};

// Local UI tracking
let isAnimatingTrick = false;

// ── INITIALIZATION ──
document.addEventListener('DOMContentLoaded', () => {
    initUIEvents();
    connectToBroker();
    
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    if (roomParam && roomParam.length === 4) {
        document.getElementById('join-code-input').value = roomParam;
        setTimeout(() => {
            joinRoom(roomParam);
        }, 1000);
    }
});

// ── CONNECTION HANDLER ──
function connectToBroker() {
    updateConnectionStatus(false, "Connecting...");
    const url = BROKERS[brokerIndex];
    console.log(`Connecting to broker: ${url}`);
    
    try {
        client = mqtt.connect(url, {
            keepalive: 15,
            clientId: 'nk78_' + myId,
            reconnectPeriod: 4000,
            connectTimeout: 8000,
        });
        
        client.on('connect', () => {
            console.log("Connected to MQTT broker successfully!");
            updateConnectionStatus(true, "Connected");
            if (roomCode) {
                subscribeToRoom(roomCode);
            }
        });
        
        client.on('error', (err) => {
            console.error("Broker connection error:", err);
            client.end();
            fallbackToNextBroker();
        });
        
        client.on('close', () => {
            console.log("Connection closed.");
            updateConnectionStatus(false, "Disconnected");
        });
        
        client.on('message', handleMqttMessage);
    } catch (e) {
        console.error("Failed to initialize MQTT client:", e);
        fallbackToNextBroker();
    }
}

function fallbackToNextBroker() {
    brokerIndex = (brokerIndex + 1) % BROKERS.length;
    setTimeout(connectToBroker, 2000);
}

function updateConnectionStatus(isConnected, text) {
    const indicator = document.getElementById('connection-indicator');
    if (!indicator) return;
    
    indicator.className = isConnected ? 'connected' : 'disconnected';
    indicator.querySelector('.indicator-text').innerText = text;
}

// ── MQTT SUBSCRIBING & PUBLISHING ──
function subscribeToRoom(code) {
    if (!client || !client.connected) return;
    const topic = `nk/78/room/${code}`;
    client.subscribe(topic, (err) => {
        if (!err) {
            console.log(`Subscribed to topic: ${topic}`);
            startHeartbeat();
            // Announce presence here (rather than in joinRoom) so it only fires once
            // the connection is live and the subscription is active — otherwise a join
            // published before connecting is silently dropped and the host's welcome
            // could arrive before we're subscribed to receive it.
            if (myRole === 'guest' && !opponentPresent) {
                publishToRoom({ type: 'join' });
            }
        } else {
            console.error("Subscription error:", err);
        }
    });
}

function publishToRoom(payload) {
    if (!client || !client.connected || !roomCode) return;
    const topic = `nk/78/room/${roomCode}`;
    client.publish(topic, JSON.stringify({
        ...payload,
        sender: myId
    }));
}

function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
        publishToRoom({ type: 'heartbeat' });
        // If our join was lost (QoS 0), keep re-announcing until the host welcomes us.
        if (myRole === 'guest' && !opponentPresent) {
            publishToRoom({ type: 'join' });
        }
    }, 5000);
}

// ── LOBBY OPERATIONS ──
function createRoom() {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    roomCode = code;
    myRole = 'host';
    
    document.getElementById('display-room-code').innerText = code;
    document.getElementById('sidebar-room-code').innerText = code;
    
    subscribeToRoom(code);
    switchScreen('waiting-screen');
}

function joinRoom(code) {
    const sanitizedCode = code.trim();
    if (sanitizedCode.length !== 4 || isNaN(sanitizedCode)) {
        showLobbyError("Please enter a valid 4-digit numeric code.");
        return;
    }
    
    roomCode = sanitizedCode;
    myRole = 'guest';
    document.getElementById('sidebar-room-code').innerText = sanitizedCode;
    
    subscribeToRoom(sanitizedCode);
    switchScreen('waiting-screen');
}

// ── MESSAGE ROUTER ──
function handleMqttMessage(topic, message) {
    let payload;
    try {
        payload = JSON.parse(message.toString());
    } catch (e) {
        console.error("Failed to parse incoming payload:", e);
        return;
    }
    
    if (payload.sender === myId) return;
    
    console.log("MQTT Action:", payload.type, payload);
    
    switch (payload.type) {
        case 'join':
            if (myRole === 'host' && !opponentId) {
                // First opponent to join — lock them in and start the match.
                opponentId = payload.sender;
                opponentPresent = true;
                logEvent("Opponent joined the room.");
                publishToRoom({ type: 'welcome' });
                initAuthoritativeGame();
            } else if (myRole === 'host' && payload.sender === opponentId) {
                // Existing opponent re-announced (e.g. their join retried or they
                // reconnected) — re-welcome and resync rather than restarting.
                opponentPresent = true;
                publishToRoom({ type: 'welcome' });
                syncStateToGuest();
            }
            // A stranger joining the same code mid-match is ignored.
            break;
            
        case 'welcome':
            if (myRole === 'guest') {
                opponentId = payload.sender;
                opponentPresent = true;
                logEvent("Connected to Host. Waiting for deck deal.");
                switchScreen('game-screen');
            }
            break;
            
        case 'state_sync':
            if (myRole === 'guest') {
                gameState = payload.state;
                renderGameState();
            }
            break;
            
        case 'declare_trump':
            if (myRole === 'host' && payload.sender === gameState.player1Id) {
                setTrumpSuit(payload.trumpSuit);
            }
            break;
            
        case 'play_card':
            if (myRole === 'host') {
                processPlayedCard(payload.sender, payload.card);
            }
            break;
            
        case 'pull_card':
            if (myRole === 'host') {
                processPullCard(payload.sender, payload.card);
            }
            break;
            
        case 'ready_next_round':
            if (myRole === 'host') {
                setPlayerReadyForNextRound(payload.sender);
            }
            break;
            
        case 'forfeit':
            handleOpponentForfeit();
            break;
            
        case 'heartbeat':
            if (!opponentPresent && opponentId === payload.sender) {
                opponentPresent = true;
            }
            break;
    }
}

// ── HOST GAME CONTROL (AUTHORITATIVE STATE ENGINE) ──
function initAuthoritativeGame() {
    gameState.round = 1;
    gameState.player1Id = myId;
    gameState.player2Id = opponentId;
    
    logEvent("Round 1: Host is Player 1 (target 8), Guest is Player 2 (target 7)");
    startNewRoundDeal();
}

function startNewRoundDeal() {
    gameState.trumpSuit = null;
    gameState.tricks = {
        [gameState.player1Id]: 0,
        [gameState.player2Id]: 0
    };
    gameState.currentTrick = [];
    gameState.lastTrick = [];
    gameState.readyForNextRound = {
        [gameState.player1Id]: false,
        [gameState.player2Id]: false
    };
    
    // Clear table sets during deal phase
    gameState.tableSets = {
        [gameState.player1Id]: [],
        [gameState.player2Id]: []
    };
    
    // 2. Shuffle stripped 30-card deck
    const deck = generateStrippedDeck();
    shuffleDeck(deck);
    
    // 3. Deal first 5 cards to hand of each player
    gameState.playerHands = {
        [gameState.player1Id]: deck.splice(0, 5),
        [gameState.player2Id]: deck.splice(0, 5)
    };
    gameState.deckRemaining = deck; // 20 cards remaining
    
    gameState.roundState = 'CHOOSE_TRUMP';
    
    logEvent("Dealing 5 cards to hands. Waiting for Player 1 to select Trump...");
    syncStateToGuest();
    renderGameState();
}

function setTrumpSuit(suit) {
    if (gameState.roundState !== 'CHOOSE_TRUMP') return;
    if (!SUIT_NAMES[suit]) return;

    gameState.trumpSuit = suit;
    logEvent(`Trump Suit declared: ${SUIT_NAMES[suit]} (${SUIT_SYMBOLS[suit]})`);
    
    // Deal remaining 20 cards on table: 5 sets of 2 for each player
    const deck = gameState.deckRemaining; // 20 cards
    const p1TableCards = deck.splice(0, 10);
    const p2TableCards = deck.splice(0, 10);
    
    gameState.tableSets = {
        [gameState.player1Id]: [],
        [gameState.player2Id]: []
    };
    
    for (let i = 0; i < 5; i++) {
        // Bottom is face-down, Top is face-up
        gameState.tableSets[gameState.player1Id].push({
            bottom: p1TableCards[i],
            top: p1TableCards[i + 5]
        });
        gameState.tableSets[gameState.player2Id].push({
            bottom: p2TableCards[i],
            top: p2TableCards[i + 5]
        });
    }
    
    gameState.deckRemaining = [];
    
    // Sort hand cards
    sortHand(gameState.playerHands[gameState.player1Id]);
    sortHand(gameState.playerHands[gameState.player2Id]);
    
    // Card pulling for this round was resolved at the end of the previous round
    // (before roles swapped), so use those stored identities directly rather than
    // re-deriving from the now-swapped role labels.
    const scorecard = gameState.roundScorecard;
    if (gameState.round > 1 && scorecard && scorecard.pullCount > 0) {
        gameState.roundState = 'PULLING';
        gameState.pullerId = scorecard.pullerId;
        gameState.returnerId = scorecard.returnerId;
        gameState.pullsRemaining = scorecard.pullCount;
        gameState.pulledCard = null;
        gameState.returnedCard = null;
        gameState.pullHistory = [];
        logEvent(`Card pulling phase started. Puller has ${gameState.pullsRemaining} card(s) to pull.`);
    } else {
        gameState.roundState = 'PLAYING';
        gameState.currentTurn = gameState.player1Id;
        logEvent("Game started. Play your cards.");
    }
    
    syncStateToGuest();
    renderGameState();
}

function processPlayedCard(playerId, card) {
    if (gameState.roundState !== 'PLAYING') return;
    if (playerId !== gameState.currentTurn) return;

    // Authoritative validation: the player must actually hold this card, either in
    // hand or as a face-up table card. Guests only run these checks client-side, so
    // enforce them here too — a malformed message can't inject a phantom card.
    const hand = gameState.playerHands[playerId] || [];
    const sets = gameState.tableSets[playerId] || [];
    const cardIndex = hand.findIndex(c => c.suit === card.suit && c.value === card.value);
    const setIdx = sets.findIndex(s => s.top && s.top.suit === card.suit && s.top.value === card.value);
    if (cardIndex === -1 && setIdx === -1) return;

    // Enforce follow-suit authoritatively when responding to a lead.
    if (gameState.currentTrick.length === 1) {
        const leadSuit = gameState.currentTrick[0].card.suit;
        const canFollowInHand = hand.some(c => c.suit === leadSuit);
        const canFollowOnTable = sets.some(s => s.top && s.top.suit === leadSuit);
        if ((canFollowInHand || canFollowOnTable) && card.suit !== leadSuit) return;
    }

    // Add to current trick
    gameState.currentTrick.push({ playerId, card });

    // Remove card from player hand OR table sets
    if (cardIndex !== -1) {
        hand.splice(cardIndex, 1);
    } else {
        const set = sets[setIdx];
        set.top = null;

        // Turn bottom card to face up
        if (set.bottom) {
            set.top = set.bottom;
            set.bottom = null;
        } else {
            // Remove set completely
            sets.splice(setIdx, 1);
        }
    }

    logEvent(`${playerId === gameState.player1Id ? 'Player 1' : 'Player 2'} played ${CARD_RANKS[card.value]} of ${SUIT_NAMES[card.suit]} ${SUIT_SYMBOLS[card.suit]}`);
    
    if (gameState.currentTrick.length === 2) {
        const trickWinnerId = evaluateTrickWinner(gameState.currentTrick, gameState.trumpSuit);
        gameState.tricks[trickWinnerId]++;
        
        logEvent(`Set won by ${trickWinnerId === gameState.player1Id ? 'Player 1' : 'Player 2'}`);
        
        gameState.currentTurn = trickWinnerId;
        
        syncStateToGuest();
        renderGameState();
        
        setTimeout(() => {
            if (myRole !== 'host') return;
            
            gameState.lastTrick = [...gameState.currentTrick];
            gameState.currentTrick = [];
            
            // Check if game complete (both hand and table sets are empty)
            const p1Hand = gameState.playerHands[gameState.player1Id];
            const p1Sets = gameState.tableSets[gameState.player1Id] || [];
            
            if (p1Hand.length === 0 && p1Sets.length === 0) {
                endRoundScoreCalculation();
            }
            
            syncStateToGuest();
            renderGameState();
        }, 1500);
        
    } else {
        gameState.currentTurn = (playerId === gameState.player1Id) ? gameState.player2Id : gameState.player1Id;
        syncStateToGuest();
        renderGameState();
    }
}

function processPullCard(senderId, card) {
    if (gameState.roundState !== 'PULLING') return;
    if (senderId !== gameState.pullerId) return;
    
    const returnerId = gameState.returnerId;
    const returnerHand = gameState.playerHands[returnerId];
    
    // Check if returner has cards of this suit
    const matchingSuitCards = returnerHand.filter(c => c.suit === card.suit);
    
    if (matchingSuitCards.length === 0) {
        logEvent(`Pull failed: Opponent has no cards of suit ${SUIT_NAMES[card.suit]}. Choose another card.`);
        gameState.pullAlert = {
            targetId: gameState.pullerId,
            message: `Opponent has no cards of ${SUIT_NAMES[card.suit]}. Please select a card of a different suit.`
        };
        syncStateToGuest();
        renderGameState();
        gameState.pullAlert = null;
        return;
    }
    
    // Find highest card of this suit in returner hand
    let highestCard = matchingSuitCards[0];
    for (let c of matchingSuitCards) {
        if (c.value > highestCard.value) {
            highestCard = c;
        }
    }
    
    // Execute swap
    const pullerHand = gameState.playerHands[gameState.pullerId];
    const offeredIdx = pullerHand.findIndex(c => c.suit === card.suit && c.value === card.value);
    if (offeredIdx !== -1) {
        pullerHand.splice(offeredIdx, 1);
    }
    
    const highestIdx = returnerHand.findIndex(c => c.suit === highestCard.suit && c.value === highestCard.value);
    if (highestIdx !== -1) {
        returnerHand.splice(highestIdx, 1);
    }
    
    pullerHand.push(highestCard);
    returnerHand.push(card);
    
    sortHand(pullerHand);
    sortHand(returnerHand);
    
    logEvent(`Pulled card: Sent ${CARD_RANKS[card.value]} of ${SUIT_NAMES[card.suit]} -> Received ${CARD_RANKS[highestCard.value]} of ${SUIT_NAMES[highestCard.suit]}`);
    
    gameState.pullsRemaining--;
    gameState.pulledCard = card;
    gameState.returnedCard = highestCard;
    
    if (gameState.pullsRemaining === 0) {
        setTimeout(() => {
            if (myRole !== 'host') return;
            gameState.roundState = 'PLAYING';
            gameState.currentTurn = gameState.player1Id;
            logEvent("Card pulling complete. Game starting!");
            syncStateToGuest();
            renderGameState();
        }, 2000);
    } else {
        syncStateToGuest();
        renderGameState();
    }
}

function endRoundScoreCalculation() {
    gameState.roundState = 'ROUND_OVER';
    
    const p1Tricks = gameState.tricks[gameState.player1Id];
    const p2Tricks = gameState.tricks[gameState.player2Id];
    
    const p1Diff = p1Tricks - 8;
    const p2Diff = p2Tricks - 7;
    
    gameState.roundScorecard = {
        p1Tricks,
        p2Tricks,
        p1Diff,
        p2Diff,
        pullerId: null,
        returnerId: null,
        pullCount: 0
    };

    // Resolve who pulls next round NOW, while player1Id/player2Id still refer to the
    // round that just ended (roles are swapped before the next deal). The player who
    // exceeded their target pulls one card per surplus trick from the one who fell
    // short. Totals always sum to 15 (=8+7), so at most one side has a deficit.
    const p1Deficit = 8 - p1Tricks;
    const p2Deficit = 7 - p2Tricks;
    if (p1Deficit > 0) {
        gameState.roundScorecard.pullerId = gameState.player2Id;
        gameState.roundScorecard.returnerId = gameState.player1Id;
        gameState.roundScorecard.pullCount = p1Deficit;
    } else if (p2Deficit > 0) {
        gameState.roundScorecard.pullerId = gameState.player1Id;
        gameState.roundScorecard.returnerId = gameState.player2Id;
        gameState.roundScorecard.pullCount = p2Deficit;
    }

    logEvent(`Round Over! Scores - Player 1: ${p1Tricks} (diff ${p1Diff}), Player 2: ${p2Tricks} (diff ${p2Diff})`);
}

function setPlayerReadyForNextRound(playerId) {
    if (gameState.roundState !== 'ROUND_OVER') return;
    
    gameState.readyForNextRound[playerId] = true;
    
    if (gameState.readyForNextRound[gameState.player1Id] && gameState.readyForNextRound[gameState.player2Id]) {
        gameState.round++;
        
        const tempP1 = gameState.player1Id;
        gameState.player1Id = gameState.player2Id;
        gameState.player2Id = tempP1;
        
        logEvent(`Starting Round ${gameState.round}. Roles Swapped!`);
        startNewRoundDeal();
    } else {
        syncStateToGuest();
        renderGameState();
    }
}

function syncStateToGuest() {
    if (myRole !== 'host') return;
    publishToRoom({
        type: 'state_sync',
        state: gameState
    });
}

// ── LOCAL PLAYER INTERACTIONS ──
function initUIEvents() {
    document.getElementById('create-room-btn').addEventListener('click', createRoom);
    document.getElementById('join-room-btn').addEventListener('click', () => {
        const code = document.getElementById('join-code-input').value;
        joinRoom(code);
    });
    
    document.getElementById('copy-code-btn').addEventListener('click', copyInviteLink);
    document.getElementById('leave-waiting-btn').addEventListener('click', returnToLobby);
    document.getElementById('forfeit-btn').addEventListener('click', forfeitMatch);

    // Sidebar toggle
    document.getElementById('sidebar-toggle-btn').addEventListener('click', () => {
        const sidebar = document.getElementById('game-sidebar');
        sidebar.classList.toggle('open');
    });

    
    const trumpButtons = document.querySelectorAll('.trump-btn');
    trumpButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const suit = btn.getAttribute('data-suit');
            selectTrumpLocal(suit);
        });
    });
    
    document.getElementById('next-round-btn').addEventListener('click', readyForNextRoundLocal);
    document.getElementById('exit-game-btn').addEventListener('click', returnToLobby);
    
    document.getElementById('alert-ok-btn').addEventListener('click', () => {
        document.getElementById('alert-overlay').classList.remove('active');
    });
}

function selectTrumpLocal(suit) {
    if (myRole === 'host') {
        setTrumpSuit(suit);
    } else {
        publishToRoom({
            type: 'declare_trump',
            trumpSuit: suit
        });
    }
    document.getElementById('trump-select-overlay').classList.remove('active');
}

function playCardLocal(cardIndex) {
    if (isAnimatingTrick) return;
    
    const myHand = gameState.playerHands[myId];
    const card = myHand[cardIndex];
    
    if (gameState.roundState === 'PULLING') {
        if (myId !== gameState.pullerId) return;
        if (myRole === 'host') {
            processPullCard(myId, card);
        } else {
            publishToRoom({ type: 'pull_card', card: card });
        }
        return;
    }
    
    if (gameState.roundState !== 'PLAYING') return;
    if (myId !== gameState.currentTurn) return;
    
    // Validation: follow suit
    if (gameState.currentTrick.length === 1) {
        const leadCard = gameState.currentTrick[0].card;
        const hasLeadInHand = myHand.some(c => c.suit === leadCard.suit);
        const hasLeadOnTable = (gameState.tableSets[myId] || []).some(s => s.top && s.top.suit === leadCard.suit);
        
        if ((hasLeadInHand || hasLeadOnTable) && card.suit !== leadCard.suit) {
            showAlert("Invalid Move", `You must follow suit! Play a ${SUIT_NAMES[leadCard.suit]} card.`);
            return;
        }
    }
    
    animateLocalCardPlay(cardIndex);
    
    setTimeout(() => {
        if (myRole === 'host') {
            processPlayedCard(myId, card);
        } else {
            publishToRoom({ type: 'play_card', card: card });
        }
    }, 300);
}

function playTableCardLocal(setIndex) {
    if (isAnimatingTrick) return;
    if (gameState.roundState !== 'PLAYING') return;
    if (myId !== gameState.currentTurn) return;
    
    const mySets = gameState.tableSets[myId] || [];
    const set = mySets[setIndex];
    if (!set || !set.top) return;
    
    const card = set.top;
    const myHand = gameState.playerHands[myId] || [];
    
    // Validation: follow suit
    if (gameState.currentTrick.length === 1) {
        const leadCard = gameState.currentTrick[0].card;
        const hasLeadInHand = myHand.some(c => c.suit === leadCard.suit);
        const hasLeadOnTable = mySets.some(s => s.top && s.top.suit === leadCard.suit);
        
        if ((hasLeadInHand || hasLeadOnTable) && card.suit !== leadCard.suit) {
            showAlert("Invalid Move", `You must follow suit! Play a ${SUIT_NAMES[leadCard.suit]} card.`);
            return;
        }
    }
    
    // For visual table plays, trigger brief opacity flash or drop animation before sending
    if (myRole === 'host') {
        processPlayedCard(myId, card);
    } else {
        publishToRoom({ type: 'play_card', card: card });
    }
}

function readyForNextRoundLocal() {
    document.getElementById('next-round-btn').disabled = true;
    document.getElementById('next-round-status').style.display = 'block';
    
    if (myRole === 'host') {
        setPlayerReadyForNextRound(myId);
    } else {
        publishToRoom({ type: 'ready_next_round' });
    }
}

function forfeitMatch() {
    if (confirm("Are you sure you want to forfeit?")) {
        publishToRoom({ type: 'forfeit' });
        returnToLobby();
    }
}

function handleOpponentForfeit() {
    showAlert("Opponent Left", "Opponent left the match. Returning to lobby.");
    returnToLobby();
}

function returnToLobby() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (client && client.connected && roomCode) {
        client.unsubscribe(`nk/78/room/${roomCode}`);
    }
    roomCode = null;
    opponentId = null;
    opponentPresent = false;
    
    document.getElementById('join-code-input').value = '';
    switchScreen('lobby-screen');
    window.history.pushState({}, document.title, window.location.pathname);
}

// ── RENDER ENGINE ──
function renderGameState() {
    if (!roomCode) return;
    
    const isP1 = (myId === gameState.player1Id);
    const myTricksCount = gameState.tricks[myId] || 0;
    const oppTricksCount = gameState.tricks[opponentId] || 0;
    
    if (gameState.roundState !== 'LOBBY' && document.getElementById('waiting-screen').classList.contains('active')) {
        switchScreen('game-screen');
    }
    
    if (gameState.pullAlert && gameState.pullAlert.targetId === myId) {
        showAlert("Pull Failed", gameState.pullAlert.message);
    }
    
    const myTarget = isP1 ? 8 : 7;
    const oppTarget = isP1 ? 7 : 8;
    
    document.getElementById('player-role-tag').innerText = `${isP1 ? 'Trump Maker' : 'Dealer'} (Target: ${myTarget})`;
    document.getElementById('player-tricks').innerText = `${myTricksCount} / ${myTarget}`;
    
    document.getElementById('opponent-role-tag').innerText = `${!isP1 ? 'Trump Maker' : 'Dealer'} (Target: ${oppTarget})`;
    document.getElementById('opponent-tricks').innerText = `${oppTricksCount} / ${oppTarget}`;
    
    document.getElementById('current-round-val').innerText = gameState.round;
    document.getElementById('current-trump-val').className = `ind-value ${gameState.trumpSuit ? getSuitColorClass(gameState.trumpSuit) : ''}`;
    document.getElementById('current-trump-val').innerText = gameState.trumpSuit ? `${SUIT_SYMBOLS[gameState.trumpSuit]} ${SUIT_NAMES[gameState.trumpSuit]}` : 'Declaring...';
    
    updateGameBannersAndTurnInfo();
    
    // Render Hand of Cards (up to 5 cards)
    const myHand = gameState.playerHands[myId] || [];
    renderPlayerHand(myHand);
    
    // Render Opponent Hand Backs
    const oppHandSize = (gameState.playerHands[opponentId] || []).length;
    renderOpponentHandPreview(oppHandSize);
    
    // Render Table Card Sets
    renderTableSets();
    
    // Render Played cards on the Play Mat
    renderPlayedCardsOnMat();
    
    handleModalsState();
}

function renderPlayerHand(hand) {
    const container = document.getElementById('player-hand');
    container.innerHTML = '';
    
    const totalCards = hand.length;
    hand.forEach((card, idx) => {
        const cardEl = createCardElement(card);
        cardEl.style.setProperty('--card-index', idx);
        cardEl.style.setProperty('--card-total', totalCards);
        
        const myTurn = (myId === gameState.currentTurn && gameState.roundState === 'PLAYING');
        const pullingTurn = (myId === gameState.pullerId && gameState.roundState === 'PULLING');
        
        if (!myTurn && !pullingTurn) {
            // Not your turn: keep the card fanned and fully visible (just not the active
            // playable state) rather than dimming/collapsing it.
            cardEl.classList.add('not-turn');
        } else if (myTurn && gameState.currentTrick.length === 1) {
            const leadCard = gameState.currentTrick[0].card;
            const hasLeadInHand = hand.some(c => c.suit === leadCard.suit);
            const hasLeadOnTable = (gameState.tableSets[myId] || []).some(s => s.top && s.top.suit === leadCard.suit);
            
            if ((hasLeadInHand || hasLeadOnTable) && card.suit !== leadCard.suit) {
                cardEl.classList.add('disabled');
            }
        }
        
        cardEl.addEventListener('click', () => playCardLocal(idx));
        container.appendChild(cardEl);
    });
}

function renderOpponentHandPreview(count) {
    const container = document.getElementById('opponent-hand-preview');
    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
        const back = document.createElement('div');
        back.className = 'card-back-mini';
        container.appendChild(back);
    }
}

function renderTableSets() {
    const myTableSets = gameState.tableSets[myId] || [];
    const oppTableSets = gameState.tableSets[opponentId] || [];
    
    const myContainer = document.getElementById('player-table-sets');
    const oppContainer = document.getElementById('opponent-table-sets');
    
    myContainer.innerHTML = '';
    oppContainer.innerHTML = '';
    
    // Render My Sets
    myTableSets.forEach((set, idx) => {
        const setEl = document.createElement('div');
        setEl.className = 'table-card-set';
        
        if (set.bottom) {
            const bottomEl = document.createElement('div');
            bottomEl.className = 'playing-card card-back bottom-card';
            bottomEl.innerHTML = '<div class="card-back-pattern">7-8</div>';
            setEl.appendChild(bottomEl);
        }
        
        if (set.top) {
            const topEl = createCardElement(set.top);
            topEl.classList.add('top-card');
            
            topEl.addEventListener('click', () => playTableCardLocal(idx));
            
            const myTurn = (myId === gameState.currentTurn && gameState.roundState === 'PLAYING');
            if (!myTurn) {
                topEl.classList.add('disabled');
            } else if (gameState.currentTrick.length === 1) {
                const leadCard = gameState.currentTrick[0].card;
                const hasLeadInHand = (gameState.playerHands[myId] || []).some(c => c.suit === leadCard.suit);
                const hasLeadOnTable = myTableSets.some(s => s.top && s.top.suit === leadCard.suit);
                
                if ((hasLeadInHand || hasLeadOnTable) && set.top.suit !== leadCard.suit) {
                    topEl.classList.add('disabled');
                }
            }
            setEl.appendChild(topEl);
        }
        myContainer.appendChild(setEl);
    });
    
    // Render Opponent Sets
    oppTableSets.forEach((set, idx) => {
        const setEl = document.createElement('div');
        setEl.className = 'table-card-set';
        
        if (set.bottom) {
            const bottomEl = document.createElement('div');
            bottomEl.className = 'playing-card card-back bottom-card';
            bottomEl.innerHTML = '<div class="card-back-pattern">7-8</div>';
            setEl.appendChild(bottomEl);
        }
        
        if (set.top) {
            const topEl = createCardElement(set.top);
            topEl.classList.add('top-card');
            topEl.classList.add('disabled'); // Cannot play opponent table cards
            setEl.appendChild(topEl);
        }
        oppContainer.appendChild(setEl);
    });
}

function renderPlayedCardsOnMat() {
    const oppSpot = document.getElementById('mat-opponent-card-spot');
    const mySpot = document.getElementById('mat-player-card-spot');
    
    oppSpot.innerHTML = '';
    mySpot.innerHTML = '';
    
    const trick = gameState.currentTrick || [];
    
    trick.forEach(play => {
        const cardEl = createCardElement(play.card);
        cardEl.classList.add(play.playerId === myId ? 'player-played-card' : 'opponent-played-card');
        
        if (play.playerId === myId) {
            mySpot.appendChild(cardEl);
        } else {
            oppSpot.appendChild(cardEl);
        }
    });
    
    const matWinner = document.getElementById('mat-winner-highlight');
    if (trick.length === 2) {
        const trickWinner = evaluateTrickWinner(trick, gameState.trumpSuit);
        matWinner.classList.remove('hidden');
        matWinner.innerText = `${trickWinner === myId ? 'You' : 'Opponent'} won the trick!`;
        isAnimatingTrick = true;
    } else {
        matWinner.classList.add('hidden');
        isAnimatingTrick = false;
    }
}

function handleModalsState() {
    const isP1 = (myId === gameState.player1Id);
    
    // Choose Trump Overlay
    const trumpOverlay = document.getElementById('trump-select-overlay');
    if (gameState.roundState === 'CHOOSE_TRUMP' && isP1) {
        trumpOverlay.classList.add('active');
        const previewContainer = document.getElementById('trump-deal-preview');
        previewContainer.innerHTML = '';
        const myHand = gameState.playerHands[myId] || [];
        myHand.forEach(card => {
            const cardEl = createCardElement(card);
            previewContainer.appendChild(cardEl);
        });
    } else {
        trumpOverlay.classList.remove('active');
    }
    
    // Scoreboard Overlay
    const roundOverlay = document.getElementById('round-over-overlay');
    if (gameState.roundState === 'ROUND_OVER') {
        roundOverlay.classList.add('active');
        
        const card = gameState.roundScorecard;
        const isMeP1 = (myId === gameState.player1Id);
        
        const p1Name = isMeP1 ? 'You' : 'Opponent';
        const p2Name = !isMeP1 ? 'You' : 'Opponent';
        
        document.getElementById('scoreboard-p1-name').innerText = p1Name;
        document.getElementById('scoreboard-p2-name').innerText = p2Name;
        
        document.getElementById('scoreboard-p1-won').innerText = card.p1Tricks;
        document.getElementById('scoreboard-p2-won').innerText = card.p2Tricks;
        
        // Calculate Debt: target - tricksWon
        const p1Debt = 8 - card.p1Tricks;
        const p2Debt = 7 - card.p2Tricks;
        
        const p1DiffEl = document.getElementById('scoreboard-p1-diff');
        const p2DiffEl = document.getElementById('scoreboard-p2-diff');
        
        // Render Player 1 Debt/Score
        if (p1Debt > 0) {
            p1DiffEl.innerText = `Debt: ${p1Debt} Sets`;
            p1DiffEl.className = 'score-diff minus';
        } else {
            p1DiffEl.innerText = p1Debt === 0 ? 'Target Met' : `Surplus: +${-p1Debt}`;
            p1DiffEl.className = 'score-diff plus';
        }
        
        // Render Player 2 Debt/Score
        if (p2Debt > 0) {
            p2DiffEl.innerText = `Debt: ${p2Debt} Sets`;
            p2DiffEl.className = 'score-diff minus';
        } else {
            p2DiffEl.innerText = p2Debt === 0 ? 'Target Met' : `Surplus: +${-p2Debt}`;
            p2DiffEl.className = 'score-diff plus';
        }
        
        // Pull Summary details
        const summaryMsg = document.getElementById('pulling-summary-msg');
        if (p1Debt > 0) {
            summaryMsg.innerText = `${p2Name} won surplus sets. Next round, ${p2Name} will pull ${p1Debt} card(s) from ${p1Name}.`;
        } else if (p2Debt > 0) {
            summaryMsg.innerText = `${p1Name} won surplus sets. Next round, ${p1Name} will pull ${p2Debt} card(s) from ${p2Name}.`;
        } else {
            summaryMsg.innerText = `Targets met exactly! No cards will be pulled next round.`;
        }
        
        const myReady = gameState.readyForNextRound[myId];
        document.getElementById('next-round-btn').disabled = myReady;
        document.getElementById('next-round-status').style.display = myReady ? 'block' : 'none';
        
    } else {
        roundOverlay.classList.remove('active');
    }
    
    // Pull Overlay
    const pullingOverlay = document.getElementById('card-pulling-overlay');
    if (gameState.roundState === 'PULLING') {
        pullingOverlay.classList.add('active');
        
        document.getElementById('pulling-title').innerText = `Card Exchange Phase (${gameState.pullsRemaining} Left)`;
        
        const instructions = document.getElementById('pulling-instructions');
        const pullingAction = document.getElementById('pulling-action-container');
        
        const pullerSpot = document.getElementById('puller-card-spot');
        const returnerSpot = document.getElementById('returner-card-spot');
        
        pullerSpot.innerHTML = '';
        returnerSpot.innerHTML = '';
        
        if (gameState.pulledCard) {
            pullerSpot.appendChild(createCardElement(gameState.pulledCard));
        } else {
            pullerSpot.innerHTML = '<span class="spot-label">Pulled card offered</span>';
        }
        
        if (gameState.returnedCard) {
            returnerSpot.appendChild(createCardElement(gameState.returnedCard));
        } else {
            returnerSpot.innerHTML = '<span class="spot-label">Opponent returned card</span>';
        }
        
        if (myId === gameState.pullerId) {
            instructions.innerHTML = `<span class="pull-instruction-highlight">It is your turn to steal!</span> Offer a low card from your hand. Opponent must return their highest card of that suit.`;
            pullingAction.innerText = "Select a card to play from your hand...";
        } else {
            instructions.innerHTML = `Waiting for <span class="pull-instruction-highlight">Opponent</span> to select a card to pull from your hand...`;
            pullingAction.innerText = "The game will automatically return your highest card of that suit.";
        }
    } else {
        pullingOverlay.classList.remove('active');
    }
}

function updateGameBannersAndTurnInfo() {
    const banner = document.getElementById('mat-banner');
    
    if (gameState.roundState === 'CHOOSE_TRUMP') {
        const selectorName = (gameState.player1Id === myId) ? 'You' : 'Opponent';
        banner.innerText = `Waiting for ${selectorName} to choose Trump suit...`;
        banner.className = `mat-banner-info ${gameState.player1Id === myId ? 'active' : ''}`;
        return;
    }
    
    if (gameState.roundState === 'PLAYING') {
        const isMyTurn = (myId === gameState.currentTurn);
        banner.innerText = isMyTurn ? "Your Turn! Play a card." : "Opponent's turn to play...";
        banner.className = `mat-banner-info ${isMyTurn ? 'active' : ''}`;
        return;
    }
    
    if (gameState.roundState === 'PULLING') {
        const isMyPull = (myId === gameState.pullerId);
        banner.innerText = isMyPull ? "Card Exchanging: Offer card" : "Card Exchanging: Waiting for offer";
        banner.className = `mat-banner-info ${isMyPull ? 'active' : ''}`;
        return;
    }
    
    banner.innerText = "Welcome to Saat Aath!";
    banner.className = 'mat-banner-info';
}

function animateLocalCardPlay(cardIndex) {
    const container = document.getElementById('player-hand');
    const cards = container.querySelectorAll('.playing-card');
    if (cards[cardIndex]) {
        cards[cardIndex].classList.add('selected-to-play');
    }
}

// Helper to create card components
function createCardElement(card) {
    const el = document.createElement('div');
    const suitColor = (card.suit === 'H' || card.suit === 'D') ? 'red' : 'black';
    el.className = `playing-card ${suitColor}`;
    
    const suitSym = SUIT_SYMBOLS[card.suit];
    const valName = CARD_RANKS[card.value];
    
    el.innerHTML = `
        <div class="card-top">
            <span class="card-value">${valName}</span>
            <span class="card-suit">${suitSym}</span>
        </div>
        <div class="card-center">${suitSym}</div>
        <div class="card-bottom">
            <span class="card-value">${valName}</span>
            <span class="card-suit">${suitSym}</span>
        </div>
    `;
    return el;
}

function getSuitColorClass(suit) {
    return (suit === 'H' || suit === 'D') ? 'red' : 'black';
}

// ── DECK GENERATION & HELPERS ──
function generateStrippedDeck() {
    const deck = [];
    ['S', 'H'].forEach(suit => {
        for (let v = 7; v <= 14; v++) {
            deck.push({ suit, value: v });
        }
    });
    ['D', 'C'].forEach(suit => {
        for (let v = 8; v <= 14; v++) {
            deck.push({ suit, value: v });
        }
    });
    return deck;
}

function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
}

function sortHand(hand) {
    const suitOrder = { 'S': 0, 'H': 1, 'D': 2, 'C': 3 };
    hand.sort((a, b) => {
        if (suitOrder[a.suit] !== suitOrder[b.suit]) {
            return suitOrder[a.suit] - suitOrder[b.suit];
        }
        return a.value - b.value;
    });
}

function evaluateTrickWinner(trick, trumpSuit) {
    const card1 = trick[0].card;
    const card2 = trick[1].card;
    
    const leadSuit = card1.suit;
    const is1Trump = (card1.suit === trumpSuit);
    const is2Trump = (card2.suit === trumpSuit);
    
    if (is1Trump && !is2Trump) {
        return trick[0].playerId;
    }
    if (!is1Trump && is2Trump) {
        return trick[1].playerId;
    }
    if (is1Trump && is2Trump) {
        return (card1.value > card2.value) ? trick[0].playerId : trick[1].playerId;
    }
    
    if (card2.suit === leadSuit) {
        return (card1.value > card2.value) ? trick[0].playerId : trick[1].playerId;
    } else {
        return trick[0].playerId;
    }
}

// ── LOGGING & UTILS ──
function logEvent(msg) {
    const consoleBox = document.getElementById('log-console');
    if (!consoleBox) return;
    
    const entry = document.createElement('div');
    entry.className = 'log-entry system';
    entry.innerText = msg;
    consoleBox.appendChild(entry);
    consoleBox.scrollTop = consoleBox.scrollHeight;
    
    if (myRole === 'host') {
        gameState.history.push(msg);
        if (gameState.history.length > 50) {
            gameState.history.shift();
        }
    }
}

function switchScreen(screenId) {
    const screens = document.querySelectorAll('.screen');
    screens.forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

function showLobbyError(msg) {
    const err = document.getElementById('lobby-error');
    err.innerText = msg;
    setTimeout(() => {
        err.innerText = '';
    }, 4000);
}

function showAlert(title, msg) {
    document.getElementById('alert-title').innerText = title;
    document.getElementById('alert-message').innerText = msg;
    document.getElementById('alert-overlay').classList.add('active');
}

function copyInviteLink() {
    const shareUrl = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
    navigator.clipboard.writeText(shareUrl).then(() => {
        const toast = document.getElementById('copy-toast');
        toast.classList.add('show');
        setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }).catch(err => {
        console.error("Failed to copy link:", err);
    });
}
