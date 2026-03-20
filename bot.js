const https = require("https");

// ─── CONFIG ───────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL = process.env.TO_EMAIL;
const FROM_EMAIL = process.env.FROM_EMAIL || "trading@resend.dev";

// Tickers om te scannen — pas aan naar jouw selectie
const TICKERS = [
  "NVDA", "AAPL", "MSFT", "META", "GOOGL",
  "AMZN", "TSLA", "AMD", "CRM", "AVGO"
];

// ─── HELPERS ──────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

function httpsPost(hostname, path, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = {
      hostname, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers }
    };
    const req = https.request(options, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── MARKTDATA ────────────────────────────────────────────
async function getDailyData(ticker) {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${ticker}&outputsize=compact&apikey=${ALPHA_VANTAGE_KEY}`;
  const data = await httpsGet(url);
  const series = data["Time Series (Daily)"];
  if (!series) return null;
  const dates = Object.keys(series).sort().reverse();
  const latest = series[dates[0]];
  const prev = series[dates[1]];
  return {
    ticker,
    date: dates[0],
    close: parseFloat(latest["4. close"]),
    prevClose: parseFloat(prev["4. close"]),
    volume: parseInt(latest["5. volume"]),
    high: parseFloat(latest["2. high"]),
    low: parseFloat(latest["3. low"]),
    open: parseFloat(latest["1. open"]),
  };
}

async function getRSI(ticker) {
  const url = `https://www.alphavantage.co/query?function=RSI&symbol=${ticker}&interval=daily&time_period=14&series_type=close&apikey=${ALPHA_VANTAGE_KEY}`;
  const data = await httpsGet(url);
  const analysis = data["Technical Analysis: RSI"];
  if (!analysis) return null;
  const latest = Object.values(analysis)[0];
  return parseFloat(latest["RSI"]);
}

async function getMACD(ticker) {
  const url = `https://www.alphavantage.co/query?function=MACD&symbol=${ticker}&interval=daily&series_type=close&apikey=${ALPHA_VANTAGE_KEY}`;
  const data = await httpsGet(url);
  const analysis = data["Technical Analysis: MACD"];
  if (!analysis) return null;
  const values = Object.values(analysis);
  const latest = values[0];
  const prev = values[1];
  const crossover =
    parseFloat(prev["MACD"]) < parseFloat(prev["MACD_Signal"]) &&
    parseFloat(latest["MACD"]) > parseFloat(latest["MACD_Signal"]);
  return {
    macd: parseFloat(latest["MACD"]),
    signal: parseFloat(latest["MACD_Signal"]),
    histogram: parseFloat(latest["MACD_Hist"]),
    bullishCrossover: crossover,
  };
}

async function getVIX() {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=VIX&apikey=${ALPHA_VANTAGE_KEY}`;
  const data = await httpsGet(url);
  const series = data["Time Series (Daily)"];
  if (!series) return null;
  const latest = Object.values(series)[0];
  return parseFloat(latest["4. close"]);
}

async function getSPY() {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=SPY&apikey=${ALPHA_VANTAGE_KEY}`;
  const data = await httpsGet(url);
  const series = data["Time Series (Daily)"];
  if (!series) return null;
  const dates = Object.keys(series).sort().reverse();
  const close = parseFloat(series[dates[0]]["4. close"]);
  const prevClose = parseFloat(series[dates[1]]["4. close"]);
  return { close, change: ((close - prevClose) / prevClose) * 100 };
}

// ─── CLAUDE ANALYSE ───────────────────────────────────────
async function analyseWithClaude(tickerData) {
  const { ticker, close, prevClose, volume, rsi, macd, vix, spy } = tickerData;
  const priceChange = ((close - prevClose) / prevClose) * 100;

  const prompt = `Je bent een professionele swing trade analist. Analyseer deze data en geef een concreet swing trade advies voor de komende 3-5 handelsdagen.

TICKER: ${ticker}
Slotkoers gisteren: $${close.toFixed(2)}
Vorige slotkoers: $${prevClose.toFixed(2)} (${priceChange.toFixed(2)}%)
Volume: ${volume.toLocaleString()}
RSI (14): ${rsi ? rsi.toFixed(1) : "N/A"}
MACD: ${macd ? macd.macd.toFixed(3) : "N/A"} | Signal: ${macd ? macd.signal.toFixed(3) : "N/A"} | Bullish crossover: ${macd ? macd.bullishCrossover : "N/A"}

MARKTCONTEXT:
SPY slotkoers: $${spy ? spy.close.toFixed(2) : "N/A"} (${spy ? spy.change.toFixed(2) : "N/A"}%)
VIX: ${vix ? vix.toFixed(1) : "N/A"}

Geef je analyse in dit exacte JSON formaat (geen tekst erbuiten):
{
  "signaal": "KOOP" of "VERKOOP" of "GEEN SETUP",
  "sterkte": getal 1-10,
  "entry_min": getal,
  "entry_max": getal,
  "stop_loss": getal,
  "take_profit_1": getal,
  "take_profit_2": getal,
  "rr_ratio": getal,
  "houdduur": "X-Y dagen",
  "context_score": getal 1-10,
  "context_uitleg": "korte uitleg marktcontext",
  "setup_uitleg": "max 2 zinnen waarom deze setup",
  "waarschuwing": "eventuele waarschuwing of null",
  "niet_instappen_als": "prijs conditie"
}

Geef alleen KOOP of VERKOOP terug als er een echte sterke setup is (sterkte >= 7). Anders GEEN SETUP.`;

  const response = await httpsPost(
    "api.anthropic.com",
    "/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    },
    {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    }
  );

  const text = response.content[0].text;
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── EMAIL HTML ───────────────────────────────────────────
function buildEmailHTML(analyses, vix, spy, date) {
  const signals = analyses.filter(a => a.analyse && a.analyse.signaal !== "GEEN SETUP");

  const spyColor = spy && spy.change >= 0 ? "#1D9E75" : "#E24B4A";
  const vixLevel = vix < 20 ? "Laag ✓" : vix < 30 ? "Gemiddeld" : "Hoog ⚠";
  const vixColor = vix < 20 ? "#1D9E75" : vix < 30 ? "#EF9F27" : "#E24B4A";

  const signalCards = signals.length === 0
    ? `<div style="padding:20px;text-align:center;color:#888;font-size:14px;">Geen sterke setups vandaag — markt bewaken.</div>`
    : signals.map(({ ticker, data, analyse }) => {
        const isKoop = analyse.signaal === "KOOP";
        const topColor = isKoop ? "#0F6E56" : "#993C1D";
        const badgeBg = isKoop ? "#EAF3DE" : "#FCEBEB";
        const badgeColor = isKoop ? "#3B6D11" : "#A32D2D";
        const ctxColor = analyse.context_score >= 7 ? "#1D9E75" : analyse.context_score >= 5 ? "#EF9F27" : "#E24B4A";

        return `
<div style="background:#ffffff;border:1px solid #e0e0e0;border-radius:12px;overflow:hidden;margin-bottom:20px;">
  <div style="background:${topColor};padding:16px 20px;">
    <div style="font-size:11px;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Swing trade setup · ${analyse.houdduur}</div>
    <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;">
      <span style="font-size:28px;font-weight:600;color:#ffffff;">${ticker}</span>
      <span style="font-size:15px;color:rgba(255,255,255,0.8);">Slotkoers: $${data.close.toFixed(2)}</span>
      <span style="background:${badgeBg};color:${badgeColor};font-size:12px;padding:3px 10px;border-radius:20px;font-weight:600;">${analyse.signaal}</span>
    </div>
    <div style="font-size:13px;color:rgba(255,255,255,0.7);margin-top:6px;">Entry vanaf 15:30 Vlaamse tijd · US open</div>
  </div>

  <div style="padding:16px 20px;background:#f8f8f8;border-bottom:1px solid #eee;">
    <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">Marktcontext</div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <div style="background:#fff;border:1px solid #eee;border-radius:8px;padding:8px 14px;text-align:center;">
        <div style="font-size:10px;color:#888;margin-bottom:2px;">Contextscore</div>
        <div style="font-size:18px;font-weight:600;color:${ctxColor};">${analyse.context_score}/10</div>
      </div>
      <div style="font-size:13px;color:#555;flex:1;">${analyse.context_uitleg}</div>
    </div>
    ${analyse.waarschuwing ? `<div style="margin-top:10px;padding:8px 12px;background:#FAEEDA;border-radius:8px;font-size:12px;color:#854F0B;">⚠️ ${analyse.waarschuwing}</div>` : ""}
  </div>

  <div style="padding:16px 20px;">
    <div style="background:#EEF;border:1px solid #c8c4f0;border-radius:10px;padding:14px 18px;margin-bottom:14px;">
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;text-align:center;">
        <div>
          <div style="font-size:10px;color:#534AB7;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Entry zone</div>
          <div style="font-size:18px;font-weight:600;color:#26215C;">$${analyse.entry_min} – $${analyse.entry_max}</div>
        </div>
        <div>
          <div style="font-size:10px;color:#534AB7;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Stop-loss</div>
          <div style="font-size:18px;font-weight:600;color:#26215C;">$${analyse.stop_loss}</div>
          <div style="font-size:11px;color:#534AB7;">${(((analyse.stop_loss - data.close) / data.close) * 100).toFixed(1)}%</div>
        </div>
        <div>
          <div style="font-size:10px;color:#534AB7;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Take profit</div>
          <div style="font-size:18px;font-weight:600;color:#26215C;">$${analyse.take_profit_2}</div>
          <div style="font-size:11px;color:#534AB7;">+${(((analyse.take_profit_2 - data.close) / data.close) * 100).toFixed(1)}%</div>
        </div>
      </div>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #c8c4f0;display:flex;justify-content:space-between;">
        <span style="font-size:12px;color:#534AB7;">Risico/rendement</span>
        <span style="font-size:13px;font-weight:600;color:#26215C;">1 : ${analyse.rr_ratio}</span>
      </div>
    </div>

    <div style="font-size:13px;color:#444;line-height:1.7;padding:12px 14px;background:#f5f5f5;border-radius:8px;border-left:3px solid #534AB7;margin-bottom:14px;">
      ${analyse.setup_uitleg}
    </div>

    <div style="font-size:12px;color:#e05a00;padding:8px 12px;background:#fff3ec;border-radius:8px;">
      🚫 Niet instappen als: ${analyse.niet_instappen_als}
    </div>
  </div>
</div>`;
      }).join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:20px;">

  <div style="background:#534AB7;border-radius:12px;padding:20px 24px;margin-bottom:16px;">
    <div style="font-size:11px;color:#CECBF6;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Dagelijkse swing trade briefing</div>
    <div style="font-size:22px;font-weight:600;color:#ffffff;">${date} · Vlaamse tijd 08:15</div>
    <div style="font-size:13px;color:#AFA9EC;margin-top:4px;">US markten openen om 15:30 · ${signals.length} setup${signals.length !== 1 ? "s" : ""} gevonden</div>
  </div>

  <div style="background:#fff;border-radius:12px;padding:14px 18px;margin-bottom:16px;display:flex;gap:12px;flex-wrap:wrap;">
    <div style="flex:1;min-width:120px;">
      <div style="font-size:10px;color:#888;text-transform:uppercase;margin-bottom:4px;">SPY gisteren</div>
      <div style="font-size:16px;font-weight:600;color:${spyColor};">${spy ? `$${spy.close.toFixed(2)} (${spy.change >= 0 ? "+" : ""}${spy.change.toFixed(2)}%)` : "N/A"}</div>
    </div>
    <div style="flex:1;min-width:120px;">
      <div style="font-size:10px;color:#888;text-transform:uppercase;margin-bottom:4px;">VIX (angstmeter)</div>
      <div style="font-size:16px;font-weight:600;color:${vixColor};">${vix ? `${vix.toFixed(1)} — ${vixLevel}` : "N/A"}</div>
    </div>
    <div style="flex:1;min-width:120px;">
      <div style="font-size:10px;color:#888;text-transform:uppercase;margin-bottom:4px;">Setups vandaag</div>
      <div style="font-size:16px;font-weight:600;color:#534AB7;">${signals.length} van ${analyses.length} tickers</div>
    </div>
  </div>

  ${signalCards}

  <div style="text-align:center;font-size:11px;color:#aaa;padding:16px;line-height:1.6;">
    Geautomatiseerde swing trade briefing · Technische analyse + AI op basis van slotkoers.<br>
    Geen financieel advies. Jij beslist — de agent signaleert.<br>
    Entry altijd na 15:30 Vlaamse tijd · Wacht op CPI/Fed events voor instap.
  </div>
</div>
</body>
</html>`;
}

// ─── EMAIL VERZENDEN ──────────────────────────────────────
async function sendEmail(html, signalCount) {
  const today = new Date().toLocaleDateString("nl-BE", { weekday: "long", day: "numeric", month: "long" });
  await httpsPost(
    "api.resend.com",
    "/emails",
    {
      from: FROM_EMAIL,
      to: TO_EMAIL,
      subject: `📈 Trading briefing ${today} — ${signalCount} setup${signalCount !== 1 ? "s" : ""} gevonden`,
      html,
    },
    { Authorization: `Bearer ${RESEND_API_KEY}` }
  );
  console.log(`✅ Email verzonden naar ${TO_EMAIL}`);
}

// ─── HOOFDFUNCTIE ─────────────────────────────────────────
async function runBot() {
  console.log("🤖 Trading bot gestart —", new Date().toLocaleString("nl-BE"));

  const today = new Date().toLocaleDateString("nl-BE", { weekday: "long", day: "numeric", month: "long" });

  // Haal marktcontext op
  console.log("📊 Marktcontext ophalen...");
  const [vix, spy] = await Promise.all([getVIX(), getSPY()]);
  console.log(`VIX: ${vix?.toFixed(1)} | SPY: ${spy?.close.toFixed(2)} (${spy?.change.toFixed(2)}%)`);

  // Analyseer alle tickers één voor één (Alpha Vantage rate limit: 5/min)
  const analyses = [];
  for (const ticker of TICKERS) {
    try {
      console.log(`🔍 Analyseer ${ticker}...`);
      const [data, rsi, macd] = await Promise.all([
        getDailyData(ticker),
        getRSI(ticker),
        getMACD(ticker),
      ]);

      if (!data) { console.log(`  ⚠️ Geen data voor ${ticker}`); continue; }

      const analyse = await analyseWithClaude({ ticker, ...data, rsi, macd, vix, spy });
      analyses.push({ ticker, data, analyse });
      console.log(`  → ${analyse.signaal} (sterkte: ${analyse.sterkte}/10)`);

      // Wacht 15 seconden tussen tickers (Alpha Vantage free tier: 5 calls/min)
      await sleep(15000);
    } catch (err) {
      console.error(`  ❌ Fout bij ${ticker}:`, err.message);
    }
  }

  // Bouw en verstuur email
  const signals = analyses.filter(a => a.analyse.signaal !== "GEEN SETUP");
  console.log(`\n📧 ${signals.length} setups gevonden — email opstellen...`);
  const html = buildEmailHTML(analyses, vix, spy, today);
  await sendEmail(html, signals.length);
  console.log("✅ Bot klaar!");
}

runBot().catch(console.error);
