import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agruparSoma,
  dividirParcelas,
  hojeBrasil,
  isDia,
  linhaDoTempo,
  mesesEntre,
  resumirContas,
  situacaoConta,
  somarMeses,
} from "../src/utils/gestaoContasRules.js";

test("dividirParcelas: centavos de diferença vão na última parcela", () => {
  const parcelas = dividirParcelas(100, 3, "2026-01-10");
  assert.deepEqual(parcelas.map((p) => p.valor), [33.33, 33.33, 33.34]);
  assert.deepEqual(parcelas.map((p) => p.vencimento), ["2026-01-10", "2026-02-10", "2026-03-10"]);
});

test("dividirParcelas: intervalo em dias (30/60/90)", () => {
  const parcelas = dividirParcelas(90, 3, "2026-01-01", 30);
  assert.deepEqual(parcelas.map((p) => p.vencimento), ["2026-01-01", "2026-01-31", "2026-03-02"]);
});

test("somarMeses: dia 31 cai no último dia do mês curto", () => {
  assert.equal(somarMeses("2026-01-31", 1), "2026-02-28");
  assert.equal(somarMeses("2026-01-31", 2), "2026-03-31");
  assert.equal(somarMeses("2026-11-15", 3), "2027-02-15");
  assert.equal(somarMeses("2026-03-10", -5), "2025-10-10");
});

test("situacaoConta: pendente com vencimento passado vira VENCIDA", () => {
  assert.equal(situacaoConta({ status: "PENDENTE", vencimento: "2026-01-09" }, "2026-01-10"), "VENCIDA");
  assert.equal(situacaoConta({ status: "PENDENTE", vencimento: "2026-01-10" }, "2026-01-10"), "PENDENTE");
  assert.equal(situacaoConta({ status: "QUITADA", vencimento: "2026-01-01" }, "2026-01-10"), "QUITADA");
});

test("resumirContas: em aberto inclui vencidas; quitado usa o valor efetivamente pago", () => {
  const resumo = resumirContas(
    [
      { status: "PENDENTE", valor: 100, vencimento: "2026-01-01" },
      { status: "PENDENTE", valor: 50, vencimento: "2026-02-01" },
      { status: "QUITADA", valor: 80, valorQuitado: 85.5, vencimento: "2026-01-01" },
      { status: "CANCELADA", valor: 999, vencimento: "2026-01-01" },
    ],
    "2026-01-15"
  );
  assert.deepEqual(resumo, {
    aberto: { total: 150, count: 2 },
    vencido: { total: 100, count: 1 },
    quitado: { total: 85.5, count: 1 },
  });
});

test("linhaDoTempo: saldo acumulado a partir do saldo inicial", () => {
  const linha = linhaDoTempo(
    [
      { data: "2026-01-02", entrada: false, valor: 30 },
      { data: "2026-01-01", entrada: true, valor: 100 },
      { data: "2026-01-02", entrada: true, valor: 10 },
    ],
    50
  );
  assert.deepEqual(linha, [
    { data: "2026-01-01", entradas: 100, saidas: 0, saldo: 150 },
    { data: "2026-01-02", entradas: 10, saidas: 30, saldo: 130 },
  ]);
});

test("agruparSoma e mesesEntre", () => {
  assert.deepEqual(
    agruparSoma([{ c: "A", v: 1 }, { c: "B", v: 5 }, { c: "A", v: 2 }, { c: null, v: 1 }], (r) => r.c, (r) => r.v),
    [{ nome: "B", total: 5 }, { nome: "A", total: 3 }, { nome: "Sem classificação", total: 1 }]
  );
  assert.deepEqual(mesesEntre("2025-11-20", "2026-02-01"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
});

test("isDia e hojeBrasil", () => {
  assert.equal(isDia("2026-02-30"), false);
  assert.equal(isDia("2026-02-28"), true);
  // 02:00 UTC ainda é o dia anterior em Brasília.
  assert.equal(hojeBrasil(new Date("2026-03-10T02:00:00Z")), "2026-03-09");
});
