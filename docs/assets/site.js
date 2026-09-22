var SITE_ROOT = new URL("../", document.currentScript.src);
    document.querySelectorAll('[data-js]').forEach(function (element) { element.hidden = false; });
    var STORE_URL = "https://chromewebstore.google.com/detail/jghmghialodmkmbcpfnhkgllkmjafmja";
    ["navInstall", "heroInstall", "finalInstall"].forEach(function (id) { var el = document.getElementById(id); if (el) el.href = STORE_URL; });

    /* ---------------- theme toggle ---------------- */
    document.getElementById("themeToggle").addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", cur);
      try { localStorage.setItem("xporter_theme", cur); } catch (e) {}
    });

    var LANG_NAMES = { en: "English", ru: "Русский", de: "Deutsch", es: "Español", fr: "Français", it: "Italiano", pt_BR: "Português", tr: "Türkçe", id: "Indonesia", ar: "العربية", hi: "हिन्दी", ja: "日本語", ko: "한국어", zh_CN: "中文" };
    var RTL = ["ar"];

    // EN/RU have stable, pre-rendered URLs; other UI languages use explicit query values.
    function pickLang() {
      var query = new URLSearchParams(location.search).get('lang');
      return query && query !== 'en' && query !== 'ru' && I18N[query] ? query : document.documentElement.lang;
    }
    var lang = pickLang();
    function t(k) { return (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k; }
    function applyI18n() {
      document.documentElement.lang = lang.replace("_", "-");
      document.documentElement.dir = RTL.indexOf(lang) >= 0 ? "rtl" : "ltr";
      document.getElementById("languageNote").hidden = lang === "en" || lang === "ru";
      document.querySelectorAll("[data-i18n]").forEach(function (el) { var k = el.getAttribute("data-i18n"); el.textContent = t(k); el.lang = I18N[lang][k] ? lang.replace("_", "-") : "en"; });
      document.querySelectorAll("[data-i18n-html]").forEach(function (el) { var k = el.getAttribute("data-i18n-html"); el.innerHTML = t(k); el.lang = I18N[lang][k] ? lang.replace("_", "-") : "en"; });
    }
    var langSelect = document.getElementById("langSelect");
    langSelect.textContent = "";
    // Same order as the extension's language list.
    var LANG_ORDER = ["en", "zh_CN", "ja", "es", "ko", "ru", "it", "pt_BR", "tr", "de", "ar", "fr", "hi", "id"];
    LANG_ORDER.filter(function (c) { return I18N[c]; }).forEach(function (code) {
      var o = document.createElement("option"); o.value = code; o.textContent = LANG_NAMES[code] || code;
      if (code === lang) o.selected = true; langSelect.appendChild(o);
    });
    langSelect.addEventListener("change", function (e) {
      var code = e.target.value;
      var target = new URL(code === "ru" ? "ru/" : "./", SITE_ROOT);
      if (code !== "en" && code !== "ru") target.searchParams.set("lang", code);
      target.hash = location.hash;
      location.assign(target.href);
    });
    applyI18n();

    /* ---------------- public growth chart ---------------- */
    var growthData = null;
    var growthHorizon = 365;
    var visibleGrowthModels = { linear: false, power: false, gompertz: false };
    var SVG_NS = "http://www.w3.org/2000/svg";

    function growthLocale() { return lang.replace("_", "-"); }
    function formatGrowthNumber(value) { return new Intl.NumberFormat(growthLocale(), { maximumFractionDigits: 0 }).format(value); }
    function formatGrowthDate(value, short) {
      return new Intl.DateTimeFormat(growthLocale(), short ? { month: "short", year: "2-digit", timeZone: "UTC" } : { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(value + "T00:00:00Z"));
    }
    function dayOffsetIso(iso, days) {
      var date = new Date(iso + "T00:00:00Z"); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
    }
    function svgNode(name, attributes, text) {
      var node = document.createElementNS(SVG_NS, name);
      Object.keys(attributes || {}).forEach(function (key) { node.setAttribute(key, attributes[key]); });
      if (text != null) node.textContent = text;
      return node;
    }
    function chartPath(points, xScale, yScale, field) {
      return points.map(function (point, index) { return (index ? "L" : "M") + xScale(point.date).toFixed(2) + " " + yScale(field(point)).toFixed(2); }).join(" ");
    }
    function niceGrowthMax(value) {
      var magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(value, 1))));
      var normalized = value / magnitude;
      var step = normalized <= 2 ? .5 : normalized <= 5 ? 1 : 2;
      return Math.ceil(normalized / step) * step * magnitude;
    }
    function forecastAt(days) {
      var target = dayOffsetIso(growthData.dataThrough, days);
      return growthData.forecast.find(function (point) { return point.date === target; });
    }
    function renderGrowthMethods() {
      var holder = document.getElementById("growthMethods");
      holder.textContent = "";
      growthData.models.forEach(function (model) {
        var method = document.createElement("details"); method.className = "growth-method"; method.setAttribute("name", "forecast-method");
        var summary = document.createElement("summary");
        var copy = document.createElement("div");
        var title = document.createElement("h3"); title.textContent = t("growth_" + model.key);
        var simple = document.createElement("p"); simple.className = "growth-method-simple"; simple.textContent = t("growth_" + model.key + "_simple");
        copy.append(title, simple);
        var chevron = document.createElement("span"); chevron.className = "growth-method-chevron"; chevron.setAttribute("aria-hidden", "true");
        summary.append(copy, chevron);
        var detailBox = document.createElement("div"); detailBox.className = "growth-method-detail";
        var formula = document.createElement("div"); formula.className = "growth-formula"; formula.textContent = model.formula;
        var explanation = document.createElement("p"); explanation.textContent = t("growth_" + model.key + "_detail");
        var stats = document.createElement("p"); stats.className = "growth-method-stats";
        stats.append(t("growth_backtest") + " ");
        var mae = document.createElement("strong"); mae.textContent = formatGrowthNumber(model.backtestMae); stats.append(mae);
        stats.append(" · " + t("growth_users_1y") + " ");
        var one = document.createElement("strong"); one.textContent = formatGrowthNumber(model.usersAtOneYear); stats.append(one);
        stats.append(" · " + t("growth_users_2y") + " ");
        var two = document.createElement("strong"); two.textContent = formatGrowthNumber(model.usersAtTwoYears); stats.append(two);
        detailBox.append(formula, explanation, stats);
        method.append(summary, detailBox); holder.appendChild(method);
      });
    }
    function renderGrowthChart() {
      var svg = document.getElementById("growthChart");
      svg.textContent = "";
      svg.appendChild(svgNode("title", { id: "growthChartTitle" }, t("growth_chart_title")));
      svg.appendChild(svgNode("desc", { id: "growthChartDesc" }, t("growth_actual") + " + " + t("growth_ensemble") + " + " + t("growth_band")));
      var width = 1000, height = 430, left = 66, right = 22, top = 22, bottom = 52;
      var plotWidth = width - left - right, plotHeight = height - top - bottom;
      var history = growthData.history;
      var endIso = dayOffsetIso(growthData.dataThrough, growthHorizon);
      var forecast = growthData.forecast.filter(function (point) { return point.date <= endIso; });
      var startMs = Date.parse(history[0].date + "T00:00:00Z"), endMs = Date.parse(endIso + "T00:00:00Z");
      var maxY = niceGrowthMax(Math.max.apply(null, forecast.map(function (point) { return point.upper; })) * 1.05);
      var xScale = function (iso) { return left + (Date.parse(iso + "T00:00:00Z") - startMs) / (endMs - startMs) * plotWidth; };
      var yScale = function (value) { return top + plotHeight - value / maxY * plotHeight; };

      for (var gridIndex = 0; gridIndex <= 4; gridIndex += 1) {
        var value = maxY * gridIndex / 4, y = yScale(value);
        svg.appendChild(svgNode("line", { x1: left, y1: y, x2: width - right, y2: y, class: "chart-grid" }));
        svg.appendChild(svgNode("text", { x: left - 12, y: y + 4, "text-anchor": "end", class: "chart-axis-label" }, formatGrowthNumber(value)));
      }
      for (var tickIndex = 0; tickIndex <= 4; tickIndex += 1) {
        var tickDate = new Date(startMs + (endMs - startMs) * tickIndex / 4).toISOString().slice(0, 10);
        svg.appendChild(svgNode("text", { x: xScale(tickDate), y: height - 18, "text-anchor": tickIndex === 0 ? "start" : tickIndex === 4 ? "end" : "middle", class: "chart-axis-label" }, formatGrowthDate(tickDate, true)));
      }

      var upperPath = forecast.map(function (point, index) { return (index ? "L" : "M") + xScale(point.date).toFixed(2) + " " + yScale(point.upper).toFixed(2); }).join(" ");
      var lowerPath = forecast.slice().reverse().map(function (point) { return "L" + xScale(point.date).toFixed(2) + " " + yScale(point.lower).toFixed(2); }).join(" ");
      svg.appendChild(svgNode("path", { d: upperPath + " " + lowerPath + " Z", class: "chart-band" }));
      var dividerX = xScale(growthData.dataThrough);
      svg.appendChild(svgNode("line", { x1: dividerX, y1: top, x2: dividerX, y2: top + plotHeight, class: "chart-divider" }));
      svg.appendChild(svgNode("text", { x: dividerX + 8, y: top + 14, class: "chart-axis-label" }, t("growth_forecast_to")));
      svg.appendChild(svgNode("path", { d: chartPath(history, xScale, yScale, function (point) { return point.value; }), class: "chart-history" }));
      svg.appendChild(svgNode("path", { d: chartPath(forecast, xScale, yScale, function (point) { return point.ensemble; }), class: "chart-ensemble" }));
      Object.keys(visibleGrowthModels).forEach(function (key) {
        if (!visibleGrowthModels[key]) return;
        svg.appendChild(svgNode("path", { d: chartPath(forecast, xScale, yScale, function (point) { return point.models[key]; }), class: "chart-model", "data-model": key }));
      });
      svg.appendChild(svgNode("circle", { cx: dividerX, cy: yScale(growthData.latestUsers), r: 5, class: "chart-now-dot" }));
    }
    function renderGrowth() {
      if (!growthData) return;
      var oneYear = forecastAt(365), twoYears = forecastAt(730);
      document.getElementById("growthNow").textContent = formatGrowthNumber(growthData.latestUsers);
      document.getElementById("growthNowDate").textContent = formatGrowthDate(growthData.dataThrough, false);
      document.getElementById("growthYear").textContent = formatGrowthNumber(oneYear.ensemble);
      document.getElementById("growthTwoYear").textContent = formatGrowthNumber(twoYears.ensemble);
      document.getElementById("growthRange").textContent = formatGrowthNumber(twoYears.lower) + "–" + formatGrowthNumber(twoYears.upper);
      document.getElementById("growthChartMeta").textContent = t("growth_first_user") + " " + formatGrowthDate(growthData.firstUserDate, false) + " · " + t("growth_through") + " " + formatGrowthDate(growthData.dataThrough, false) + " · " + t("growth_forecast_to") + " " + formatGrowthDate(dayOffsetIso(growthData.dataThrough, growthHorizon), false);
      renderGrowthMethods(); renderGrowthChart();
    }
    document.querySelectorAll("[data-horizon]").forEach(function (button) {
      button.addEventListener("click", function () {
        growthHorizon = Number(button.getAttribute("data-horizon"));
        document.querySelectorAll("[data-horizon]").forEach(function (candidate) { candidate.setAttribute("aria-pressed", String(candidate === button)); });
        renderGrowth();
      });
    });
    document.querySelectorAll(".model-toggle").forEach(function (button) {
      button.addEventListener("click", function () {
        var key = button.getAttribute("data-model"); visibleGrowthModels[key] = !visibleGrowthModels[key];
        button.setAttribute("aria-pressed", String(visibleGrowthModels[key])); renderGrowthChart();
      });
    });
    function loadGrowth() {
    fetch(new URL("assets/growth-forecast.json", SITE_ROOT))
      .then(function (response) { if (!response.ok) throw new Error("HTTP " + response.status); return response.json(); })
      .then(function (data) { growthData = data; renderGrowth(); document.getElementById("growthInteractive").hidden = false; })
      .catch(function () { document.getElementById("growthChart").style.display = "none"; document.getElementById("growthError").style.display = "block"; });

    }
    if ("IntersectionObserver" in window) {
      var growthObserver = new IntersectionObserver(function (entries) {
        if (entries.some(function (entry) { return entry.isIntersecting; })) {
          growthObserver.disconnect();
          loadGrowth();
        }
      }, { rootMargin: "400px" });
      growthObserver.observe(document.getElementById("growth"));
    } else { loadGrowth(); }
