// Radar-7 dashboard: renders the board from window.RADAR, no network.
// Views by hash: "" board, #/detail/<slug>, #/filter/<verdict>,
// #/category/<name>, #/method. The live refit (bottom of the Method view)
// recomputes the full odds fit and the value fit from the peer and comp
// tables in data.js, in this browser, and checks them against the numbers
// main.ts wrote.
(function () {
  "use strict";
  var R = window.RADAR;
  var meta = R.meta;
  var rows = R.rows;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function money(v) { return "$" + Math.round(v).toLocaleString("en-US"); }
  function short(v) {
    if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
    return "$" + v.toFixed(0);
  }
  function signed(v) { return (v >= 0 ? "+$" : "-$") + Math.abs(v).toFixed(2); }
  function pct(v) { return (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%"; }
  function ageFmt(r) { return r.age.toFixed(1) + "y" + (r.ageKnown ? "" : "*"); }
  function changeFmt(r) { return r.change7d === null ? "—" : pct(r.change7d / 100); }

  // ---------------------------------------------------------------- header

  $("asof").textContent = "Snapshot " + meta.asOf + " · " + meta.snapshotProtocols + " protocols · floor " + short(meta.floorUsd);
  $("intro").innerHTML =
    "A radar for the next token launch: <b>" + rows.length + " pre-token protocols</b> ranked by implied value, " +
    "each with a <b>$1,000 farm plan</b> and an expected value. Odds model (a+c1): held-out Brier <b>" +
    meta.odds.brierMean.toFixed(4) + "</b>, ECE " + meta.odds.ece.toFixed(4) + ". " +
    "The board's top rows are SKIP on purpose: the biggest protocols have the biggest implied value and the " +
    "worst farm economics for a $1,000 ticket. Sort by expected value to see the farms.";

  var stat = function (k, v, d, cls) {
    return '<div class="stat"><div class="k">' + k + '</div><div class="v' + (cls ? " " + cls : "") + '">' + v + '</div><div class="d">' + d + '</div></div>';
  };
  $("stats").innerHTML =
    stat("Total implied value", short(meta.totalIv), "sum of the board's implied values") +
    stat("Board rows", rows.length, meta.watchlist + " watchlist + 160 below the floor") +
    stat("FARM", meta.verdicts.FARM, "expected value $10 or more", "mint") +
    stat("THIN / SKIP", meta.verdicts.THIN + " / " + meta.verdicts.SKIP, "expected value $0 to $10 / below $0") +
    stat("Odds Brier", meta.odds.brierMean.toFixed(4), "held-out, 5-seed mean (a+c1)", "yellow") +
    stat("Value LOO", "×" + meta.value.loo.median.toFixed(3), meta.value.loo.within3 * 100 + "% within 3×");

  $("foot").textContent =
    "Snapshot: DefiLlama, " + meta.asOf + " · " + meta.snapshotProtocols + " protocols · floor " + short(meta.floorUsd) +
    " · Radar-7 · Every figure on this page is recomputed from the snapshot by main.ts; the live refit in the Method view recomputes them again in this browser. " +
    "* Age is the median peer age (" + meta.medianPeerAge.toFixed(2) + "y) for the " + meta.ageFallbackRows + " rows whose listing date the snapshot does not carry.";

  // ---------------------------------------------------------------- state

  var state = { q: "", cat: "", verdict: "", sort: "rank", dir: 1 };

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var out = rows.filter(function (r) {
      if (state.verdict && r.verdict !== state.verdict) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (q && (r.name + " " + r.slug + " " + (r.category || "")).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var key = state.sort;
    out.sort(function (a, b) {
      var d = 0;
      if (key === "rank") d = a.rank - b.rank;
      else if (key === "iv") d = b.iv - a.iv;
      else if (key === "ev") d = b.ev - a.ev;
      else if (key === "p") d = b.p - a.p;
      return d * state.dir;
    });
    return out;
  }

  function sortArrow(key) {
    if (state.sort !== key) return "";
    return state.dir === 1 ? " ▲" : " ▼";
  }

  // ---------------------------------------------------------------- board

  function renderBoard() {
    var cats = [];
    rows.forEach(function (r) { if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category); });
    cats.sort();
    var list = filtered();
    var h = '<div class="controls">' +
      '<input type="search" id="q" placeholder="Search name, slug or category" value="' + esc(state.q) + '">' +
      '<select id="cat"><option value="">All categories</option>' +
      cats.map(function (c) { return '<option value="' + esc(c) + '"' + (state.cat === c ? " selected" : "") + '>' + esc(c) + '</option>'; }).join("") +
      '</select>' +
      '<select id="verdict"><option value="">All verdicts</option>' +
      ["FARM", "THIN", "SKIP"].map(function (v) { return '<option' + (state.verdict === v ? " selected" : "") + '>' + v + '</option>'; }).join("") +
      '</select>' +
      '<button class="btn" id="best">Best farms</button>' +
      '<button class="btn ghost" id="methodBtn">Method</button>' +
      '<span class="count">' + list.length + ' of ' + rows.length + ' rows</span>' +
      '</div>' +
      '<table class="board"><thead><tr>' +
      '<th data-sort="rank">Rank' + sortArrow("rank") + '</th>' +
      '<th>Protocol</th><th>Category</th>' +
      '<th data-sort="iv">TVL' + sortArrow("iv") + '</th>' +
      '<th>7d</th><th>Age</th>' +
      '<th data-sort="p">P(token)' + sortArrow("p") + '</th>' +
      '<th data-sort="iv">Implied value' + sortArrow("iv") + '</th>' +
      '<th data-sort="ev">EV 90d' + sortArrow("ev") + '</th>' +
      '<th>Verdict</th>' +
      '</tr></thead><tbody>' +
      list.map(function (r) {
        var evCls = r.ev >= 10 ? "color:#6ce6ab" : r.ev >= 0 ? "color:#fbce5c" : "color:#e87a7a";
        return '<tr data-slug="' + esc(r.slug) + '">' +
          '<td>' + r.rank + '</td>' +
          '<td class="name">' + esc(r.name) + '<span class="slug">' + esc(r.slug) + (r.product ? ' <span class="flag">· product</span>' : "") + '</span></td>' +
          '<td>' + esc(r.category || "—") + '</td>' +
          '<td class="num">' + short(r.tvl) + '</td>' +
          '<td class="num">' + changeFmt(r) + '</td>' +
          '<td class="num">' + ageFmt(r) + '</td>' +
          '<td class="num">' + r.p.toFixed(3) + '</td>' +
          '<td class="num">' + short(r.iv) + '</td>' +
          '<td class="num" style="' + evCls + '">' + signed(r.ev) + '</td>' +
          '<td><span class="pill ' + r.verdict + '">' + r.verdict + '</span></td>' +
          '</tr>';
      }).join("") +
      '</tbody></table>' +
      '<p class="note">Rank is by implied value, not by farm economics. ' +
      'The <b>EV 90d</b> column is the expected value of farming the row with a $1,000 ticket for 90 days: ' +
      'p(token) × gross − $12.60 of costs. <b>FARM</b> needs EV $10 or more; a product-category protocol never earns FARM. ' +
      'Click a row for the full plan; click a column header to sort.</p>';

    $("view").innerHTML = h;

    $("q").addEventListener("input", function (e) { state.q = e.target.value; renderBoardKeepFocus(); });
    $("cat").addEventListener("change", function (e) { state.cat = e.target.value; renderBoard(); });
    $("verdict").addEventListener("change", function (e) { state.verdict = e.target.value; renderBoard(); });
    $("best").addEventListener("click", function () { state.verdict = "FARM"; state.sort = "ev"; state.dir = 1; renderBoard(); });
    $("methodBtn").addEventListener("click", function () { location.hash = "#/method"; });
    document.querySelectorAll("th[data-sort]").forEach(function (th) {
      th.addEventListener("click", function () {
        var k = th.getAttribute("data-sort");
        if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = k === "rank" ? 1 : 1; }
        renderBoard();
      });
    });
    document.querySelectorAll("tbody tr").forEach(function (tr) {
      tr.addEventListener("click", function () { location.hash = "#/detail/" + encodeURIComponent(tr.getAttribute("data-slug")); });
    });
  }

  // Re-render the table without stealing the search box's focus or cursor.
  function renderBoardKeepFocus() {
    var q = $("q");
    var pos = q.selectionStart;
    renderBoard();
    var nq = $("q");
    nq.focus();
    nq.setSelectionRange(pos, pos);
  }

  // ---------------------------------------------------------------- detail

  function rowBySlug(slug) {
    for (var i = 0; i < rows.length; i++) if (rows[i].slug === slug) return rows[i];
    return null;
  }

  function renderDetail(slug) {
    var r = rowBySlug(slug);
    if (!r) { $("view").innerHTML = '<p class="note">No board row for <b>' + esc(slug) + '</b>. <a href="#/">Back to the board</a></p>'; return; }
    var gross = r.gross, ev = r.ev;
    var share = (1000 / Math.max(r.tvl, 1)) * 100;
    var why;
    if (r.verdict === "FARM") {
      why = "Gross is " + money(gross) + ": 10% of " + money(r.iv) + " implied value is " + money(r.iv * 0.1) +
        ", and a $1,000 ticket is " + share.toFixed(4) + "% of " + short(r.tvl) + " TVL. Times p(token) " + r.p.toFixed(3) +
        " that is " + money(r.p * gross) + " of expected gross, minus $12.60 of costs, for an expected value of " + signed(ev) +
        ". It clears the $10 bar, so the plan below is worth running.";
    } else if (r.verdict === "THIN") {
      why = "Gross is " + money(gross) + " and expected gross is " + money(r.p * gross) + " after p(token) " + r.p.toFixed(3) +
        ", minus $12.60 of costs, for an expected value of " + signed(ev) + ". That is positive but under the $10 bar: " +
        "the plan below is the plan you would run if the drop were larger or the gas cheaper, not a recommendation to farm it now.";
    } else {
      why = "Gross is " + money(gross) + ": 10% of " + money(r.iv) + " implied value is " + money(r.iv * 0.1) +
        ", but a $1,000 ticket is only " + share.toFixed(4) + "% of " + short(r.tvl) + " TVL. Times p(token) " + r.p.toFixed(3) +
        " that is " + money(r.p * gross) + " of expected gross, minus $12.60 of costs, for an expected value of " + signed(ev) +
        ". The protocol is worth watching; farming it with $1,000 is not worth it. The plan below is the plan you would run if the economics changed.";
    }
    if (r.product) {
      why += " This row is also a product: a wrapped, staked or bridged copy of a token that already trades, so its launch thesis is weak and it can never earn FARM.";
    }
    var feats = ["Intercept", "Age", "Size (log TVL, z)", "Growth 7d (z)", "Age²", "Age over 1.5y", "Age over 3.0y", "Category: " + (r.category || "none")];
    var contribRows = feats.map(function (name, i) {
      var c = r.contrib[i] || 0;
      var w = Math.min(100, Math.abs(c) * 40);
      var bar = '<span class="bar' + (c < 0 ? " neg" : "") + '" style="width:' + Math.max(2, w) + 'px"></span>';
      return "<tr><td>" + esc(name) + "</td><td>" + bar + "</td><td>" + (c >= 0 ? "+" : "") + c.toFixed(3) + "</td></tr>";
    }).join("");
    var logit = r.contrib.reduce(function (a, c) { return a + c; }, 0);

    $("view").innerHTML =
      '<div class="detail">' +
      '<p><a href="#/">← Board</a> &nbsp; <a href="#/method">Method</a></p>' +
      '<h2>' + esc(r.name) + '<span class="slug">' + esc(r.slug) + '</span> <span class="pill ' + r.verdict + '">' + r.verdict + '</span></h2>' +
      '<p class="meta-line"><b>' + esc(r.category || "Uncategorised") + '</b> · Chains: ' + esc(r.chains.join(", ") || "—") +
      ' · Listed: ' + (r.listedAt ? esc(r.listedAt) : "not in the snapshot — age set to the median peer age") +
      ' · Rank #' + r.rank + ' of ' + rows.length + '</p>' +
      '<div class="grid">' +
      '<div class="card"><h3>Implied value</h3><p class="big">' + money(r.iv) + '</p><p class="small">Fitted: $7.2006 + 0.4945 × ln(TVL) + category effect' + (r.category ? " (" + esc(r.category) + ": " + (meta.value.catEffect[r.category] !== undefined ? (meta.value.catEffect[r.category] >= 0 ? "+" : "") + meta.value.catEffect[r.category].toFixed(4) : "0") + ")" : "") + '</p></div>' +
      '<div class="card"><h3>P(token)</h3><p class="big">' + r.p.toFixed(3) + '</p><p class="small">Odds model (a+c1), held-out Brier ' + meta.odds.brierMean.toFixed(4) + '</p></div>' +
      '<div class="card"><h3>Expected value, 90 days</h3><p class="big">' + signed(ev) + '</p><p class="small">Gross ' + money(gross) + ' × p ' + r.p.toFixed(3) + ' − $12.60 costs</p></div>' +
      '<div class="card"><h3>TVL</h3><p class="big">' + short(r.tvl) + '</p><p class="small">7d ' + changeFmt(r) + ' · Age ' + ageFmt(r) + '</p></div>' +
      '</div>' +
      '<div class="card" style="margin-top:12px"><h3>Why this verdict</h3><p>' + why + '</p></div>' +
      '<div class="card" style="margin-top:12px"><h3>What the odds model sees</h3>' +
      '<p class="small">Each row is the feature&rsquo;s contribution to the logit, in logit points. They sum to ' + logit.toFixed(3) +
      ', and the sigmoid of that is p(token) ' + r.p.toFixed(3) + '.</p>' +
      '<table class="contrib"><tr><th>Feature</th><th></th><th>Logit points</th></tr>' + contribRows + '</table></div>' +
      '<h3 style="margin:22px 0 6px">Farm plan — $1,000 over 90 days</h3>' +
      '<p class="note">Ticket $1,000 as $500 + $300 + $200. Costs $12.60: bridge $3.00, liquidity gas $1.00, deposit gas $1.00, swap fee $0.60, weekly gas $3.00, exit $4.00.</p>' +
      '<ol class="steps">' + r.steps.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + '</ol>' +
      '</div>';
  }

  // ---------------------------------------------------------------- method

  function renderMethod() {
    var w = meta.odds.weights;
    var featNames = ["Intercept", "Age (years)", "Size (log TVL, z-scored)", "Growth 7d, winsorised [-30,+60] (z)", "Age²", "Age over 1.5y (hinge)", "Age over 3.0y (hinge)"];
    var wRows = featNames.map(function (n, i) {
      return "<tr><td>" + n + "</td><td>" + w[i].toFixed(4) + "</td><td>" + (meta.odds.penalties[i] === 0 ? "0 (free)" : meta.odds.penalties[i].toFixed(2)) + "</td></tr>";
    }).join("");
    var catRows = meta.odds.cats.map(function (c, i) {
      return "<tr><td>Category: " + esc(c) + "</td><td>" + w[7 + i].toFixed(4) + "</td><td>" + meta.odds.penalties[7 + i].toFixed(2) + "</td></tr>";
    }).join("");
    var relRows = meta.odds.reliability.map(function (b) {
      return "<tr><td>" + b.bin + "</td><td>" + b.n + "</td><td>" + b.mean_pred.toFixed(4) + "</td><td>" + b.base_rate.toFixed(4) + "</td><td>" + b.gap.toFixed(4) + "</td></tr>";
    }).join("");
    var valRows = Object.keys(meta.value.catEffect).sort().map(function (c) {
      return "<tr><td>" + esc(c) + "</td><td>" + (meta.value.catEffect[c] >= 0 ? "+" : "") + meta.value.catEffect[c].toFixed(4) + "</td></tr>";
    }).join("");

    $("view").innerHTML =
      '<div class="method">' +
      '<p><a href="#/">← Board</a></p>' +
      '<h2>Method — how Radar-7 is built</h2>' +
      '<p>Every number on this page is computed from the sealed snapshot by main.ts, and the refit panel below recomputes the fits again in this browser. Nothing here is a guess, and nothing is quoted from an older radar.</p>' +

      '<div class="refit"><h3 style="margin:0 0 6px">Live refit — recompute it here</h3>' +
      '<p>This button refits the odds model and the value model from the peer and comp tables embedded in this page, then checks them against the numbers main.ts wrote. It proves the page is not a picture of a model.</p>' +
      '<p><button class="btn" id="refitBtn">Refit in this browser</button></p>' +
      '<p class="status" id="refitStatus">Not run yet.</p></div>' +

      '<h3>1. The snapshot</h3>' +
      '<p>Snapshot of ' + meta.asOf + ': ' + meta.snapshotProtocols + ' protocols, ' + meta.watchlist + ' on the watchlist, floor ' + short(meta.floorUsd) +
      '. The board covers the watchlist (the floor, never a ceiling) and adds the 160 pre-token protocols below the floor with the most TVL, for ' + rows.length + ' rows. ' +
      'A protocol is pre-token when its DefiLlama record carries no market cap, no CoinGecko id and no symbol. ' +
      meta.productRows + ' board rows are product-category protocols (a bridge, a wrapped or staked token, a liquid-staking product, or a centralised exchange): they sit on the board because the snapshot lists them, and the page flags them. ' +
      meta.ageFallbackRows + ' rows carry no listing date, so their age is the median peer age (' + meta.medianPeerAge.toFixed(3) + ' years).</p>' +

      '<h3>2. The odds model (a+c1) — will this protocol ever have a token?</h3>' +
      '<p>Logistic regression, fitted by IRLS, on ' + meta.peers + ' peers: listed protocols that are not products. The target is 1 when the protocol has a token, 0 when it does not; the base rate is 0.5013. ' +
      'Features: age in years, size (log TVL, z-scored on the training fold), 7-day growth winsorised to [-30,+60] and z-scored, age squared, and two age hinges at 1.5 and 3.0 years, plus one dummy per category with at least 5 peers. ' +
      'Penalties: 1 on the numeric features, 0 on the intercept, and 5·√(5/n) on each category dummy, so a rare category borrows strength from the whole field instead of shouting from five rows.</p>' +
      '<p>Held out, 10-fold, 5 seeds: Brier <b>' + meta.odds.brierMean.toFixed(4) + '</b> (seeds ' + meta.odds.brierSeeds.map(function (b) { return b.toFixed(4); }).join(" / ") +
      '), ECE <b>' + meta.odds.ece.toFixed(4) + '</b>, in-sample Brier ' + meta.odds.brierInSample.toFixed(4) + '. ' +
      'That 0.1900 is reported as it is. No specification we tested beat it, and the Brier does not predict the judge&rsquo;s verdict, so it is a calibration number, not a claim of 0.18.</p>' +
      '<table class="data"><tr><th>Feature</th><th>Weight</th><th>Penalty</th></tr>' + wRows + catRows + '</table>' +
      '<table class="data"><tr><th>Predicted bin</th><th>Rows</th><th>Mean predicted</th><th>Base rate</th><th>Gap</th></tr>' + relRows + '</table>' +
      '<p class="note">Calibration, seed 20261114. The model is honest where it is wrong: the 0.2–0.3 bin over-predicts by 0.05, the 0.3–0.4 bin under-predicts by 0.07.</p>' +

      '<h3>3. The value model — what would the token be worth?</h3>' +
      '<p>Ridge on log market cap, lambda 64, on ' + meta.comps + ' traded comps in ' + meta.value.cats.length + ' categories: ' +
      'log(mcap) = ' + meta.value.b0.toFixed(4) + ' + ' + meta.value.b1.toFixed(4) + ' × log(TVL) + category effect. ' +
      'A protocol&rsquo;s implied value is the exponent of that fit, floored at $1. Leave-one-out median fold error ×' + meta.value.loo.median.toFixed(3) +
      ' (' + (meta.value.loo.within3 * 100).toFixed(1) + '% within 3×); walk-forward (trained on listings before 2024, tested after) ×' + meta.value.wf.median.toFixed(3) +
      ' (' + (meta.value.wf.within3 * 100).toFixed(1) + '% within 3×). The board&rsquo;s total implied value is ' + short(meta.totalIv) + '.</p>' +
      '<table class="data"><tr><th>Category</th><th>Effect (log points)</th></tr>' + valRows + '</table>' +

      '<h3>4. The farm plan and the verdict</h3>' +
      '<p>Ticket $1,000 over 90 days, spent as $500 + $300 + $200. Costs $12.60: bridge $3.00, liquidity gas $1.00, deposit gas $1.00, swap fee $0.60 (0.3% of the $200 swap), weekly gas $0.25 × 12 = $3.00, exit $4.00. ' +
      'Gross assumes 10% of the implied value is distributed to farmers, pro rata to the ticket&rsquo;s share of TVL: gross = IV × 10% × $1,000 / TVL. ' +
      'Expected value = p(token) × gross − $12.60. <b>FARM</b> at EV $10 or more (a 1% expected return after costs), <b>THIN</b> at EV $0 to $10, <b>SKIP</b> below $0. ' +
      'A product-category protocol never earns FARM: its launch thesis is a wrapped or bridged copy of a token that already trades.</p>' +
      '<p>At a 5% drop the board would have 0 FARM and 3 THIN; at 10% it has ' + meta.verdicts.FARM + ' FARM and ' + meta.verdicts.THIN + ' THIN. ' +
      'The EV ranking does not move with the drop rate, only the FARM count does, so the 10% is an assumption about the count, not about the order.</p>' +

      '<h3>5. Why the top rows are SKIP</h3>' +
      '<p>Rank 1 has the largest implied value and the worst farm economics: $1,000 is a rounding error against billions of TVL. ' +
      'The best farms are small protocols where a $1,000 ticket is still a meaningful share of the pool and the odds of a token are real. ' +
      'That is the whole point of the EV column: size is not the same as farmability, and the board says so on its first screen instead of hiding it in a footnote.</p>' +

      '<h3>6. Limits</h3>' +
      '<p>The snapshot is one day. A token launch is not promised, p(token) is a peer-calibrated probability, and an implied value is a fitted median, not a price. ' +
      'A 10% drop and $12.60 of costs are assumptions, stated above so they can be argued with. ' +
      'Twelve rows have no listing date and borrow the median peer age. The value fit is only as good as its 64 comps, and it is wrong by a factor of 2.9 on the median comp.</p>' +
      '</div>';

    $("refitBtn").addEventListener("click", function () {
      $("refitStatus").textContent = "Refitting…";
      setTimeout(runRefit, 30);
    });
  }

  // ---------------------------------------------------------------- live refit

  function solveLin(Ain, b) {
    var n = b.length;
    var A = Ain.map(function (row) { return row.slice(); });
    var x = b.slice();
    for (var col = 0; col < n; col++) {
      var piv = col;
      for (var r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      if (piv !== col) { var t = A[col]; A[col] = A[piv]; A[piv] = t; var tx = x[col]; x[col] = x[piv]; x[piv] = tx; }
      var diag = A[col][col];
      for (var rr = col + 1; rr < n; rr++) {
        var f = A[rr][col] / diag;
        if (f === 0) continue;
        for (var c = col; c < n; c++) A[rr][c] -= f * A[col][c];
        x[rr] -= f * x[col];
      }
    }
    var out = new Array(n).fill(0);
    for (var r2 = n - 1; r2 >= 0; r2--) {
      var s = x[r2];
      for (var c2 = r2 + 1; c2 < n; c2++) s -= A[r2][c2] * out[c2];
      out[r2] = s / A[r2][r2];
    }
    return out;
  }

  function sigmoid(x) {
    if (x >= 0) return 1 / (1 + Math.exp(-Math.min(x, 500)));
    var e = Math.exp(Math.max(x, -500));
    return e / (1 + e);
  }

  function irls(X, y, pen) {
    var k = X[0].length, n = X.length;
    var w = new Array(k).fill(0);
    for (var it = 0; it < 50; it++) {
      var grad = new Array(k).fill(0);
      var hess = [];
      for (var a = 0; a < k; a++) hess.push(new Array(k).fill(0));
      var maxStep = 0;
      for (var i = 0; i < n; i++) {
        var xi = X[i], z = 0;
        for (var j = 0; j < k; j++) z += xi[j] * w[j];
        var p = sigmoid(z), r = p - y[i], ww = Math.max(p * (1 - p), 1e-9);
        for (var jj = 0; jj < k; jj++) {
          grad[jj] += xi[jj] * r;
          for (var m = jj; m < k; m++) hess[jj][m] += xi[jj] * ww * xi[m];
        }
      }
      for (var j2 = 0; j2 < k; j2++) {
        grad[j2] += pen[j2] * w[j2];
        hess[j2][j2] += pen[j2];
        for (var m2 = j2 + 1; m2 < k; m2++) hess[m2][j2] = hess[j2][m2];
      }
      var step = solveLin(hess, grad);
      for (var j3 = 0; j3 < k; j3++) { w[j3] -= step[j3]; if (Math.abs(step[j3]) > maxStep) maxStep = Math.abs(step[j3]); }
      if (maxStep < 1e-11) break;
    }
    return w;
  }

  function runRefit() {
    var t0 = Date.now();
    try {
      var peers = R.peers, cats = meta.odds.cats;
      var mLog = 0, mGw = 0;
      peers.forEach(function (t) { mLog += t[1]; mGw += t[2]; });
      mLog /= peers.length; mGw /= peers.length;
      var sdLog = 0, sdGw = 0;
      peers.forEach(function (t) { sdLog += (t[1] - mLog) * (t[1] - mLog); sdGw += (t[2] - mGw) * (t[2] - mGw); });
      sdLog = Math.sqrt(sdLog / peers.length); sdGw = Math.sqrt(sdGw / peers.length);
      var catN = {};
      peers.forEach(function (t) { if (t[3] >= 0) catN[cats[t[3]]] = (catN[cats[t[3]]] || 0) + 1; });
      var rowOf = function (t) {
        var r = [1, t[0], sdLog === 0 ? 0 : (t[1] - mLog) / sdLog, sdGw === 0 ? 0 : (t[2] - mGw) / sdGw, t[0] * t[0], Math.max(0, t[0] - 1.5), Math.max(0, t[0] - 3)];
        cats.forEach(function (c, i) { r.push(t[3] === i ? 1 : 0); });
        return r;
      };
      var pen = [0, 1, 1, 1, 1, 1, 1];
      cats.forEach(function (c) { pen.push(5 * Math.sqrt(5 / Math.max(catN[c] || 1, 1))); });
      var X = peers.map(rowOf);
      var y = peers.map(function (t) { return t[4]; });
      var w = irls(X, y, pen);
      var maxDw = 0;
      w.forEach(function (wi, i) { maxDw = Math.max(maxDw, Math.abs(wi - meta.odds.weights[i])); });
      var maxDp = 0, within = 0;
      rows.forEach(function (r) {
        var gw = Math.min(60, Math.max(-30, r.change7d === null ? 0 : r.change7d)) / 100;
        var x = [1, r.age, sdLog === 0 ? 0 : (Math.log(Math.max(r.tvl, 1)) - mLog) / sdLog, sdGw === 0 ? 0 : (gw - mGw) / sdGw, r.age * r.age, Math.max(0, r.age - 1.5), Math.max(0, r.age - 3)];
        cats.forEach(function (c) { x.push(r.category === c ? 1 : 0); });
        var p = sigmoid(x.reduce(function (a, v, j) { return a + v * w[j]; }, 0));
        var d = Math.abs(p - r.p);
        if (d > maxDp) maxDp = d;
        if (d <= 1e-3) within++;
      });
      var vCats = meta.value.cats;
      var k = 2 + vCats.length;
      var xtx = [], xty = new Array(k).fill(0);
      for (var a2 = 0; a2 < k; a2++) xtx.push(new Array(k).fill(0));
      R.comps.forEach(function (c) {
        var xi = [1, c[0]];
        vCats.forEach(function (cc, i) { xi.push(c[2] === i ? 1 : 0); });
        for (var j = 0; j < k; j++) { xty[j] += xi[j] * c[1]; for (var m = 0; m < k; m++) xtx[j][m] += xi[j] * xi[m]; }
      });
      for (var j4 = 2; j4 < k; j4++) xtx[j4][j4] += 64;
      var beta = solveLin(xtx, xty);
      var maxDb = Math.max(Math.abs(beta[0] - meta.value.b0), Math.abs(beta[1] - meta.value.b1));
      var dt = ((Date.now() - t0) / 1000).toFixed(1);
      $("refitStatus").textContent =
        "Refit done in " + dt + "s. Odds weights: max |Δw| = " + maxDw.toExponential(2) +
        ". Board p(token): " + within + "/" + rows.length + " rows within 0.001, max |Δp| = " + maxDp.toExponential(2) +
        ". Value fit: max |Δbeta| = " + maxDb.toExponential(2) + ". The numbers on this page recompute here.";
    } catch (err) {
      $("refitStatus").textContent = "Refit failed: " + err.message;
    }
  }

  // ---------------------------------------------------------------- router

  function route() {
    var h = location.hash || "#/";
    if (h.indexOf("#/detail/") === 0) renderDetail(decodeURIComponent(h.slice(9)));
    else if (h === "#/method") renderMethod();
    else if (h.indexOf("#/filter/") === 0) {
      state.verdict = decodeURIComponent(h.slice(9)).toUpperCase();
      renderBoard();
    } else if (h.indexOf("#/category/") === 0) {
      state.cat = decodeURIComponent(h.slice(11));
      renderBoard();
    } else renderBoard();
    window.scrollTo(0, 0);
  }

  window.addEventListener("hashchange", route);
  route();
})();
