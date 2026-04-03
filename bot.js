const https = require("https");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const FINANCIAL_DATASETS_KEY = process.env.FINANCIAL_DATASETS_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL = process.env.TO_EMAIL;
const FROM_EMAIL = process.env.FROM_EMAIL || "onboarding@resend.dev";

const SP500_TICKERS = [
  "AAPL","MSFT","NVDA","GOOGL","AMZN","META","TSLA","AVGO","LLY","JPM",
  "V","UNH","XOM","MA","JNJ","PG","HD","COST","MRK","ABBV",
  "CVX","KO","PEP","BAC","WMT","CRM","TMO","ACN","CSCO","ABT",
  "MCD","AMD","NFLX","WFC","LIN","DHR","PM","NEE","TXN","MS",
  "GS","RTX","CAT","HON","AMGN","INTU","QCOM","LOW","SPGI","BLK"
];

const EU_TICKERS = [
  { ticker: "ASML.AS", naam: "ASML", markt: "AEX" },
  { ticker: "SHELL.AS", naam: "Shell", markt: "AEX" },
  { ticker: "INGA.AS", naam: "ING", markt: "AEX" },
  { ticker: "PHIA.AS", naam: "Philips", markt: "AEX" },
  { ticker: "ADYEN.AS", naam: "Adyen", markt: "AEX" },
  { ticker: "ABI.BR", naam: "AB InBev", markt: "BEL20" },
  { ticker: "KBC.BR", naam: "KBC", markt: "BEL20" },
  { ticker: "BEKB.BR", naam: "Bekaert", markt: "BEL20" },
  { ticker: "SOLB.BR", naam: "Solvay", markt: "BEL20" },
  { ticker: "UCB.BR", naam: "UCB", markt: "BEL20" },
  { ticker: "SAP.DE", naam: "SAP", markt: "DAX" },
  { ticker: "SIE.DE", naam: "Siemens", markt: "DAX" },
  { ticker: "BAS.DE", naam: "BASF", markt: "DAX" },
  { ticker: "BMW.DE", naam: "BMW", markt: "DAX" },
  { ticker: "BAYN.DE", naam: "Bayer", markt: "DAX" },
];

function httpsGet(url, apiKey) {
  return new Promise((resolve, reject) => {
    const options = { headers: apiKey ? { "X-API-KEY": apiKey } : { "User-Agent": "Mozilla/5.0" } };
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
function getToday() { return new Date().toISOString().split("T")[0]; }
function getPastDate(days) { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().split("T")[0]; }

async function getUSData(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1mo`;
    const data = await httpsGet(url);
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const closes = result.indicators.quote[0].close.filter(Boolean);
    const volumes = result.indicators.quote[0].volume.filter(Boolean);
    const highs = result.indicators.quote[0].high.filter(Boolean);
    const lows = result.indicators.quote[0].low.filter(Boolean);
    if (closes.length < 15) return null;
    const combined = closes.map((c, i) => ({ close: c, volume: volumes[i] || 0, high: highs[i] || c, low: lows[i] || c })).reverse();
    return calcMetrics(ticker, combined, "US");
  } catch (err) { return null; }
}

async function getEUData(ticker, naam, markt) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1mo`;
    const data = await httpsGet(url);
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const closes = result.indicators.quote[0].close.filter(Boolean);
    const volumes = result.indicators.quote[0].volume.filter(Boolean);
    const highs = result.indicators.quote[0].high.filter(Boolean);
    const lows = result.indicators.quote[0].low.filter(Boolean);
    if (closes.length < 15) return null;
    const combined = closes.map((c, i) => ({ close: c, volume: volumes[i] || 0, high: highs[i] || c, low: lows[i] || c })).reverse();
    return calcMetrics(ticker, combined, markt, naam);
  } catch (err) { return null; }
}

function calcMetrics(ticker, prices, markt, naam) {
  if (!prices || prices.length < 15) return null;
  const latest = prices[0];
  const prev = prices[1];
  const closes = prices.slice(0, 15).map(p => p.close).reverse();
  let gains = 0, losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const rs = (losses/14) === 0 ? 100 : (gains/14)/(losses/14);
  const rsi = parseFloat((100 - (100/(1+rs))).toFixed(1));
  const avgVolume = prices.slice(0, 20).reduce((s, p) => s + p.volume, 0) / 20;
  const volumeRatio = parseFloat((latest.volume / avgVolume).toFixed(2));
  return {
    ticker, naam: naam || ticker, markt: markt || "US",
    close: latest.close, prevClose: prev.close,
    high: latest.high, low: latest.low,
    volume: latest.volume, avgVolume: Math.round(avgVolume),
    volumeRatio, rsi,
    priceChange: parseFloat(((latest.close - prev.close) / prev.close * 100).toFixed(2)),
  };
}

function screenTicker(data) {
  const oversold = data.rsi < 35;
  const overbought = data.rsi > 65;
  const volumeSpike = data.volumeRatio > 1.5;
  const bigMove = Math.abs(data.priceChange) > 2;
  if (data.markt !== "US") {
    return oversold || overbought;
  }
  return (oversold || overbought) && (volumeSpike || bigMove);
}

async function analyseWithClaude(tickerData, benchmarkChange) {
  const { ticker, naam, markt, close, prevClose, volume, avgVolume, volumeRatio, rsi, priceChange, high, low } = tickerData;
  const currency = markt === "US" ? "$" : "€";

  const prompt = `Je bent een swing trade analist. Analyseer voor 3-5 dagen.
TICKER: ${naam} (${ticker}) — ${markt}
Slotkoers: ${currency}${close.toFixed(2)}
Dagverandering: ${priceChange}%
High/Low: ${currency}${high.toFixed(2)} / ${currency}${low.toFixed(2)}
Volume: ${volume.toLocaleString()} (${volumeRatio}x gemiddelde)
RSI (14): ${rsi}
Benchmark gisteren: ${benchmarkChange !== null ? `${benchmarkChange.toFixed(2)}%` : "N/A"}

Geef ALLEEN dit JSON object terug, geen tekst erbuiten:
{"signaal":"KOOP of VERKOOP of GEEN SETUP","sterkte":0,"entry_min":0,"entry_max":0,"stop_loss":0,"take_profit_1":0,"take_profit_2":0,"rr_ratio":0.0,"context_score":0,"setup_uitleg":"max 2 zinnen","waarschuwing":"tekst of null","niet_instappen_als":"conditie"}

Alleen KOOP of VERKOOP bij sterkte >= 7 EN rr_ratio >= 2.5.`;

  try {
    const response = await httpsPost("api.anthropic.com", "/v1/messages", {
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }, { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" });

    if (!response.content || !response.content[0]) {
      console.log(`  ⚠️ Lege response van Claude voor ${naam}`);
      return null;
    }
    const text = response.content[0].text;
    const clean = text.replace(/```json|```/g, "").trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { console.log(`  ⚠️ Geen JSON voor ${naam}:`, clean.substring(0, 100)); return null; }
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.log(`  ⚠️ Claude fout voor ${naam}:`, err.message);
    return null;
  }
}

function signalCard(data, analyse, currency) {
  const isKoop = analyse.signaal === "KOOP";
  const topColor = isKoop ? "#0F6E56" : "#993C1D";
  const ctxColor = analyse.context_score >= 7 ? "#1D9E75" : analyse.context_score >= 5 ? "#EF9F27" : "#E24B4A";
  const slPct = (((analyse.stop_loss - data.close) / data.close) * 100).toFixed(1);
  const tpPct = (((analyse.take_profit_2 - data.close) / data.close) * 100).toFixed(1);
  return `
<div style="background:#fff;border:1px solid #e0e0e0;border-radius:12px;overflow:hidden;margin-bottom:16px;">
  <div style="background:${topColor};padding:14px 18px;">
    <div style="font-size:10px;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">${data.markt} · Swing trade · 3-5 dagen</div>
    <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">
      <span style="font-size:24px;font-weight:600;color:#fff;">${data.naam}</span>
      <span style="font-size:13px;color:rgba(255,255,255,0.8);">Slotkoers: ${currency}${data.close.toFixed(2)}</span>
      <span style="background:${isKoop?"#EAF3DE":"#FCEBEB"};color:${isKoop?"#3B6D11":"#A32D2D"};font-size:11px;padding:2px 8px;border-radius:20px;font-weight:600;">${analyse.signaal} · ${analyse.sterkte}/10</span>
    </div>
  </div>
  <div style="padding:10px 18px;background:#f8f8f8;border-bottom:1px solid #eee;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
    <div style="background:#fff;border:1px solid #eee;border-radius:8px;padding:6px 12px;text-align:center;">
      <div style="font-size:10px;color:#888;margin-bottom:1px;">Context</div>
      <div style="font-size:15px;font-weight:600;color:${ctxColor};">${analyse.context_score}/10</div>
    </div>
    <div style="background:#fff;border:1px solid #eee;border-radius:8px;padding:6px 12px;text-align:center;">
      <div style="font-size:10px;color:#888;margin-bottom:1px;">RSI</div>
      <div style="font-size:15px;font-weight:600;color:#534AB7;">${data.rsi}</div>
    </div>
    <div style="background:#fff;border:1px solid #eee;border-radius:8px;padding:6px 12px;text-align:center;">
      <div style="font-size:10px;color:#888;margin-bottom:1px;">Volume</div>
      <div style="font-size:15px;font-weight:600;color:#534AB7;">${data.volumeRatio}x</div>
    </div>
    <div style="font-size:12px;color:#555;flex:1;">${analyse.setup_uitleg}</div>
  </div>
  ${analyse.waarschuwing ? `<div style="margin:10px 18px 0;padding:7px 10px;background:#FAEEDA;border-radius:8px;font-size:11px;color:#854F0B;">⚠️ ${analyse.waarschuwing}</div>` : ""}
  <div style="padding:14px 18px;">
    <div style="background:#EEEDFE;border:1px solid #c8c4f0;border-radius:10px;padding:12px 16px;margin-bottom:10px;">
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;text-align:center;">
        <div>
          <div style="font-size:10px;color:#534AB7;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Entry zone</div>
          <div style="font-size:14px;font-weight:600;color:#26215C;">${currency}${analyse.entry_min}–${currency}${analyse.entry_max}</div>
        </div>
        <div>
          <div style="font-size:10px;color:#534AB7;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Stop-loss</div>
          <div style="font-size:14px;font-weight:600;color:#26215C;">${currency}${analyse.stop_loss}</div>
          <div style="font-size:10px;color:#A32D2D;">${slPct}%</div>
        </div>
        <div>
          <div style="font-size:10px;color:#534AB7;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Take profit</div>
          <div style="font-size:14px;font-weight:600;color:#26215C;">${currency}${analyse.take_profit_2}</div>
          <div style="font-size:10px;color:#1D9E75;">+${tpPct}%</div>
        </div>
      </div>
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid #c8c4f0;display:flex;justify-content:space-between;">
        <span style="font-size:11px;color:#534AB7;">Risico/rendement</span>
        <span style="font-size:12px;font-weight:600;color:#26215C;">1 : ${analyse.rr_ratio}</span>
      </div>
    </div>
    <div style="font-size:11px;color:#e05a00;padding:7px 10px;background:#fff3ec;border-radius:8px;">🚫 Niet instappen als: ${analyse.niet_instappen_als}</div>
  </div>
</div>`;
}

function buildEmailHTML(usResults, euResults, spyData, date) {
  const usSignals = usResults.filter(r => r.analyse && r.analyse.signaal !== "GEEN SETUP");
  const euSignals = euResults.filter(r => r.analyse && r.analyse.signaal !== "GEEN SETUP");
  const totalSignals = usSignals.length + euSignals.length;
  const spyColor = spyData && spyData.priceChange >= 0 ? "#1D9E75" : "#E24B4A";

  const usCards = usSignals.length === 0
    ? `<div style="padding:16px;text-align:center;color:#888;font-size:13px;">Geen sterke US setups vandaag.</div>`
    : usSignals.map(r => signalCard(r.data, r.analyse, "$")).join("");

  const euCards = euSignals.length === 0
    ? `<div style="padding:16px;text-align:center;color:#888;font-size:13px;">Geen sterke Europese setups vandaag.</div>`
    : euSignals.map(r => signalCard(r.data, r.analyse, "€")).join("");

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:20px;">
  <div style="background:#534AB7;border-radius:12px;padding:20px 24px;margin-bottom:16px;">
    <div style="font-size:11px;color:#CECBF6;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Dagelijkse swing trade briefing</div>
    <div style="font-size:22px;font-weight:600;color:#fff;">${date} · 08:00 Vlaamse tijd</div>
    <div style="font-size:13px;color:#AFA9EC;margin-top:4px;">US open 15:30 · EU open 09:00 · ${totalSignals} setup${totalSignals!==1?"s":""} gevonden</div>
  </div>
  <div style="background:#fff;border-radius:12px;padding:14px 18px;margin-bottom:16px;display:flex;gap:16px;flex-wrap:wrap;">
    <div>
      <div style="font-size:10px;color:#888;text-transform:uppercase;margin-bottom:4px;">SPY gisteren</div>
      <div style="font-size:15px;font-weight:600;color:${spyColor};">${spyData?`$${spyData.close.toFixed(2)} (${spyData.priceChange>=0?"+":""}${spyData.priceChange}%)`:"N/A"}</div>
    </div>
    <div>
      <div style="font-size:10px;color:#888;text-transform:uppercase;margin-bottom:4px;">US setups</div>
      <div style="font-size:15px;font-weight:600;color:#534AB7;">${usSignals.length} van 50</div>
    </div>
    <div>
      <div style="font-size:10px;color:#888;text-transform:uppercase;margin-bottom:4px;">EU setups</div>
      <div style="font-size:15px;font-weight:600;color:#534AB7;">${euSignals.length} van 15</div>
    </div>
  </div>
  <div style="font-size:13px;font-weight:500;color:#534AB7;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;padding-left:4px;">🇺🇸 S&P500 — US markten</div>
  ${usCards}
  <div style="font-size:13px;font-weight:500;color:#534AB7;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;margin-top:20px;padding-left:4px;">🇪🇺 Europa — AEX · BEL20 · DAX</div>
  <div style="background:#FAEEDA;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:12px;color:#854F0B;">
    ⏰ Europese markten openen om 09:00 Vlaamse tijd.
  </div>
  ${euCards}
  <div style="text-align:center;font-size:11px;color:#aaa;padding:16px;line-height:1.6;">
    Geautomatiseerde swing trade briefing · Geen financieel advies.<br>Jij beslist — de agent signaleert.
  </div>
</div></body></html>`;
}

async function sendEmail(html, totalSignals, date) {
  const result = await httpsPost("api.resend.com", "/emails", {
    from: FROM_EMAIL,
    to: TO_EMAIL,
    subject: `📈 Trading briefing ${date} — ${totalSignals} setup${totalSignals!==1?"s":""} (US + EU)`,
    html,
  }, { Authorization: `Bearer ${RESEND_API_KEY}` });
  console.log("Resend response:", JSON.stringify(result));
}

async function runBot() {
  console.log("🤖 Trading bot gestart —", new Date().toLocaleString("nl-BE"));
  console.log("TO_EMAIL:", TO_EMAIL ? "✅" : "❌");
  console.log("FINANCIAL_DATASETS_KEY:", FINANCIAL_DATASETS_KEY ? "✅" : "❌");
  console.log("RESEND_API_KEY:", RESEND_API_KEY ? "✅" : "❌");
  console.log("ANTHROPIC_API_KEY:", ANTHROPIC_API_KEY ? "✅" : "❌");

  const today = new Date().toLocaleDateString("nl-BE", { weekday: "long", day: "numeric", month: "long" });

  console.log("\n📊 SPY ophalen...");
  const spyData = await getUSData("SPY");
  console.log(`SPY: ${spyData ? `$${spyData.close.toFixed(2)} (${spyData.priceChange}%)` : "geen data"}`);
  await sleep(300);

  console.log(`\n🇺🇸 US tickers scannen (${SP500_TICKERS.length} tickers)...`);
  const usAllData = [];
  for (const ticker of SP500_TICKERS) {
    const data = await getUSData(ticker);
    if (data) { usAllData.push(data); process.stdout.write("."); }
    await sleep(300);
  }
  const usCandidates = usAllData.filter(screenTicker);
  console.log(`\n✅ ${usAllData.length} gescand — ${usCandidates.length} US kandidaten`);

  console.log(`\n🇪🇺 Europese tickers scannen (${EU_TICKERS.length} tickers)...`);
  const euAllData = [];
  for (const { ticker, naam, markt } of EU_TICKERS) {
    const data = await getEUData(ticker, naam, markt);
    if (data) { euAllData.push(data); console.log(`  ${naam}: RSI ${data.rsi} | ${data.priceChange}%`); }
    await sleep(500);
  }
  const euCandidates = euAllData.filter(screenTicker);
  console.log(`✅ ${euAllData.length} gescand — ${euCandidates.length} EU kandidaten`);

  console.log(`\n🤖 Claude analyseert ${usCandidates.length + euCandidates.length} kandidaten...`);
  const spyChange = spyData ? spyData.priceChange : null;

  const usResults = [];
  for (const data of usCandidates) {
    const analyse = await analyseWithClaude(data, spyChange);
    if (!analyse) { console.log(`  ⚠️ ${data.ticker}: analyse mislukt`); continue; }
    usResults.push({ data, analyse });
    console.log(`  ${data.ticker}: ${analyse.signaal} (${analyse.sterkte}/10)`);
    await sleep(1000);
  }

  const euResults = [];
  for (const data of euCandidates) {
    const analyse = await analyseWithClaude(data, spyChange);
    if (!analyse) { console.log(`  ⚠️ ${data.naam}: analyse mislukt`); continue; }
    euResults.push({ data, analyse });
    console.log(`  ${data.naam}: ${analyse.signaal} (${analyse.sterkte}/10)`);
    await sleep(1000);
  }

  const totalSignals = [...usResults, ...euResults].filter(r => r.analyse.signaal !== "GEEN SETUP").length;
  console.log(`\n📧 ${totalSignals} setups → email naar ${TO_EMAIL}`);
  const html = buildEmailHTML(usResults, euResults, spyData, today);
  await sendEmail(html, totalSignals, today);
  console.log("✅ Klaar!");
}

runBot().catch(console.error);
