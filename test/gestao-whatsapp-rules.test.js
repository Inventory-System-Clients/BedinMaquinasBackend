import test from "node:test";
import assert from "node:assert/strict";
import {
  avisosPendentes,
  chaveAviso,
  classificarAviso,
  horaBrasil,
  montarMensagem,
  normalizarTelefone,
} from "../src/utils/gestaoWhatsappRules.js";

const HOJE = "2026-11-17";
const dest = { id: "d1", nome: "Maria Silva", avisarPagar: true, avisarReceber: false, avisoAntecipado: true, avisoNoDia: true };
const conta = (id, vencimento, extra = {}) => ({ id, tipo: "PAGAR", status: "PENDENTE", descricao: `Conta ${id}`, valor: 100, vencimento, ...extra });

test("normalizarTelefone aceita DDD+número e rejeita lixo", () => {
  assert.equal(normalizarTelefone("(11) 98765-4321"), "5511987654321");
  assert.equal(normalizarTelefone("+55 11 3456-7890"), "551134567890");
  assert.equal(normalizarTelefone("011987654321"), "5511987654321");
  assert.equal(normalizarTelefone("12345"), null);
});

test("classificarAviso: no dia, antecipado dentro da janela, nada fora dela", () => {
  assert.equal(classificarAviso(HOJE, HOJE, 3), "NO_DIA");
  assert.equal(classificarAviso("2026-11-20", HOJE, 3), "ANTECIPADO");
  assert.equal(classificarAviso("2026-11-21", HOJE, 3), null);
  assert.equal(classificarAviso("2026-11-16", HOJE, 3), null);
  assert.equal(classificarAviso("2026-11-18", HOJE, 0), null);
});

test("avisosPendentes respeita tipo de conta, preferências e o que já foi enviado", () => {
  const contas = [
    conta("a", HOJE),
    conta("b", "2026-11-19"),
    conta("c", "2026-11-19", { tipo: "RECEBER" }),
    conta("d", HOJE, { status: "QUITADA" }),
    conta("e", "2026-12-30"),
  ];
  assert.deepEqual(
    avisosPendentes({ contas, destinatario: dest, hoje: HOJE, diasAntes: 3 }).map((i) => [i.conta.id, i.tipoAviso]),
    [["a", "NO_DIA"], ["b", "ANTECIPADO"]]
  );
  const bloqueados = new Set([chaveAviso("a", "d1", "NO_DIA", HOJE)]);
  assert.deepEqual(avisosPendentes({ contas, destinatario: dest, bloqueados, hoje: HOJE, diasAntes: 3 }).map((i) => i.conta.id), ["b"]);
  const soNoDiaComReceber = { ...dest, avisoAntecipado: false, avisarReceber: true };
  assert.deepEqual(avisosPendentes({ contas, destinatario: soNoDiaComReceber, hoje: HOJE, diasAntes: 3 }).map((i) => i.conta.id), ["a"]);
});

test("montarMensagem agrupa hoje e próximos dias com valores e prazos", () => {
  const itens = [
    { conta: conta("a", HOJE, { descricao: "Aluguel", valor: 1200 }), tipoAviso: "NO_DIA" },
    { conta: conta("b", "2026-11-18", { descricao: "Energia", valor: 350.5, parcelaNumero: 2, parcelaTotal: 3 }), tipoAviso: "ANTECIPADO" },
  ];
  const msg = montarMensagem({ nome: "Maria Silva", itens, hoje: HOJE });
  assert.match(msg, /Olá, Maria!/);
  assert.match(msg, /Vence hoje \(17\/11\/2026\)/);
  assert.match(msg, /Aluguel — \*R\$\s1\.200,00\*/);
  assert.match(msg, /Energia \(2\/3\) — \*R\$\s350,50\* — vence 18\/11\/2026 \(amanhã\)/);
  assert.match(msg, /Total a pagar nestes avisos: \*R\$\s1\.550,50\*/);
});

test("horaBrasil usa o fuso de São Paulo", () => {
  assert.equal(horaBrasil(new Date("2026-11-17T11:30:00Z")), 8);
  assert.equal(horaBrasil(new Date("2026-11-17T03:00:00Z")), 0);
});
