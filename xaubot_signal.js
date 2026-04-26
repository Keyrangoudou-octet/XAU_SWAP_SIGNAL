const https = require("https");

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ─────────────────────────────────────────────
//  UTILS
// ─────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on("error", reject);
  });
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    }, res => { res.on("data", () => {}); res.on("end", resolve); });
    req.on("error", reject);
    req.write(data); req.end();
  });
}

function sendTelegram(msg) {
  return post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id: CHAT_ID, text: msg, parse_mode: "Markdown"
  });
}

// ─────────────────────────────────────────────
//  SESSIONS — heure UTC
//  London : 07:00-10:00 UTC
//  New York : 12:30-15:30 UTC
//  XAUUSD évite le weekend et les sessions asiatiques
// ─────────────────────────────────────────────

function getSession() {
  const now = new Date();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const t = h * 60 + m;
  if (t >= 7*60 && t <= 10*60)      return "London 🇬🇧";
  if (t >= 12*60+30 && t <= 15*60+30) return "New York 🇺🇸";
  return null;
}

function isWeekend() {
  const d = new Date().getUTCDay();
  return d === 0 || d === 6;
}

// ─────────────────────────────────────────────
//  INDICATEURS
// ─────────────────────────────────────────────

function calcATR(candles, p = 14) {
  let atr = 0;
  for (let i = 1; i <= p; i++) {
    atr += Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low  - candles[i-1].close)
    );
  }
  atr /= p;
  for (let i = p+1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low  - candles[i-1].close)
    );
    atr = (atr * (p-1) + tr) / p;
  }
  return atr;
}

function calcEMA(vals, p) {
  const k = 2 / (p+1);
  let ema = vals.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for (let i = p; i < vals.length; i++) ema = vals[i]*k + ema*(1-k);
  return ema;
}

// ─────────────────────────────────────────────
//  SWING HIGH / LOW
// ─────────────────────────────────────────────

function getSwings(candles, lookback = 5) {
  const swingHighs = [];
  const swingLows  = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const slice = candles.slice(i - lookback, i + lookback + 1);
    const maxH = Math.max(...slice.map(c => c.high));
    const minL = Math.min(...slice.map(c => c.low));
    if (candles[i].high === maxH) swingHighs.push({ i, price: candles[i].high });
    if (candles[i].low  === minL) swingLows.push({  i, price: candles[i].low  });
  }
  return { swingHighs, swingLows };
}

// ─────────────────────────────────────────────
//  CHoCH — Change of Character
//  Premier signe de retournement avant le BOS
//  Détecté quand le prix casse un swing intermédiaire
//  dans la direction opposée au trend actuel
// ─────────────────────────────────────────────

function detectCHoCH(candles, swings) {
  const last  = candles[candles.length - 1];
  const prev  = candles[candles.length - 2];

  // Prend les 5 derniers swings
  const recentHighs = swings.swingHighs.slice(-5);
  const recentLows  = swings.swingLows.slice(-5);

  // CHoCH BULLISH : dans un downtrend, prix casse un swing high intermédiaire
  // = premier signe que les vendeurs perdent le contrôle
  if (recentHighs.length >= 2) {
    const lastHigh = recentHighs[recentHighs.length - 1];
    const prevHigh = recentHighs[recentHighs.length - 2];
    // Lower highs en cours (downtrend) + close au-dessus du dernier swing high
    if (prevHigh.price > lastHigh.price && last.close > lastHigh.price) {
      return { type: "BULLISH_CHOCH", level: lastHigh.price };
    }
  }

  // CHoCH BEARISH : dans un uptrend, prix casse un swing low intermédiaire
  if (recentLows.length >= 2) {
    const lastLow = recentLows[recentLows.length - 1];
    const prevLow = recentLows[recentLows.length - 2];
    // Higher lows en cours (uptrend) + close en-dessous du dernier swing low
    if (prevLow.price < lastLow.price && last.close < lastLow.price) {
      return { type: "BEARISH_CHOCH", level: lastLow.price };
    }
  }

  return null;
}

// ─────────────────────────────────────────────
//  LIQUIDITY SWEEP
//  Le prix perce un swing pour chasser les stops
//  puis revient — signal de reversal
// ─────────────────────────────────────────────

function detectLiqSweep(candles, swings) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const recentHighs = swings.swingHighs.slice(-4).map(s => s.price);
  const recentLows  = swings.swingLows.slice(-4).map(s => s.price);

  // BULLISH SWEEP : wick sous swing low, close au-dessus
  for (const low of recentLows) {
    if (prev.low < low && prev.close > low && last.close > low) {
      return { type: "BULLISH_SWEEP", sweptLevel: low };
    }
    if (last.low < low && last.close > low) {
      return { type: "BULLISH_SWEEP", sweptLevel: low };
    }
  }

  // BEARISH SWEEP : wick au-dessus swing high, close en-dessous
  for (const high of recentHighs) {
    if (prev.high > high && prev.close < high && last.close < high) {
      return { type: "BEARISH_SWEEP", sweptLevel: high };
    }
    if (last.high > high && last.close < high) {
      return { type: "BEARISH_SWEEP", sweptLevel: high };
    }
  }

  return null;
}

// ─────────────────────────────────────────────
//  BREAK OF STRUCTURE (BOS)
//  Confirmation après le sweep
// ─────────────────────────────────────────────

function detectBOS(candles, swings) {
  const last = candles[candles.length - 1];
  const recentHighs = swings.swingHighs.slice(-3).map(s => s.price);
  const recentLows  = swings.swingLows.slice(-3).map(s => s.price);

  for (const high of recentHighs) {
    if (last.close > high) return { type: "BULLISH_BOS", level: high };
  }
  for (const low of recentLows) {
    if (last.close < low) return { type: "BEARISH_BOS", level: low };
  }
  return null;
}

// ─────────────────────────────────────────────
//  SUPPLY & DEMAND ZONES
//  Zone où le prix a fait un mouvement fort (impulse)
// ─────────────────────────────────────────────

function detectSupplyDemand(candles, atr) {
  const zones = [];
  for (let i = 3; i < candles.length - 1; i++) {
    const body = Math.abs(candles[i].close - candles[i].open);
    // Bougie impulse = corps > 1.5x ATR
    if (body > atr * 1.5) {
      if (candles[i].close > candles[i].open) {
        // Demand zone = base de la bougie haussière
        zones.push({ type: "DEMAND", top: candles[i].open, bottom: candles[i].low, i });
      } else {
        // Supply zone = base de la bougie baissière
        zones.push({ type: "SUPPLY", top: candles[i].high, bottom: candles[i].open, i });
      }
    }
  }
  return zones.slice(-6);
}

// ─────────────────────────────────────────────
//  FIBONACCI GOLDEN ZONE (0.618 - 0.786)
// ─────────────────────────────────────────────

function calcFibonacci(swings) {
  const swingHigh = swings.swingHighs.slice(-1)[0];
  const swingLow  = swings.swingLows.slice(-1)[0];
  if (!swingHigh || !swingLow) return null;

  const range = swingHigh.price - swingLow.price;
  return {
    swingHigh: swingHigh.price,
    swingLow:  swingLow.price,
    f236: parseFloat((swingHigh.price - range * 0.236).toFixed(2)),
    f382: parseFloat((swingHigh.price - range * 0.382).toFixed(2)),
    f500: parseFloat((swingHigh.price - range * 0.5).toFixed(2)),
    f618: parseFloat((swingHigh.price - range * 0.618).toFixed(2)),
    f706: parseFloat((swingHigh.price - range * 0.706).toFixed(2)),
    f786: parseFloat((swingHigh.price - range * 0.786).toFixed(2)),
    // Pour SELL (retracement haussier)
    f618up: parseFloat((swingLow.price + range * 0.618).toFixed(2)),
    f706up: parseFloat((swingLow.price + range * 0.706).toFixed(2)),
    f786up: parseFloat((swingLow.price + range * 0.786).toFixed(2)),
  };
}

function inGoldenZone(price, fib, direction) {
  if (!fib) return false;
  if (direction === "BUY") {
    return price >= fib.f786 && price <= fib.f618;
  } else {
    return price >= fib.f618up && price <= fib.f786up;
  }
}

// ─────────────────────────────────────────────
//  LOGIQUE PRINCIPALE SMC XAUUSD
// ─────────────────────────────────────────────

function analyzeSMC(candles) {
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const atr    = calcATR(candles);
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);

  const swings = getSwings(candles, 5);
  const choch  = detectCHoCH(candles, swings);
  const sweep  = detectLiqSweep(candles, swings);
  const bos    = detectBOS(candles, swings);
  const zones  = detectSupplyDemand(candles, atr);
  const fib    = calcFibonacci(swings);

  const htfBull = ema50 > ema200;

  // Supply/Demand zones proches du prix
  const nearDemand = zones.find(z => z.type === "DEMAND" && price >= z.bottom && price <= z.top + atr);
  const nearSupply = zones.find(z => z.type === "SUPPLY" && price <= z.top && price >= z.bottom - atr);

  // Golden Zone Fibo
  const inGoldenBuy  = inGoldenZone(price, fib, "BUY");
  const inGoldenSell = inGoldenZone(price, fib, "SELL");

  // ── SIGNAL BUY ─────────────────────────────
  // CHoCH bullish + Liq Sweep bullish + BOS bullish
  // + Golden Zone ou Demand Zone
  let buyConf = 0;
  let buyReasons = [];

  if (choch && choch.type === "BULLISH_CHOCH") {
    buyConf++;
    buyReasons.push(`✅ CHoCH haussier à $${choch.level.toFixed(2)}`);
  }
  if (sweep && sweep.type === "BULLISH_SWEEP") {
    buyConf++;
    buyReasons.push(`✅ Liquidity Sweep haussier à $${sweep.sweptLevel.toFixed(2)}`);
  }
  if (bos && bos.type === "BULLISH_BOS") {
    buyConf++;
    buyReasons.push(`✅ BOS haussier confirmé à $${bos.level.toFixed(2)}`);
  }
  if (inGoldenBuy && fib) {
    buyConf++;
    buyReasons.push(`✅ Golden Zone Fibo 0.618-0.786 ($${fib.f786.toFixed(2)} - $${fib.f618.toFixed(2)})`);
  }
  if (nearDemand) {
    buyConf++;
    buyReasons.push(`✅ Demand Zone ($${nearDemand.bottom.toFixed(2)} - $${nearDemand.top.toFixed(2)})`);
  }
  if (htfBull) {
    buyConf++;
    buyReasons.push(`✅ Trend HTF haussier (EMA50 > EMA200)`);
  }

  // ── SIGNAL SELL ────────────────────────────
  let sellConf = 0;
  let sellReasons = [];

  if (choch && choch.type === "BEARISH_CHOCH") {
    sellConf++;
    sellReasons.push(`✅ CHoCH baissier à $${choch.level.toFixed(2)}`);
  }
  if (sweep && sweep.type === "BEARISH_SWEEP") {
    sellConf++;
    sellReasons.push(`✅ Liquidity Sweep baissier à $${sweep.sweptLevel.toFixed(2)}`);
  }
  if (bos && bos.type === "BEARISH_BOS") {
    sellConf++;
    sellReasons.push(`✅ BOS baissier confirmé à $${bos.level.toFixed(2)}`);
  }
  if (inGoldenSell && fib) {
    sellConf++;
    sellReasons.push(`✅ Golden Zone Fibo 0.618-0.786 ($${fib.f618up.toFixed(2)} - $${fib.f786up.toFixed(2)})`);
  }
  if (nearSupply) {
    sellConf++;
    sellReasons.push(`✅ Supply Zone ($${nearSupply.bottom.toFixed(2)} - $${nearSupply.top.toFixed(2)})`);
  }
  if (!htfBull) {
    sellConf++;
    sellReasons.push(`✅ Trend HTF baissier (EMA50 < EMA200)`);
  }

  // Minimum 3 confluences dont obligatoirement Sweep + BOS
  let signal = null;
  let reasons = [];
  let conf = 0;

  const buyValid  = sweep?.type === "BULLISH_SWEEP" && bos?.type === "BULLISH_BOS" && buyConf >= 3;
  const sellValid = sweep?.type === "BEARISH_SWEEP" && bos?.type === "BEARISH_BOS" && sellConf >= 3;

  if (buyValid)       { signal = "BUY";  reasons = buyReasons;  conf = buyConf; }
  else if (sellValid) { signal = "SELL"; reasons = sellReasons; conf = sellConf; }
  else return null;

  // TP / SL — basés sur les niveaux SMC
  let sl, tp1, tp2;
  if (signal === "BUY") {
    // SL : sous le niveau sweepé - buffer ATR x0.3
    sl  = parseFloat((sweep.sweptLevel - atr * 0.3).toFixed(2));
    // TP1 : prochain swing high
    const nextHigh = swings.swingHighs.slice(-1)[0];
    tp1 = nextHigh ? parseFloat(nextHigh.price.toFixed(2)) : parseFloat((price + atr * 2).toFixed(2));
    // TP2 : extension 100% du move (Swing Low → Swing High)
    tp2 = fib ? parseFloat(fib.swingHigh.toFixed(2)) : parseFloat((price + atr * 4).toFixed(2));
  } else {
    // SL : au-dessus du niveau sweepé + buffer ATR x0.3
    sl  = parseFloat((sweep.sweptLevel + atr * 0.3).toFixed(2));
    // TP1 : prochain swing low
    const nextLow = swings.swingLows.slice(-1)[0];
    tp1 = nextLow ? parseFloat(nextLow.price.toFixed(2)) : parseFloat((price - atr * 2).toFixed(2));
    // TP2 : extension 100%
    tp2 = fib ? parseFloat(fib.swingLow.toFixed(2)) : parseFloat((price - atr * 4).toFixed(2));
  }

  const slPips  = parseFloat(Math.abs(price - sl).toFixed(2));
  const tp1Pips = parseFloat(Math.abs(tp1 - price).toFixed(2));
  const tp2Pips = parseFloat(Math.abs(tp2 - price).toFixed(2));
  const rr1     = parseFloat((tp1Pips / slPips).toFixed(1));
  const rr2     = parseFloat((tp2Pips / slPips).toFixed(1));

  return { signal, price, sl, tp1, tp2, slPips, tp1Pips, tp2Pips, rr1, rr2, reasons, conf, fib, atr, ema50, ema200 };
}

// ─────────────────────────────────────────────
//  FETCH XAUUSD — Kraken (XBTZUSD) / fallback price API
//  Kraken ne propose pas XAU donc on utilise Metals-API free
//  ou on simule via une API gold gratuite
// ─────────────────────────────────────────────

async function fetchXAUCandles() {
  // Frankfurter + MetalPrice API pour XAUUSD OHLC M5
  // On utilise l'API publique de Stooq pour les données gold
  const url = "https://stooq.com/q/d/l/?s=xauusd&i=5"; // CSV OHLC M5
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => {
        try {
          const lines = data.trim().split("\n").slice(1); // skip header
          const candles = lines.slice(-250).map(line => {
            const [date, time, open, high, low, close, vol] = line.split(",");
            return {
              open:  parseFloat(open),
              high:  parseFloat(high),
              low:   parseFloat(low),
              close: parseFloat(close),
              vol:   parseFloat(vol) || 0,
            };
          }).filter(c => !isNaN(c.close));
          if (candles.length < 50) throw new Error("Not enough candles: " + candles.length);
          resolve(candles);
        } catch(e) { reject(e); }
      });
    }).on("error", reject);
  });
}

// ─────────────────────────────────────────────
//  MAIN LOOP
// ─────────────────────────────────────────────

let lastSignalTime = 0;
const COOLDOWN = 45 * 60 * 1000; // 45 min entre signaux

async function run() {
  if (isWeekend()) {
    console.log("Weekend — pas de signal XAUUSD.");
    return;
  }

  const session = getSession();
  if (!session) {
    console.log(`${new Date().toISOString()} | Hors session — en attente.`);
    return;
  }

  try {
    const candles = await fetchXAUCandles();
    const result  = analyzeSMC(candles);
    const price   = candles[candles.length-1].close;

    if (!result) {
      console.log(`${new Date().toISOString()} | ${session} | $${price.toFixed(2)} | Pas de setup SMC.`);
      return;
    }

    const now = Date.now();
    if (now - lastSignalTime < COOLDOWN) {
      console.log("Signal trouvé mais cooldown actif.");
      return;
    }
    lastSignalTime = now;

    const emoji  = result.signal === "BUY" ? "🟢" : "🔴";
    const action = result.signal === "BUY" ? "ACHÈTE" : "VENDS";

    const msg =
      `${emoji} *SIGNAL XAUUSD — ${action}*\n` +
      `📍 Session: ${session}\n\n` +
      `💰 Entrée: *$${result.price.toFixed(2)}*\n` +
      `🛑 SL: *${result.slPips.toFixed(2)} pips* ($${result.sl.toFixed(2)})\n` +
      `🎯 TP1: *${result.tp1Pips.toFixed(2)} pips* ($${result.tp1.toFixed(2)}) — R/R 1:${result.rr1}\n` +
      `🎯 TP2: *${result.tp2Pips.toFixed(2)} pips* ($${result.tp2.toFixed(2)}) — R/R 1:${result.rr2}\n\n` +
      `*Confluences (${result.conf}/6):*\n` +
      result.reasons.join("\n") + "\n\n" +
      (result.fib ? 
        `*Niveaux Fibo:*\n` +
        `0.382 → $${result.fib.f382}\n` +
        `0.500 → $${result.fib.f500}\n` +
        `0.618 → *$${result.fib.f618}* ⭐\n` +
        `0.706 → *$${result.fib.f706}* ⭐\n` +
        `0.786 → $${result.fib.f786}\n\n` : "") +
      `📉 ATR: ${result.atr.toFixed(2)} | EMA50: $${result.ema50.toFixed(2)}\n\n` +
      `_Not financial advice — FTMO rules apply_`;

    await sendTelegram(msg);
    console.log(`✅ Signal XAUUSD envoyé: ${action} | $${result.price.toFixed(2)}`);

  } catch(e) {
    console.error("Erreur:", e.message);
  }
}

console.log("XAUUSD SMC Bot démarré ✅");
sendTelegram(
  "🥇 XAUUSD SMC Signal Bot demarre\n\n" +
  "Strategie: Smart Money Concepts\n" +
  "Logique: CHoCH + Liq Sweep + BOS + Golden Zone\n" +
  "Sessions: London + New York\n" +
  "Paire: XAU/USD M5\n" +
  "Compte: FTMO Challenge\n\n" +
  "Signaux uniquement pendant les Kill Zones"
);

run();
setInterval(run, 60 * 1000);
