require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(cors());
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(express.static(path.join(__dirname, 'public')));

// Database Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://Sairam:Batman%400712@atlascluster.4jamwll.mongodb.net/chromex?retryWrites=true&w=majority&appName=Cluster0';

// Encode password properly if it contains special characters
// But since the provided string is already encoded (%40), we should trust the ENV VAR first.
// The issue might be that Render injects the ENV VAR literally, so we should ensure we use it.

mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
})
    .then(() => {
        console.log('MongoDB Connected');
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
        console.log(`[${mode}] New Round ${period} started. Ends: ${endTime.toLocaleTimeString()}`);
    } catch (err) {
        console.error(`[${mode}] Error creating round:`, err.message);
    }
}

async function settleRound(round) {
    // Generate Result
    // 0 = Red/Violet, 5 = Green/Violet
    // 1,3,7,9 = Green
    // 2,4,6,8 = Red
    const number = Math.floor(Math.random() * 10);
    let color;
    if (number === 0) color = 'red_violet';
    else if (number === 5) color = 'green_violet';
    else if ([1, 3, 7, 9].includes(number)) color = 'green';
    else color = 'red';

    const size = number >= 5 ? 'big' : 'small';

    round.result = { number, color, size };
    round.status = 'settled';
    await round.save();

    console.log(`[${round.mode}] Round ${round.period} settled: ${number} (${color}, ${size})`);

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
