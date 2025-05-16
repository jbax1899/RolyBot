/**
 * Stockfish engine integration for async best move calculation.
 * NOTE: On Linux/Mac, ensure the binary is executable (chmod +x stockfish/stockfish-linux).
 */
const { Engine } = require('node-uci');
const path = require('path');

function getStockfishPath() {
    if (process.env.STOCKFISH_PATH) {
        console.log('[Stockfish Path] Using STOCKFISH_PATH env:', process.env.STOCKFISH_PATH);
        return process.env.STOCKFISH_PATH;
    }
    const platform = process.platform;
    let resolvedPath;
    if (platform === 'win32') {
        resolvedPath = path.join(__dirname, '../../stockfish/stockfish-windows/stockfish-windows-x86-64-avx2.exe');
    } else {
        // On Linux/macOS, rely on system PATH
        resolvedPath = 'stockfish';
    }
    console.log(`[Stockfish Path] Platform: ${platform}, Resolved: ${resolvedPath}`);
    return resolvedPath;
}

async function getBestMove(fen, thinkTimeMs) {
    const engine = new Engine(getStockfishPath());
    try {
        await engine.init();
        await engine.isready();
        await engine.position(fen);
        const result = await engine.go({ movetime: thinkTimeMs });
        await engine.quit();
        if (result && result.bestmove) {
            return result.bestmove;
        }
        throw new Error('Stockfish did not return a move');
    } catch (err) {
        try { await engine.quit(); } catch {}
        throw err;
    }
}

module.exports = { getBestMove };