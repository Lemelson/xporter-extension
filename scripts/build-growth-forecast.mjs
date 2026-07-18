#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const DAY_MS = 86_400_000;
const FORECAST_DAYS = 730;
const HOLDOUTS = [30, 60, 90];

function usage() {
  console.error("Usage: node scripts/build-growth-forecast.mjs <chrome-web-store.csv> [output.json]");
  process.exit(1);
}

function parseDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) throw new Error(`Invalid date: ${value}`);
  return new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function linearRegression(xs, ys) {
  const xMean = mean(xs);
  const yMean = mean(ys);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < xs.length; i += 1) {
    numerator += (xs[i] - xMean) * (ys[i] - yMean);
    denominator += (xs[i] - xMean) ** 2;
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;
  return { intercept: yMean - slope * xMean, slope };
}

function mae(actual, predicted) {
  return mean(actual.map((value, index) => Math.abs(value - predicted[index])));
}

function smape(actual, predicted) {
  return mean(actual.map((value, index) => {
    const denominator = Math.abs(value) + Math.abs(predicted[index]);
    return denominator === 0 ? 0 : (2 * Math.abs(value - predicted[index])) / denominator;
  })) * 100;
}

function fitLinear(points) {
  const xs = points.map((_, index) => index);
  const ys = points.map((point) => point.value);
  const { slope } = linearRegression(xs, ys);
  const lastIndex = points.length - 1;
  const lastValue = ys[lastIndex];
  return {
    key: "linear",
    label: "Linear trend",
    formula: "ŷ(t+h) = yₜ + βh",
    parameters: { dailySlope: slope },
    predict(index) {
      return Math.max(0, lastValue + slope * (index - lastIndex));
    },
  };
}

function fitPower(points) {
  const ys = points.map((point) => point.value);
  const lastIndex = points.length - 1;
  const shifts = [1, 2, 4, 7, 14, 30, 60, 90, 120, 180, 270, 365, 540, 730];
  let best = null;

  for (const shift of shifts) {
    const xs = points.map((_, index) => Math.log(index + shift));
    const logs = ys.map((value) => Math.log(Math.max(value, 0.5)));
    const regression = linearRegression(xs, logs);
    if (regression.slope <= 0) continue;
    const raw = points.map((_, index) => Math.exp(regression.intercept) * (index + shift) ** regression.slope);
    const error = mae(ys, raw);
    if (!best || error < best.error) best = { ...regression, shift, error };
  }

  if (!best) throw new Error("Power-law fit failed");
  const lastRaw = Math.exp(best.intercept) * (lastIndex + best.shift) ** best.slope;
  const scale = ys[lastIndex] / lastRaw;
  return {
    key: "power",
    label: "Power curve",
    formula: "ŷ(t) = a(t+c)ᵇ",
    parameters: { exponent: best.slope, shiftDays: best.shift },
    predict(index) {
      return Math.max(0, scale * Math.exp(best.intercept) * (index + best.shift) ** best.slope);
    },
  };
}

function fitGompertz(points) {
  const ys = points.map((point) => point.value);
  const xs = points.map((_, index) => index);
  const maxValue = Math.max(...ys);
  const lastIndex = points.length - 1;
  let best = null;

  for (let step = 0; step <= 240; step += 1) {
    const ratio = 1.05 * (60 / 1.05) ** (step / 240);
    const carryingCapacity = maxValue * ratio;
    const transformed = ys.map((value) => Math.log(-Math.log(Math.max(value, 0.5) / carryingCapacity)));
    const regression = linearRegression(xs, transformed);
    if (regression.slope >= 0) continue;
    const raw = xs.map((index) => carryingCapacity * Math.exp(-Math.exp(regression.intercept + regression.slope * index)));
    const error = mae(ys, raw);
    if (!best || error < best.error) best = { ...regression, carryingCapacity, error };
  }

  if (!best) throw new Error("Gompertz fit failed");
  const rawAtLast = best.carryingCapacity * Math.exp(-Math.exp(best.intercept + best.slope * lastIndex));
  const scale = ys[lastIndex] / rawAtLast;
  return {
    key: "gompertz",
    label: "Gompertz S-curve",
    formula: "ŷ(t) = K·exp(−exp(a−bt))",
    parameters: { carryingCapacity: best.carryingCapacity * scale, growthRate: -best.slope },
    predict(index) {
      return Math.max(0, scale * best.carryingCapacity * Math.exp(-Math.exp(best.intercept + best.slope * index)));
    },
  };
}

const MODEL_FITTERS = [fitLinear, fitPower, fitGompertz];

function parseCsv(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim() === "Date,Weekly users");
  if (headerIndex < 0) throw new Error("Expected Date,Weekly users header");
  const rows = lines.slice(headerIndex + 1).map((line) => {
    const [date, rawValue] = line.split(",");
    const value = Number(rawValue);
    if (!date || !Number.isFinite(value)) throw new Error(`Invalid CSV row: ${line}`);
    return { date: parseDate(date), value };
  });
  const firstPositive = rows.findIndex((point) => point.value > 0);
  if (firstPositive < 0) throw new Error("The CSV contains no positive user counts");
  return { all: rows, observed: rows.slice(firstPositive) };
}

function backtest(points) {
  const results = Object.fromEntries(MODEL_FITTERS.map((fit) => [fit(points).key, { actual: [], predicted: [] }]));
  for (const holdout of HOLDOUTS) {
    if (points.length - holdout < 30) continue;
    const train = points.slice(0, -holdout);
    const test = points.slice(-holdout);
    for (const fit of MODEL_FITTERS) {
      const model = fit(train);
      const bucket = results[model.key];
      test.forEach((point, offset) => {
        bucket.actual.push(point.value);
        bucket.predicted.push(model.predict(train.length + offset));
      });
    }
  }
  return Object.fromEntries(Object.entries(results).map(([key, result]) => [key, {
    mae: mae(result.actual, result.predicted),
    smape: smape(result.actual, result.predicted),
    predictions: result.predicted.length,
  }]));
}

function rounded(value, digits = 0) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) usage();
  const outputPath = process.argv[3] || path.resolve("docs/assets/growth-forecast.json");
  const { all, observed } = parseCsv(inputPath);
  const models = MODEL_FITTERS.map((fit) => fit(observed));
  const tests = backtest(observed);
  const inverseErrors = models.map((model) => 1 / Math.max(tests[model.key].mae, 0.001) ** 2);
  const errorTotal = inverseErrors.reduce((sum, value) => sum + value, 0);
  const weights = Object.fromEntries(models.map((model, index) => [model.key, inverseErrors[index] / errorTotal]));
  const lastDate = observed.at(-1).date;
  const lastIndex = observed.length - 1;
  const forecast = [];

  const forecastDays = new Set([0, 365, FORECAST_DAYS]);
  for (let day = 0; day <= FORECAST_DAYS; day += 7) forecastDays.add(day);
  for (const day of [...forecastDays].sort((left, right) => left - right)) {
    const index = lastIndex + day;
    const values = Object.fromEntries(models.map((model) => [model.key, model.predict(index)]));
    const ensemble = models.reduce((sum, model) => sum + weights[model.key] * values[model.key], 0);
    forecast.push({
      date: isoDate(addDays(lastDate, day)),
      ensemble: rounded(ensemble),
      lower: rounded(Math.min(...Object.values(values))),
      upper: rounded(Math.max(...Object.values(values))),
      models: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, rounded(value)])),
    });
  }
  const output = {
    schemaVersion: 1,
    metric: "Chrome Web Store weekly users",
    source: "Chrome Web Store developer dashboard export",
    generatedFrom: path.basename(inputPath),
    dataThrough: isoDate(lastDate),
    seriesBegins: isoDate(all[0].date),
    firstUserDate: isoDate(observed[0].date),
    latestUsers: observed.at(-1).value,
    observedDays: observed.length,
    zeroDaysBeforeFirstUser: all.length - observed.length,
    history: observed.map((point) => ({ date: isoDate(point.date), value: point.value })),
    forecast,
    models: models.map((model) => ({
      key: model.key,
      label: model.label,
      formula: model.formula,
      weight: rounded(weights[model.key], 4),
      backtestMae: rounded(tests[model.key].mae, 1),
      backtestSmape: rounded(tests[model.key].smape, 1),
      parameters: Object.fromEntries(Object.entries(model.parameters).map(([key, value]) => [key, rounded(value, 4)])),
      usersAtOneYear: rounded(model.predict(lastIndex + 365)),
      usersAtTwoYears: rounded(model.predict(lastIndex + 730)),
    })),
    method: {
      ensemble: "Inverse-squared-MAE weighted ensemble",
      validation: "Rolling-origin holdouts of 30, 60 and 90 days",
      interval: "Scenario envelope: minimum and maximum of the three model forecasts",
      caveat: "A scenario range, not a confidence interval. Long-range extension growth depends on product, distribution and Chrome Web Store conditions that this time series cannot observe.",
    },
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({
    outputPath,
    dataThrough: output.dataThrough,
    latestUsers: output.latestUsers,
    observedDays: output.observedDays,
    models: output.models,
    ensembleAtOneYear: output.forecast.find((point) => point.date === isoDate(addDays(lastDate, 365)))?.ensemble,
    ensembleAtTwoYears: output.forecast.at(-1).ensemble,
    rangeAtTwoYears: [output.forecast.at(-1).lower, output.forecast.at(-1).upper],
  }, null, 2));
}

main();
