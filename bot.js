const https = require("https");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const FINANCIAL_DATASETS_KEY = process.env.FINANCIAL_DATASETS_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL = process.env.TO_EMAIL;
const FROM_EMAIL = process.env.FROM_EMAIL || "onboarding@resend.dev";

// Top 50 S&P500 op marktgewicht
const TICKERS = [
  "AAPL","MSFT","NVDA","GOOGL","AMZN","META","TSLA","AVGO","BRK-B","LLY",
  "JPM","V","UNH","XOM","MA","JNJ","PG","HD","COST","MRK",
  "ABBV","CVX","KO","PEP","BAC","WMT","CRM","TMO","ACN","CSCO",
  "ABT","MCD","AMD","NFLX","WFC","LIN","DHR","PM","NEE","TXN",
  "MS","GS","RTX","CAT","HON","AMGN","INTU","QCOM","LOW","SPGI"
];

function httpsGet(url, apiKey) {
  return new Promise((resolve, reject) => {
    const options = { headers: apiKey ? { "X-API-KEY": apiKey } : {} };
    https.get(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
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

async function getTickerData(ticker) {
  try {
    const url = `https://api.financialdatasets.ai/prices/?ticker=${ticker}&interval=day&interval_multiplier=1&start_date=${getPastDate(30)}&end_date=${getToday()}`;
    const data = await httpsGet(url, FINANCIAL_DATASETS_KEY);
    if (!data.prices || data.prices.length < 15) return null;

    const prices = data.prices.sort((a, b) => new Date(b.time) - new Date(a.time));
    const latest = prices[0];
    const prev = prices[1];

    // RSI berekening
    const closes = prices.slice(0, 15).map(p => p.close).reverse();
    let gains = 0, losses = 0;
    for (let i = 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i-1];
      if (diff > 0) gains += diff; else losses -= diff;
    }
    const rs = (losses/14) === 0 ? 100 : (gains/14)/(losses/14);
    const rsi = parseFloat((100 - (100/(1+rs))).toFixed(1));

    // Gemiddeld volume (20 dagen)
    const avgVolume = prices.slice(0, 20).reduce((s, p) => s + p.volume, 0) / 20;
    const volumeRatio = parseFloat((latest.volume / avgVolume).toFixed(2));

    return {
      ticker,
      close: latest.close,
      prevClose: prev.close,
      high: latest.high,
      low: latest.low,
      volume: latest.volume,
      avgVolume: Math.round(avgVolume),
      volumeRatio,
      rsi,
      priceChange: parseFloat(((latest.close - prev.close) / prev.close * 100).toFixed(2)),
    };
  } catch (err) {
    console.log(`  ⚠️ Geen data voor ${ticker}: ${err.message}`);
    return null;
  }
}

function getToday() {
  return new Date().toISOString().split("T")[0];
}

function getPastDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split("T")[0];
}

function screenTicker(data) {
  // Filter op interessante setups — RSI oversold/overbought + volume spike
  const oversold = data.rsi < 35;
  const overbought = data.rsi > 65;
  const volumeSpike = data.volumeRatio > 1.5;
  const bigMove = Math.abs(data.priceChange) > 2;
  return (oversold || overbought) && (volumeSpike || bigMove);
}

async function analyseWithClaude(tickerData, spyChange) {
  const { ticker, close, prevClose, volume, avgVolume, volumeRatio, rsi, priceChange, high, low } = tickerData;

  const prompt = `Je bent een swing trade analist. Analyseer voor 3-5 dagen.
TICKER: ${ticker}
Slotkoers: $${close.toFixed(2)}
Dagverandering: ${priceChange}%
High/Low: $${high.toFixed(2)} / $${low.toFixed(2)}
Volume: ${volume.toLocaleString()} (${volumeRatio}x gemiddelde)
RSI (14): ${rsi}
SPY gisteren: ${spyChange !== null ? `${spyChange.toFixed(2)}%` : "N/A"}

Geef ALLEEN dit JSON object terug, geen tekst erbuiten:
{"signaal":"KOOP of VERKOOP of GEEN SETUP","sterkte":0,"entry_min":0,"entry_max":0,"stop_loss":0,"take_profit_1":0,"take_profit_2":0,"rr_ratio":0.0,"context_score":0,"setup_uitleg":"max 2 zinnen","waarschuwing":"tekst of null","niet_instappen_als":"conditie"}

Alleen KOOP of VERKOOP bij sterkte >= 7.`;

  const response = await httpsPost("api.anthropic.com", "/v1/messages", {
    model: "claude-sonnet-4-20250514",
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }],
  }, { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" });

  const text = response.content[0].text;
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

function buildEmailHTML(results, spyData, date) {
  const signals = results.filter(r => r.analyse && r.analyse.signaal !== "GEEN SETUP");
  const spyColor = spyData && spyData.priceChange >= 0 ? "#1D9E75" : "#E24B4A";

  const cards = signals.length === 0
    ? `<div style="padding:20px;text-align:center;color:#888;font-size:14px;">Geen sterke setups vandaag — markt bewaken.</div>`
    : signals.map(({ data, analyse }) => {
        const isKoop = analyse.signaal === "KOOP";
        const topColor = isKoop ? "#0F6E56" : "#993C1D";
        const ctxColor = analyse.context_score >= 7 ? "#1D9E75" : analyse.context_score >= 5 ? "#EF9F27" : "#E24B4A";
        const slPct = (((analyse.stop_loss - data.close) / data.close) * 100).toFixed(1);
        const tpPct = (((analyse.take_profit_2 - data.close) / data.close) * 100).toFixed(1);
        return `
<div style="background:#fff;border:1px solid #e0e0e0;border-radius:12px;overflow:hidden;margin-bottom:20px;">
  <div style="background:${topColor};padding:16px 20px;">
    <div style="font-size:11px;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Swing trade · 3-5 dagen · Entry na 15:30 Vlaamse tijd</div>
    <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;">
      <span style="font-size:28px;font-weight:600;color:#fff;">${data.ticker}</span>
      <span style="font-size:15px;color:rgba(255,255,255,0.8);">Slotkoers: $${data.close.toFixed(2)}</span>
      <span style="background:${isKoop?"#EAF3DE":"#FCEBEB"};color:${isKoop?"#3B6D11":"#A32D2D"};font-size:12px;padding:3px 10px;border-radius:20px;font-weight:600;">${analyse.signaal} · ${analyse.sterkte}/10</span>
    </div>
  </div>
  <div style="padding:12px 20px;background:#f8f8f8;border-bottom:1px solid #eee;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
    <div style="background:#fff;border:1px solid #eee;border-radius:8px;padding:8px 14px;text-align:center;">
      <div style="font-size:10px;color:#888;margin-bottom:2px;">Context</div>
      <div style="font-size:16px;font-weight:600;color:${ctxColor};">${analyse.context_score}/10</div>
    </div>
    <div style="background:#fff;border:1px solid #eee;border-radius:8px;padding:8px 14px;text-align:center;">
      <div style="font-size:10px;color:#888;margin-bottom:2px;">RSI</div>
      <div style="font-size:16px;font-weight:600;color:#534AB7;">${data.rsi}</div>
    </div>
    <div style="background:#fff;border:1px solid #eee;border-radius:8px;padding:8px 14px;text-align:center;">
      <div style="font-size:10px;color:#888;margin-bottom:2px;">Volume</div>
      <div style="font-size:16px;font-weight:600;color:#534AB7;">${data.volumeRatio}x</div>
    </div>
    <div style="font-size:13px;color:#555;flex:1;">${analyse.setup_uitleg}</div>
  </div>
  ${analyse.waarschuwing ? `<div style="margin:12px 20px 0;padding:8px 12px;background:#FAEEDA;border-radius:8px;font-size:12px;color:#854F0B;">⚠️ ${analyse.waarschuwing}</div>` : ""}
  <div style="padding:16px 20px;">
    <div style="background:#EEEDFE;border:1px solid #c8c4f0;border-radius:10px;padding:14px 18px;margin-bottom:12px;">
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;text-align:center;">
        <div>
          <div style="font-size:10px;color:#534AB7;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Entry zone</div>
          <div style="font-size:15px;font-weight:600;color:#26215C;">$${analyse.entry_min}–$${analyse.entry_max}</div>
        </div>
        <div>
          <div style="font-size:10px;color:#534AB7;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Stop-loss</div>
          <div style="font-size:15px;font-weight:600;color:#26215C;">$${analyse.stop_loss}</div>
          <div style="font-size:11px;color:#A32D2D;">${slPct}%</div>
        </div>
        <div>
          <div style="font-size:10px;color:#534AB7;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Take profit</div>
          <div style="font-size:15px;font-weight:600;color:#26215C;">$${analyse.take_profit_2}</div>
          <div style="font-size:11px;color:#1D9E75;">+${tpPct}%</div>
        </div>
      </div>
      <div style="margin-top:10px;padding-top:10px;border-top:1px solid #c8c4f0;display:flex;justify-content:space-between;">
        <span style="font-size:12px;color:#534AB7;">Risico/rendement</span>
        <span style="font-size:13px;font-weight:600;color:#26215C;">1 : ${analyse.rr_ratio}</span>
      </div>
    </div>
    <div style="font-size:12px;color:#e05a00;padding:8px 12px;background:#fff3ec;border-radius:8px;">🚫 Niet instappen als: ${analyse.niet_instappen_als}</div>
  </div>
</div>`;
      }).join("");

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:20px;">
  <div style="background:#534AB7;border-radius:12px;padding:20px 24px;margin-bottom:16px;">
    <div style="font-size:11px;color:#CECBF6;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Dagelijkse swing trade briefing</div>
    <div style="font-size:22px;font-weight:600;color:#fff;">${date} · 08:15 Vlaamse tijd</div>
    <div style="font-size:13px;color:#AFA9EC;margin-top:4px;">US markten openen om 15:30 · ${signals.length} setup${signals.length!==1?"s":""} gevonden uit top 50 S&P500</div>
  </div>
  <div style="background:#fff;border-radius:12px;padding:14px 18px;margin-bottom:16px;display:flex;gap:16px;flex-wrap:wrap;">
    <div>
      <div style="font-size:10px;color:#888;text-transform:uppercase;margin-bottom:4px;">SPY gisteren</div>
      <div style="font-size:16px;font-weight:600;color:${spyColor};">${spyData?`$${spyData.close.toFixed(2)} (${spyData.priceChange>=0?"+":""}${spyData.priceChange}%)`:"N/A"}</div>
    </div>
    <div>
      <div style="font-size:10px;color:#888;text-transform:uppercase;margin-bottom:4px;">Gescand</div>
      <div style="font-size:16px;font-weight:600;color:#534AB7;">50 tickers</div>
    </div>
    <div>
      <div style="font-size:10px;color:#888;text-transform:uppercase;margin-bottom:4px;">Gefilterd</div>
      <div style="font-size:16px;font-weight:600;color:#534AB7;">${results.length} kandidaten</div>
    </div>
  </div>
  ${cards}
  <div style="text-align:center;font-size:11px;color:#aaa;padding:16px;line-height:1.6;">
    Geautomatiseerde swing trade briefing · Geen financieel advies.<br>Jij beslist — de agent signaleert.
  </div>
</div></body></html>`;
}

async function sendEmail(html, signalCount, date) {
  const result = await httpsPost("api.resend.com", "/emails", {
    from: FROM_EMAIL,
    to: TO_EMAIL,
    subject: `📈 Trading briefing ${date} — ${signalCount} setup${signalCount!==1?"s":""} gevonden`,
    html,
  }, { Authorization: `Bearer ${RESEND_API_KEY}` });
  console.log("Resend response:", JSON.stringify(result));
}

async function runBot() {
  console.log("🤖 Trading bot gestart —", new Date().toLocaleString("nl-BE"));
  console.log("TO_EMAIL:", TO_EMAIL ? "✅" : "❌ NIET ingesteld");
  console.log("FINANCIAL_DATASETS_KEY:", FINANCIAL_DATASETS_KEY ? "✅" : "❌ NIET ingesteld");
  console.log("RESEND_API_KEY:", RESEND_API_KEY ? "✅" : "❌ NIET ingesteld");

  const today = new Date().toLocaleDateString("nl-BE", { weekday: "long", day: "numeric", month: "long" });

  // SPY data ophalen
  console.log("📊 SPY ophalen...");
  const spyData = await getTickerData("SPY");
  console.log(`SPY: ${spyData ? `$${spyData.close.toFixed(2)} (${spyData.priceChange}%)` : "geen data"}`);
  await sleep(500);

  // Scan alle 50 tickers
  console.log(`\n🔍 Scannen van ${TICKERS.length} tickers...`);
  const allData = [];
  for (const ticker of TICKERS) {
    const data = await getTickerData(ticker);
    if (data) {
      allData.push(data);
      process.stdout.write(`  ${ticker}: RSI ${data.rsi} | ${data.priceChange}% | vol ${data.volumeRatio}x\n`);
    }
    await sleep(300);
  }

  // Filter op interessante setups
  const candidates = allData.filter(screenTicker);
  console.log(`\n✅ ${allData.length} tickers gescand — ${candidates.length} kandidaten voor Claude analyse`);

  // Claude analyse op kandidaten
  const results = [];
  const spyChange = spyData ? spyData.priceChange : null;
  for (const data of candidates) {
    try {
      console.log(`🤖 Claude analyseert ${data.ticker}...`);
      const analyse = await analyseWithClaude(data, spyChange);
      results.push({ data, analyse });
      console.log(`  → ${analyse.signaal} (${analyse.sterkte}/10)`);
      await sleep(1000);
    } catch (err) {
      console.error(`  ❌ ${data.ticker}:`, err.message);
    }
  }

  const signals = results.filter(r => r.analyse.signaal !== "GEEN SETUP");
  console.log(`\n📧 ${signals.length} setups → email naar ${TO_EMAIL}`);
  const html = buildEmailHTML(results, spyData, today);
  await sendEmail(html, signals.length, today);
  console.log("✅ Klaar!");
}

runBot().catch(console.error);
