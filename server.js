require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { randomInt } = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.disable('x-powered-by');
app.set('trust proxy', 1);
const JSON_LIMIT = process.env.JSON_LIMIT || '100kb';
app.use(express.json({ limit: JSON_LIMIT }));
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN;
const corsOptions = ALLOWED_ORIGIN ? { origin: ALLOWED_ORIGIN } : { origin: true };
app.use(cors(corsOptions));
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(express.static(path.join(__dirname, 'public')));

// Simple in-memory rate limiter for API endpoints
const RATE_WINDOW_MS = parseInt(process.env.RATE_WINDOW_MS || '60000', 10);
const RATE_MAX = parseInt(process.env.RATE_MAX || '120', 10);
const rateBuckets = new Map();
function rateLimit(req, res, next) {
    const now = Date.now();
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    let bucket = rateBuckets.get(ip);
    if (!bucket || now - bucket.start > RATE_WINDOW_MS) {
        bucket = { start: now, count: 0 };
    }
    bucket.count += 1;
    rateBuckets.set(ip, bucket);
    if (bucket.count > RATE_MAX) {
        return res.status(429).json({ error: 'Too Many Requests' });
    }
    next();
}
app.use('/api', rateLimit);

// Database Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/chromex';

const DB_USER = process.env.DB_USER;
const DB_PASS = process.env.DB_PASS;

const connOptions = {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
};
if (DB_USER && DB_PASS) {
    connOptions.user = DB_USER;
    connOptions.pass = DB_PASS;
}

if (process.env.NODE_ENV === 'production' && !process.env.MONGODB_URI) {
    console.error('Missing MONGODB_URI in production. Refusing to start.');
    process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
    mongoose.set('autoIndex', false);
}

mongoose.connect(MONGODB_URI, connOptions)
    .then(() => {
        if (process.env.NODE_ENV !== 'production') console.log('MongoDB Connected');
        startGameLoop();
    })
    .catch(err => {
        console.error('MongoDB Connection Error:', err);
        process.exit(1);
    });

// --- Schemas & Models ---

const MODES = {
    '30s': 30,
    '1min': 60,
    '3min': 180,
    '5min': 300
};

const RoundSchema = new mongoose.Schema({
    mode: { type: String, required: true, enum: Object.keys(MODES) },
    period: { type: String, required: true },
    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },
    status: { type: String, enum: ['open', 'locked', 'settled'], default: 'open' },
    result: {
        number: Number,
        color: String,
        size: String
    }
});
RoundSchema.index({ mode: 1, startTime: -1 });

const BetSchema = new mongoose.Schema({
    roundId: { type: mongoose.Schema.Types.ObjectId, ref: 'Round', required: true },
    period: { type: String, required: true },
    mode: { type: String, required: true },
    betType: { type: String, required: true, enum: ['color', 'number', 'size'] },
    betValue: { type: String, required: true },
    amount: { type: Number, required: true, min: 10 },
    multiplier: { type: Number, default: 1 },
    totalAmount: { type: Number, required: true },
    result: { type: String, enum: ['pending', 'win', 'lose'], default: 'pending' },
    payout: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});

const Round = mongoose.model('Round', RoundSchema);
const Bet = mongoose.model('Bet', BetSchema);

// --- Game Logic ---

function generatePeriod(mode, time) {
    const date = new Date(time);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');

    // Calculate total minutes/periods since start of day
    const startOfDay = new Date(date).setHours(0, 0, 0, 0);
    const diff = date.getTime() - startOfDay;
    const modeSeconds = MODES[mode];
    // Period number = (elapsed seconds / mode seconds) + 1
    const periodNum = Math.floor(diff / 1000 / modeSeconds) + 1;

    // Format: YYYYMMDD + ModeDuration + RoundNumber (4 digits)
    // Example: 20240218300123 (30s mode, 123rd round)
    return `${yyyy}${mm}${dd}${modeSeconds}${String(periodNum).padStart(4, '0')}`;
}

async function createNewRound(mode) {
    const duration = MODES[mode];
    const now = new Date();

    // Align start time to the grid (e.g., 10:00:00, 10:00:30)
    // This prevents drift and ensures synchronization
    const modeMs = duration * 1000;
    const startTime = new Date(Math.floor(now.getTime() / modeMs) * modeMs);
    // If aligned start time is in the past, use next slot? 
    // Usually we want the *current* slot even if partially elapsed, 
    // unless it's almost over.
    // Let's just start a fresh round from NOW for simplicity in this fix, 
    // but ideally aligned. 
    // Aligned is better for "Period" calculation consistency.

    // Check if a round for this aligned time already exists
    // If so, maybe we are recovering from a crash?

    let nextStart = startTime;
    if (startTime.getTime() + modeMs <= now.getTime()) {
        // We are behind, start next slot
        nextStart = new Date(startTime.getTime() + modeMs);
    }

    // For simplicity in this fix, let's just start from NOW if no active round.
    // But to keep period consistent, we use aligned time.

    const endTime = new Date(nextStart.getTime() + modeMs);
    const period = generatePeriod(mode, nextStart);

    try {
        // Ensure no overlap
        const existing = await Round.findOne({ mode, period });
        if (existing) {
            // If exists and not settled, it's fine. If settled, make next.
            if (existing.status === 'settled') {
                // Recursively try next period? Or just log and wait for loop?
                return;
            }
            return;
        }

        const round = new Round({
            mode,
            period,
            startTime: nextStart,
            endTime,
            status: 'open'
        });
        await round.save();
        if (process.env.NODE_ENV !== 'production') {
            console.log(`[${mode}] New Round ${period} started. Ends: ${endTime.toLocaleTimeString()}`);
        }
    } catch (err) {
        console.error(`[${mode}] Error creating round:`, err.message);
    }
}

async function settleRound(round) {
    const number = randomInt(0, 10);
    let color;
    if (number === 0) color = 'red_violet';
    else if (number === 5) color = 'green_violet';
    else if ([1, 3, 7, 9].includes(number)) color = 'green';
    else color = 'red';

    const size = number >= 5 ? 'big' : 'small';

    round.result = { number, color, size };
    round.status = 'settled';
    await round.save();

    if (process.env.NODE_ENV !== 'production') {
        console.log(`[${round.mode}] Round ${round.period} settled: ${number} (${color}, ${size})`);
    }

    // Create next round immediately
    await createNewRound(round.mode);
}

function startGameLoop() {
    // Initialize rounds on start
    Object.keys(MODES).forEach(mode => createNewRound(mode));

    setInterval(async () => {
        const promises = Object.keys(MODES).map(async (mode) => {
            try {
                // Find the latest round for this mode
                let round = await Round.findOne({ mode }).sort({ startTime: -1 });

                if (!round) {
                    await createNewRound(mode);
                    return;
                }

                if (round.status === 'settled') {
                    // Should have created next round in settleRound, but if not:
                    await createNewRound(mode);
                    return;
                }

                const now = new Date();
                const timeLeft = (round.endTime - now) / 1000;

                // Lock the round if 5 seconds or less remaining
                if (timeLeft <= 5 && round.status === 'open') {
                    round.status = 'locked';
                    await round.save();
                }
                // Settle the round if time is up
                else if (timeLeft <= 0 && round.status !== 'settled') {
                    await settleRound(round);
                }
            } catch (err) {
                console.error(`[${mode}] Error in game loop:`, err);
            }
        });

        await Promise.all(promises);
    }, 1000);
}

// --- API Routes ---

// GET /api/game/status
app.get('/api/game/status', async (req, res) => {
    try {
        const statusData = {};
        const modes = Object.keys(MODES);

        await Promise.all(modes.map(async (mode) => {
            const currentRound = await Round.findOne({ mode }).sort({ startTime: -1 }).lean();
            const last5 = await Round.find({ mode, status: 'settled' })
                .sort({ startTime: -1 })
                .limit(5)
                .select('result period')
                .lean();

            if (currentRound) {
                const now = new Date();
                const timeLeft = Math.max(0, Math.ceil((currentRound.endTime - now) / 1000));
                statusData[mode] = {
                    period: currentRound.period,
                    status: currentRound.status,
                    timeLeft,
                    roundId: currentRound._id,
                    results: last5
                };
            }
        }));
        res.json(statusData);
    } catch (err) {
        console.error('Error in /api/game/status:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/game/history/:mode
app.get('/api/game/history/:mode', async (req, res) => {
    try {
        const { mode } = req.params;
        if (!MODES[mode]) return res.status(400).json({ error: 'Invalid mode' });

        const history = await Round.find({ mode, status: 'settled' })
            .sort({ startTime: -1 })
            .limit(20)
            .lean();
        res.json(history);
    } catch (err) {
        console.error('Error in /api/game/history:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/game/bet
app.post('/api/game/bet', async (req, res) => {
    try {
        const { mode, betType, betValue, amount, multiplier } = req.body;

        // Basic Validation
        if (!mode || !betType || !betValue || !amount || !multiplier) {
            return res.status(400).json({ error: 'Missing fields' });
        }
        if (!MODES[mode]) return res.status(400).json({ error: 'Invalid mode' });
        if (amount < 10) return res.status(400).json({ error: 'Minimum bet is 10' });
        // Strict bet validation
        const validColor = ['green', 'red', 'violet'];
        const isValid =
            (betType === 'color' && validColor.includes(String(betValue))) ||
            (betType === 'number' && /^[0-9]$/.test(String(betValue))) ||
            (betType === 'size' && ['big', 'small'].includes(String(betValue)));
        if (!isValid) {
            return res.status(400).json({ error: 'Invalid bet value for bet type' });
        }

        // Find active round
        const round = await Round.findOne({ mode }).sort({ startTime: -1 });
        if (!round || round.status !== 'open') {
            return res.status(400).json({ error: 'Round is not open for betting' });
        }

        // Check time left
        const now = new Date();
        const timeLeft = (round.endTime - now) / 1000;
        if (timeLeft <= 5) {
            return res.status(400).json({ error: 'Betting is closed (Time < 5s)' });
        }

        const totalAmount = amount * multiplier;

        const bet = new Bet({
            roundId: round._id,
            period: round.period,
            mode,
            betType,
            betValue,
            amount,
            multiplier,
            totalAmount
        });

        await bet.save();
        res.json({ success: true, bet });
    } catch (err) {
        console.error('Error in /api/game/bet:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/game/my-bets
app.get('/api/game/my-bets', async (req, res) => {
    try {
        const { mode } = req.query;
        const query = {};
        if (mode) query.mode = mode;

        const bets = await Bet.find(query).sort({ createdAt: -1 }).limit(20);
        res.json(bets);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/health', (req, res) => {
    const db = mongoose.connection.readyState === 1 ? 'connected' : 'not_connected';
    res.json({ status: 'ok', db });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
