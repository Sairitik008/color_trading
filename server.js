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
    contentSecurityPolicy: false, // Allow inline scripts/styles for simplicity
}));
app.use(express.static(path.join(__dirname, 'public')));

// Database Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/chromex')
    .then(() => {
        console.log('MongoDB Connected');
        startGameLoop();
    })
    .catch(err => console.error('MongoDB Connection Error:', err));

// ... (Schemas and Models)

// Game Loop
function startGameLoop() {
    // Initialize rounds on start
    Object.keys(MODES).forEach(mode => createNewRound(mode));

    setInterval(async () => {
        for (const mode of Object.keys(MODES)) {
            const round = await Round.findOne({ mode }).sort({ startTime: -1 });
            if (!round) {
                // Initial start
                await createNewRound(mode);
                continue;
            }

            if (round.status === 'settled') continue;

            const now = new Date();
            const timeLeft = (round.endTime - now) / 1000;

            if (timeLeft <= 5 && round.status === 'open') {
                round.status = 'locked';
                await round.save();
                // console.log(`[${mode}] Locked: ${round.period}`);
            } else if (timeLeft <= 0 && round.status !== 'settled') {
                await settleRound(round);
            }
        }
    }, 2000);
}

// API Routes

// GET /api/game/status
app.get('/api/game/status', async (req, res) => {
    try {
        const statusData = {};
        const modes = Object.keys(MODES);

        for (const mode of modes) {
            const currentRound = await Round.findOne({ mode }).sort({ startTime: -1 });
            const last5 = await Round.find({ mode, status: 'settled' })
                .sort({ startTime: -1 })
                .limit(5)
                .select('result period');

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
        }
        res.json(statusData);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/game/history/:mode
app.get('/api/game/history/:mode', async (req, res) => {
    try {
        const { mode } = req.params;
        const history = await Round.find({ mode, status: 'settled' })
            .sort({ startTime: -1 })
            .limit(20);
        res.json(history);
    } catch (err) {
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
    }
});

// GET /api/game/my-bets
app.get('/api/game/my-bets', async (req, res) => {
    try {
        const { mode } = req.query;
        const query = {};
        if (mode) query.mode = mode;

        // In a real app, we would filter by user ID. 
        // Since there is no auth, we return global bets or just the latest ones.
        // However, the prompt implies "my bets". Without auth, we can't distinguish users.
        // We will return the latest 20 bets globally for now, or maybe the client sends a local ID?
        // The prompt says "No auth". "My Bets" implies the client should filter or we return all.
        // Let's return the latest 20 bets generally. The client can filter if it tracks its own bet IDs,
        // or simply show all bets as "My Bets" for this demo since it's a single-player simulation essentially?
        // Actually, "My Bets" implies persistence.
        // Since we don't have user IDs, I'll just return the last 20 bets created.
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
    // Game loop is started after DB connection
});
